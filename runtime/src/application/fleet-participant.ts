import { type DesiredAccount, DesiredAccountRequestSchema } from "@digows/whatsapp-gateway-contracts";
import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { z } from "zod";
import type { GatewayPrincipal } from "../domain/authorization.ts";
import { AccountOwnedError, UnpairedAccountRecoveryError } from "../domain/errors.ts";
import type { GatewayFleetStore } from "../domain/fleet-store.ts";
import type { AccountLease } from "../domain/gateway-store.ts";
import { GatewayCommandWorker } from "./command-ingress.ts";
import type { Gateway } from "./gateway.ts";
export const FleetConfigurationSchema = z.strictObject({
  capacity: z.number().int().positive().max(10000).default(100),
  reconcileIntervalMs: z.number().int().positive().max(60000).default(1000),
  membershipLifetimeMs: z.number().int().min(300).max(300000).default(15000),
}).refine(
  value => value.membershipLifetimeMs >= value.reconcileIntervalMs * 3,
  "Membership lifetime must cover three reconciliation intervals",
);
export type FleetConfiguration = z.infer<typeof FleetConfigurationSchema>;
export type FleetConfigurationInput = z.input<typeof FleetConfigurationSchema>;
interface HostedFleetAccount
{
  readonly lease: AccountLease;
  readonly revision: number;
}
export class GatewayFleetParticipant
{
  readonly runtimeId = randomUUID();
  private readonly configuration: FleetConfiguration;
  private readonly hosted = new Map<string, HostedFleetAccount>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly recover = new Set<string>();
  private readonly worker: GatewayCommandWorker;
  private starting: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  private heartbeating: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly store: GatewayFleetStore,
    private readonly gateway: Gateway,
    configuration: FleetConfigurationInput = {},
    private readonly logger: Logger = pino(),
  )
  {
    this.configuration = FleetConfigurationSchema.parse(configuration);
    this.worker = new GatewayCommandWorker(store.commands, gateway);
  }
  async setDesired(principal: GatewayPrincipal, input: unknown): Promise<DesiredAccount>
  {
    const request = DesiredAccountRequestSchema.parse(input);
    principal.authorize(request);
    if (request.workspaceId !== this.store.workspaceId) throw new Error("Desired account workspace mismatch");
    if (this.closing) throw new Error("Fleet participant is closed");
    return this.store.setDesired(request);
  }
  async start(): Promise<void>
  {
    if (this.closing) throw new Error("Fleet participant is closed");
    this.starting ??= (async () =>
    {
      await this.tick();
      if (this.closing) return;
      this.heartbeatTimer = setInterval(() =>
      {
        if (this.closing) return;
        void this.heartbeat().catch(() =>
          this.logger.error({
            event: "gateway_runtime_heartbeat_failed",
            runtimeId: this.runtimeId,
            workspaceId: this.store.workspaceId,
          })
        );
      }, Math.floor(this.configuration.membershipLifetimeMs / 3));
      this.reconcileTimer = setInterval(() =>
      {
        void this.tick().catch(() =>
          this.logger.error({
            event: "gateway_runtime_reconciliation_failed",
            runtimeId: this.runtimeId,
            workspaceId: this.store.workspaceId,
          })
        );
      }, this.configuration.reconcileIntervalMs);
    })();
    await this.starting;
  }
  private async heartbeat(): Promise<void>
  {
    this.heartbeating ??= this.store.heartbeat(
      this.runtimeId,
      this.configuration.capacity,
      false,
      this.configuration.membershipLifetimeMs,
    );
    const pending = this.heartbeating;
    try
    {
      await pending;
    }
    finally
    {
      if (this.heartbeating === pending) this.heartbeating = undefined;
    }
  }
  async tick(): Promise<void>
  {
    if (this.closing) return;
    this.ticking ??= this.reconcile();
    const pending = this.ticking;
    try
    {
      await pending;
    }
    finally
    {
      if (this.ticking === pending) this.ticking = undefined;
    }
  }
  private async reconcile(): Promise<void>
  {
    await this.heartbeat();
    await this.store.coordinate();
    const assignments = new Map(
      (await this.store.assignments()).map(account => [account.accountId, account]),
    );
    for (const [accountId, hosted] of this.hosted)
    {
      const desired = assignments.get(accountId);
      const state = (await this.store.account(accountId)).state;
      const failed = state === "FAILED" || state === "LOGGED_OUT";
      if (
        !hosted.lease.alive || !desired?.enabled || desired.assignedRuntimeId !== this.runtimeId
        || desired.revision !== hosted.revision || failed || this.recover.has(accountId)
      )
      {
        if (failed) await this.store.block(accountId, this.runtimeId, hosted.revision);
        try
        {
          await this.gateway.stop(accountId);
          await this.workers.get(accountId);
        }
        finally
        {
          this.hosted.delete(accountId);
          this.recover.delete(accountId);
        }
      }
    }
    if (this.closing) return;
    for (const desired of assignments.values())
    {
      if (
        !desired.enabled || desired.assignedRuntimeId !== this.runtimeId
        || desired.blockedRevision === desired.revision
      ) continue;
      let hosted = this.hosted.get(desired.accountId);
      if (!hosted)
      {
        try
        {
          await this.gateway.start(desired.accountId, lease =>
            this.store.claimAssignment(lease, this.runtimeId, desired.revision));
          hosted = { lease: await this.gateway.ownership(desired.accountId), revision: desired.revision };
          this.hosted.set(desired.accountId, hosted);
        }
        catch (error)
        {
          if (error instanceof AccountOwnedError)
          {
            continue;
          }
          await this.store.block(desired.accountId, this.runtimeId, desired.revision);
          if (error instanceof UnpairedAccountRecoveryError)
          {
            this.logger.warn({
              event: "gateway_runtime_pairing_revision_required",
              runtimeId: this.runtimeId,
              workspaceId: this.store.workspaceId,
              accountId: desired.accountId,
              revision: desired.revision,
            });
            continue;
          }
          this.logger.error({
            event: "gateway_runtime_account_start_failed",
            runtimeId: this.runtimeId,
            workspaceId: this.store.workspaceId,
            accountId: desired.accountId,
            revision: desired.revision,
            errorName: error instanceof Error ? error.name : "Error",
          });
          continue;
        }
      }
      if (!this.workers.has(desired.accountId) && !this.closing)
      {
        const current = hosted;
        const pending = this.processCommands(desired.accountId, current).catch(() =>
        {
          if (this.closing || !current.lease.alive)
          {
            this.logger.debug({
              event: "gateway_runtime_command_worker_stopped",
              runtimeId: this.runtimeId,
              workspaceId: this.store.workspaceId,
              accountId: desired.accountId,
            });
            return;
          }
          this.recover.add(desired.accountId);
          this.logger.error({
            event: "gateway_runtime_command_worker_failed",
            runtimeId: this.runtimeId,
            workspaceId: this.store.workspaceId,
            accountId: desired.accountId,
          });
        });
        this.workers.set(desired.accountId, pending);
        void pending.finally(() =>
        {
          if (this.workers.get(desired.accountId) === pending)
          {
            this.workers.delete(desired.accountId);
          }
        });
      }
    }
  }
  private async processCommands(accountId: string, hosted: HostedFleetAccount): Promise<void>
  {
    while (!this.closing && this.hosted.get(accountId) === hosted && hosted.lease.alive)
    {
      if (!await this.store.canWork(hosted.lease, this.runtimeId, hosted.revision)) return;
      if (!await this.worker.runOne(hosted.lease)) return;
    }
  }
  async drainCommands(): Promise<void>
  {
    await Promise.all([...this.workers.values()]);
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      clearInterval(this.heartbeatTimer);
      clearInterval(this.reconcileTimer);
      await this.ticking?.catch(() => undefined);
      await this.heartbeating?.catch(() => undefined);
      const failures: unknown[] = [];
      try
      {
        await this.store.heartbeat(
          this.runtimeId,
          this.configuration.capacity,
          true,
          this.configuration.membershipLifetimeMs,
        );
      }
      catch (error)
      {
        failures.push(error);
      }
      try
      {
        await this.gateway.close();
        await this.drainCommands();
      }
      catch (error)
      {
        failures.push(error);
      }
      finally
      {
        await this.store.leave(this.runtimeId).catch(error => failures.push(error));
        this.hosted.clear();
      }
      if (failures.length) throw new AggregateError(failures, "Fleet participant shutdown failed");
    })();
    await this.closing;
  }
}
