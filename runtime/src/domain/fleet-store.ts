import type { Account, DesiredAccount, DesiredAccountRequest } from "@digows/whatsapp-gateway-contracts";
import type { GatewayCommandInbox } from "./command-inbox.ts";
import type { AccountLease } from "./gateway-store.ts";
export interface GatewayFleetStore
{
  readonly workspaceId: string;
  readonly commands: GatewayCommandInbox;
  account(accountId: string): Promise<Account>;
  setDesired(request: DesiredAccountRequest): Promise<DesiredAccount>;
  desired(accountId: string): Promise<DesiredAccount>;
  assignments(): Promise<readonly DesiredAccount[]>;
  heartbeat(runtimeId: string, capacity: number, draining: boolean, lifetimeMs: number): Promise<void>;
  leave(runtimeId: string): Promise<void>;
  coordinate(): Promise<boolean>;
  claimAssignment(lease: AccountLease, runtimeId: string, revision: number): Promise<void>;
  block(accountId: string, runtimeId: string, revision: number): Promise<void>;
  canWork(lease: AccountLease, runtimeId: string, revision: number): Promise<boolean>;
}
