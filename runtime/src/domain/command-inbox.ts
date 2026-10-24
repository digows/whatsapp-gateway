import type {
  GatewayCommand,
  GatewayCommandFailure,
  GatewayCommandResponse,
  GatewayCommandResult,
} from "@digows/whatsapp-gateway-contracts";
import type { AccountLease } from "./gateway-store.ts";
export interface ClaimedGatewayCommand
{
  readonly command: GatewayCommand;
  readonly token: string;
  readonly generation: number;
}
export interface GatewayCommandInbox
{
  readonly workspaceId: string;
  submit(command: GatewayCommand): Promise<GatewayCommandResult>;
  result(accountId: string, requestId: string): Promise<GatewayCommandResult>;
  claim(lease: AccountLease): Promise<ClaimedGatewayCommand | null>;
  complete(
    lease: AccountLease,
    claim: ClaimedGatewayCommand,
    response: GatewayCommandResponse,
  ): Promise<void>;
  fail(lease: AccountLease, claim: ClaimedGatewayCommand, failure: GatewayCommandFailure): Promise<void>;
}
