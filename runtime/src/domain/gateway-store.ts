import type {
  Account,
  DeliveryObservation,
  InboundMessage,
  MediaReference,
  OperationResult,
  OutboundMessage,
  SessionState,
} from "@digows/whatsapp-gateway-contracts";
import type { AcceptedOutboundPart } from "./accepted-outbound-part.ts";
import type { PacingPolicy } from "./pacing.ts";
import type { SendOperation } from "./send-operation.ts";
export interface AuthenticationMutation
{
  readonly category: string;
  readonly keyId: string;
  readonly serializedValue: string | null;
}
export type ReleaseAccountLease = () => Promise<void>;
export class AccountLease
{
  private currentAlive = true;
  get alive(): boolean
  {
    return this.currentAlive;
  }
  onLost: (() => void) | undefined;
  private releasing: Promise<void> | undefined;
  constructor(
    readonly workspaceId: string,
    readonly accountId: string,
    readonly generation: number,
    private readonly releaseResource: ReleaseAccountLease,
  )
  {}
  lose(): void
  {
    if (!this.alive) return;
    this.currentAlive = false;
    this.onLost?.();
  }
  async release(): Promise<void>
  {
    this.currentAlive = false;
    this.releasing ??= this.releaseResource();
    await this.releasing;
  }
}
export interface GatewayStore
{
  readonly workspaceId: string;
  createAccount(accountId?: string): Promise<Account>;
  account(accountId: string): Promise<Account>;
  accounts(): Promise<readonly Account[]>;
  acquire(accountId: string): Promise<AccountLease>;
  setState(lease: AccountLease, state: SessionState, nativeJid?: string, qr?: string): Promise<void>;
  reserve(lease: AccountLease, message: OutboundMessage, count: number): Promise<SendOperation>;
  save(lease: AccountLease, operation: SendOperation, acceptedPart?: AcceptedOutboundPart): Promise<void>;
  operation(accountId: string, key: string): Promise<OperationResult>;
  readAuthentication(accountId: string, category: string, keyId: string): Promise<string | null>;
  writeAuthentication(lease: AccountLease, mutations: readonly AuthenticationMutation[]): Promise<void>;
  clearAuthentication(lease: AccountLease): Promise<void>;
  recordReceipt(lease: AccountLease, observation: DeliveryObservation): Promise<void>;
  receipts(accountId: string, messageId: string): Promise<readonly DeliveryObservation[]>;
  retain(lease: AccountLease, message: InboundMessage, native: string): Promise<void>;
  retainFailure(lease: AccountLease, native: string, errorName: string): Promise<void>;
  native(accountId: string, messageId: string, nativeChatId?: string): Promise<string>;
  hasSent(accountId: string, messageId: string): Promise<boolean>;
  materialized(accountId: string, sourceId: string): Promise<MediaReference | null>;
  materialize(
    accountId: string,
    sourceId: string,
    work: () => Promise<MediaReference>,
  ): Promise<MediaReference>;
  pace(lease: AccountLease, policy: PacingPolicy): Promise<number>;
}
