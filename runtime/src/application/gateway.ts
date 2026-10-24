import {
  type Account,
  type ContactRegistration,
  ContactRegistrationSchema,
  GatewayIdentifierSchema,
  type GatewayOperations,
  materializedMessageMediaParts,
  type OperationResult,
  type OutboundMessage,
  OutboundMessageSchema,
} from "@digows/whatsapp-gateway-contracts";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { z } from "zod";
import type { WhatsAppConnection } from "../domain/connection.ts";
import { AccountOwnedError } from "../domain/errors.ts";
import { type AccountLease, type GatewayStore } from "../domain/gateway-store.ts";
import { defaultMaximumMediaBytes } from "../domain/media-bytes.ts";
import { decodeWhatsAppMediaSource } from "../domain/media-source.ts";
import type { IMediaRepository } from "../domain/media-storage.ts";
import { outboundPartCount } from "../domain/outbound-parts.ts";
import { SendOperation } from "../domain/send-operation.ts";
import { BaileysMediaRepository } from "../infrastructure/baileys/baileys-media-repository.ts";
import {
  BaileysTypingActivity,
  baileysTypingConfiguration,
} from "../infrastructure/baileys/baileys-typing-activity.ts";
export const GatewayConfigurationSchema = z.object({
  maximumMediaBytes: z.number().int().positive().max(256 * 1024 * 1024).default(defaultMaximumMediaBytes),
  mediaTimeoutMs: z.number().int().positive().max(60000).default(60000),
  minimumDelayMs: z.number().int().nonnegative().default(1500),
  maximumDelayMs: z.number().int().nonnegative().default(5000),
  dailyMaximum: z.number().int().positive().default(1500),
  sendTimeoutMs: z.number().int().positive().max(60000).default(10000),
  typingDelayMs: z.number().int().nonnegative().max(5000).default(400),
  sendRateLimit: z.number().int().positive().default(8),
  sendRatePeriodMs: z.number().int().positive().default(60000),
  firstDayLimit: z.number().int().positive().default(60),
  growthFactor: z.number().positive().default(1.6),
  warmUpDays: z.number().int().positive().default(7),
  inactivityMs: z.number().int().positive().default(168 * 3600000),
}).strict().refine(
  value => value.maximumDelayMs >= value.minimumDelayMs,
  "Maximum send delay is below minimum",
);
export type GatewayConfiguration = z.infer<typeof GatewayConfigurationSchema>;
export type GatewayConfigurationInput = z.input<typeof GatewayConfigurationSchema>;
export type GatewayConnectionFactory = (account: Account, lease: AccountLease) => WhatsAppConnection;
class HostedAccount
{
  private queue: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly activities = new Map<string, BaileysTypingActivity>();
  private closing: Promise<void> | undefined;
  private quarantined = false;
  constructor(
    readonly lease: AccountLease,
    readonly connection: WhatsAppConnection,
    private readonly store: GatewayStore,
    private readonly configuration: GatewayConfiguration,
  )
  {}
  async start(): Promise<void>
  {
    this.lease.onLost = () =>
    {
      pino().warn({ event: "gateway_account_ownership_lost", accountId: this.lease.accountId });
      void this.close().catch(() =>
      {
        pino().error({ event: "gateway_account_cleanup_failed", accountId: this.lease.accountId });
      });
    };
    await this.connection.start(await this.store.account(this.lease.accountId), {
      state: (state, jid, qr) => this.store.setState(this.lease, state, jid, qr),
      receipt: observation => this.store.recordReceipt(this.lease, observation),
      rejected: async (native, errorName) =>
      {
        await this.store.retainFailure(this.lease, native, errorName);
        pino().warn({
          event: "gateway_message_normalization_failed",
          accountId: this.lease.accountId,
          errorName,
        });
      },
      received: async (message, native) =>
      {
        if (!this.lease.alive || this.controller.signal.aborted) throw new Error("Account ownership lost");
        if (await this.store.hasSent(this.lease.accountId, message.channelMessageId)) return;
        await this.store.retain(this.lease, message, native);
        if (message.senderAddress === message.receivingAddress)
        {
          await this.activities.get(message.chatAddress)?.stop();
        }
        else if (
          message.contentKind === "TEXT" && !message.chatAddress.endsWith("@g.us")
          && this.activities.size < 32
        )
        {
          const typing = await this.typing(message.chatAddress);
          await typing.start(30000);
          void typing.heartbeat();
        }
      },
    });
  }
  run<Result>(work: () => Promise<Result>): Promise<Result>
  {
    const result = this.queue.then(() =>
    {
      if (this.controller.signal.aborted || !this.lease.alive) throw new Error("Account ownership lost");
      return work();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async typing(chat: string): Promise<BaileysTypingActivity>
  {
    const previous = this.activities.get(chat);
    if (previous) await previous.stop();
    if (this.activities.size >= 32)
    {
      const oldest = this.activities.values().next().value;
      if (oldest) await oldest.stop();
    }
    const activity: BaileysTypingActivity = new BaileysTypingActivity(
      { sendPresenceUpdate: async (state) => this.connection.presence(chat, state === "composing") },
      chat,
      {
        ...baileysTypingConfiguration,
        minimumDelayMs: this.configuration.typingDelayMs,
        maximumDelayMs: this.configuration.typingDelayMs,
      },
      pino({ level: "silent" }),
      () =>
      {
        if (this.activities.get(chat) === activity) this.activities.delete(chat);
      },
      () =>
      {
        const current = this.activities.get(chat);
        return (current === undefined || current === activity) && this.lease.alive;
      },
    );
    this.activities.set(chat, activity);
    return activity;
  }
  async presence(chat: string, composing: boolean): Promise<void>
  {
    if (this.controller.signal.aborted || !this.lease.alive || this.quarantined)
    {
      throw new Error("Account ownership unavailable");
    }
    if (composing)
    {
      const activity = await this.typing(chat);
      await activity.start(30000);
      void activity.heartbeat();
    }
    else
    {
      const activity = this.activities.get(chat);
      if (activity) await activity.stop();
      else await this.connection.presence(chat, false);
    }
  }
  async send(input: OutboundMessage): Promise<OperationResult>
  {
    return this.run(async () =>
    {
      const operation = await this.store.reserve(this.lease, input, outboundPartCount(input));
      if (!operation.is("PENDING")) return operation.snapshot();
      if (this.quarantined) throw new Error("Account recovery required after UNKNOWN");
      const account = await this.store.account(this.lease.accountId);
      if (account.state !== "CONNECTED") throw new Error("Account is not connected");
      if (account.nativeJid !== input.senderAddress)
      {
        throw new Error("Sending account identity does not match");
      }
      for (let index = operation.acceptedParts; index < operation.nativeIds.length; index++)
      {
        const id = operation.nativeIds[index];
        const parent = operation.nativeIds[0];
        if (!id || !parent) throw new Error("Reserved send ID unavailable");
        let prepared: Awaited<ReturnType<WhatsAppConnection["prepare"]>>;
        try
        {
          prepared = await this.connection.prepare({ ...input, idempotencyKey: parent }, index, id);
        }
        catch (error)
        {
          if (this.lease.alive && !this.controller.signal.aborted)
          {
            operation.failPreparation();
            await this.store.save(this.lease, operation);
          }
          throw error;
        }
        await delay(await this.store.pace(this.lease, this.configuration), undefined, {
          signal: this.controller.signal,
        });
        const typing = await this.typing(prepared.recipientAddress);
        await typing.start(this.configuration.sendTimeoutMs);
        try
        {
          await typing.waitBeforeSend();
          if (this.controller.signal.aborted) throw new Error("Account is stopping");
          operation.dispatch(index);
          await this.store.save(this.lease, operation);
          try
          {
            await bounded(
              this.connection.send(prepared),
              this.configuration.sendTimeoutMs,
            );
            const accepted = SendOperation.restore(operation.snapshot());
            accepted.accept(index);
            await this.store.save(this.lease, accepted);
            operation.accept(index);
          }
          catch (error)
          {
            if (operation.is("IN_FLIGHT"))
            {
              operation.unknown();
              this.quarantined = true;
              pino().warn({
                event: "gateway_send_unknown",
                accountId: this.lease.accountId,
                operationKeyDigest: createHash("sha256").update(operation.key).digest("hex"),
              });
              try
              {
                if (this.lease.alive) await this.store.save(this.lease, operation);
              }
              finally
              {
                await this.connection.stop();
                if (this.lease.alive) await this.store.setState(this.lease, "FAILED");
              }
            }
            throw error;
          }
        }
        catch (error)
        {
          if (!operation.is("UNKNOWN")) throw error;
        }
        finally
        {
          await typing.stop();
        }
        if (operation.is("UNKNOWN")) break;
      }
      return operation.snapshot();
    });
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      this.controller.abort();
      await Promise.allSettled([...this.activities.values()].map(activity => activity.stop()));
      try
      {
        await this.connection.stop();
        await this.queue;
        if (this.lease.alive) await this.store.setState(this.lease, "STOPPED");
      }
      finally
      {
        await this.lease.release();
      }
    })();
    return this.closing;
  }
}
export class Gateway implements GatewayOperations
{
  private readonly accounts = new Map<string, Promise<HostedAccount>>();
  private closed = false;
  private readonly configuration: GatewayConfiguration;
  constructor(
    private readonly store: GatewayStore,
    private readonly factory: GatewayConnectionFactory,
    configuration: GatewayConfigurationInput = {},
    private readonly media?: IMediaRepository,
  )
  {
    this.configuration = GatewayConfigurationSchema.parse(configuration);
  }
  async start(requestedAccountId: string): Promise<void>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    if (this.closed) throw new Error("Gateway is closed");
    let pending = this.accounts.get(accountId);
    if (!pending)
    {
      pending = (async () =>
      {
        const lease = await this.store.acquire(accountId);
        let hosted: HostedAccount | undefined;
        try
        {
          hosted = new HostedAccount(
            lease,
            this.factory(await this.store.account(accountId), lease),
            this.store,
            this.configuration,
          );
          await hosted.start();
          return hosted;
        }
        catch (error)
        {
          if (hosted) await hosted.close();
          else await lease.release();
          throw error;
        }
      })();
      this.accounts.set(accountId, pending);
    }
    try
    {
      await pending;
    }
    catch (error)
    {
      if (this.accounts.get(accountId) === pending) this.accounts.delete(accountId);
      throw error;
    }
  }
  async restore(): Promise<void>
  {
    for (const account of await this.store.accounts())
    {
      const serialized = await this.store.readAuthentication(account.accountId, "credentials", "default");
      const value: unknown = serialized === null ? null : JSON.parse(serialized);
      if (typeof value !== "object" || value === null || !("me" in value) || !value.me) continue;
      try
      {
        await this.start(account.accountId);
      }
      catch (error)
      {
        if (!(error instanceof AccountOwnedError)) throw error;
      }
    }
  }
  async restart(requestedAccountId: string): Promise<void>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    await this.stop(accountId);
    await this.start(accountId);
  }
  private async hosted(requestedAccountId: string): Promise<HostedAccount>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const pending = this.accounts.get(accountId);
    if (!pending) throw new Error("Account is not owned here");
    return pending;
  }
  async ownership(requestedAccountId: string): Promise<AccountLease>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return (await this.hosted(accountId)).lease;
  }
  async send(requestedAccountId: string, input: OutboundMessage): Promise<OperationResult>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const message = OutboundMessageSchema.parse(input);
    for (const part of materializedMessageMediaParts(message))
    {
      if (!part.media.storageKey.startsWith(`media/whatsapp/${this.store.workspaceId}/${accountId}/`))
      {
        throw new Error("Outbound media scope mismatch");
      }
    }
    return (await this.hosted(accountId)).send(message);
  }
  async lookupContactAddress(requestedAccountId: string, address: string): Promise<ContactRegistration>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const hosted = await this.hosted(accountId);
    const result = ContactRegistrationSchema.parse(await hosted.connection.lookupContactAddress(address));
    if (result.workspaceId !== this.store.workspaceId || result.accountId !== accountId)
    {
      throw new Error("Contact lookup result scope mismatch");
    }
    return result;
  }
  async operation(requestedAccountId: string, key: string): Promise<OperationResult>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.store.operation(accountId, key);
  }
  async presence(requestedAccountId: string, chat: string, composing: boolean): Promise<void>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const hosted = await this.hosted(accountId);
    if (!hosted.lease.alive) throw new Error("Account ownership lost");
    await hosted.presence(chat, composing);
  }
  async readMedia(requestedAccountId: string, sourceId: string): Promise<Uint8Array>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const identity = decodeWhatsAppMediaSource(sourceId);
    if (identity.accountId !== accountId || identity.workspaceId !== this.store.workspaceId)
    {
      throw new Error("Media scope mismatch");
    }
    const repository = new BaileysMediaRepository(
      this.media,
      this.configuration.maximumMediaBytes,
      this.configuration.mediaTimeoutMs,
    );
    if (!this.media) return repository.read(identity, await this.store.native(accountId, identity.messageId));
    const media = this.media;
    const cached = await this.store.materialized(accountId, sourceId);
    if (cached)
    {
      if (cached.byteSize > this.configuration.maximumMediaBytes)
      {
        throw new Error("Media exceeds configured byte limit");
      }
      return media.read(cached, this.configuration.maximumMediaBytes);
    }
    const native = await this.store.native(accountId, identity.messageId);
    const reference = await this.store.materialize(
      accountId,
      sourceId,
      async () => repository.materialize(identity, native),
    );
    return media.read(reference, this.configuration.maximumMediaBytes);
  }
  async stop(requestedAccountId: string): Promise<void>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const pending = this.accounts.get(accountId);
    if (!pending) return;
    try
    {
      await (await pending).close();
    }
    finally
    {
      if (this.accounts.get(accountId) === pending) this.accounts.delete(accountId);
    }
  }
  async close(): Promise<void>
  {
    this.closed = true;
    const results = await Promise.allSettled([...this.accounts.keys()].map(id => this.stop(id)));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures, "Gateway shutdown failed");
  }
}
async function bounded<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value>
{
  let timer: ReturnType<typeof setTimeout> | undefined;
  try
  {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) =>
      {
        timer = setTimeout(() => reject(new Error("WhatsApp send outcome UNKNOWN")), timeoutMs);
      }),
    ]);
  }
  finally
  {
    clearTimeout(timer);
  }
}
