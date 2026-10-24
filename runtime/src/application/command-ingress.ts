import {
  type GatewayCommandResponse,
  type GatewayCommandResult,
  GatewayCommandSchema,
  type GatewayOperations,
  GatewayRequestIdentitySchema,
} from "@digows/whatsapp-gateway-contracts";
import type { GatewayPrincipal } from "../domain/authorization.ts";
import type { GatewayCommandInbox } from "../domain/command-inbox.ts";
import type { AccountLease } from "../domain/gateway-store.ts";

export class GatewayCommandIngress
{
  constructor(private readonly inbox: GatewayCommandInbox)
  {}
  async submit(principal: GatewayPrincipal, input: unknown): Promise<GatewayCommandResult>
  {
    const command = GatewayCommandSchema.parse(input);
    principal.authorize(command);
    if (command.workspaceId !== this.inbox.workspaceId) throw new Error("Command workspace mismatch");
    return this.inbox.submit(command);
  }
  async result(principal: GatewayPrincipal, input: unknown): Promise<GatewayCommandResult>
  {
    const identity = GatewayRequestIdentitySchema.parse(input);
    principal.authorize(identity);
    if (identity.workspaceId !== this.inbox.workspaceId) throw new Error("Command workspace mismatch");
    return this.inbox.result(identity.accountId, identity.requestId);
  }
}
export class GatewayCommandWorker
{
  constructor(private readonly inbox: GatewayCommandInbox, private readonly gateway: GatewayOperations)
  {}
  async runOne(lease: AccountLease): Promise<boolean>
  {
    const claim = await this.inbox.claim(lease);
    if (!claim) return false;
    const command = claim.command;
    const identity = {
      apiVersion: command.apiVersion,
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      requestId: command.requestId,
    };
    let response: GatewayCommandResponse;
    try
    {
      switch (command.type)
      {
        case "send":
          response = {
            ...identity,
            type: command.type,
            result: await this.gateway.send(command.accountId, command.message),
          };
          break;
        case "presence":
          await this.gateway.presence(command.accountId, command.chatAddress, command.composing);
          response = { ...identity, type: command.type };
          break;
        case "contact.lookup":
          response = {
            ...identity,
            type: command.type,
            result: await this.gateway.lookupContactAddress(command.accountId, command.address),
          };
          break;
      }
    }
    catch
    {
      // Lost ownership leaves the claim recoverable. A live owner's execution failure is terminal.
      await this.inbox.fail(lease, claim, "EXECUTION_FAILED");
      return true;
    }
    // Do not convert a failed persistence step after a native effect into an execution failure.
    await this.inbox.complete(lease, claim, response);
    return true;
  }
}
