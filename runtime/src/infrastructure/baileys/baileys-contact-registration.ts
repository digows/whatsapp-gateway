import type {
  AccountScope,
  ContactRegistration,
  ContactRegistrationReason,
} from "@digows/whatsapp-gateway-contracts";
import { jidDecode, jidNormalizedUser, USyncQuery, USyncUser, type WASocket } from "baileys";
import { BaileysOperationTimeoutError, withBaileysTimeout } from "./baileys-socket-lifecycle.ts";
export type CurrentContactSession = () => boolean;
export async function lookupNativeContact(
  socket: WASocket,
  scope: AccountScope,
  address: string,
  signal: AbortSignal,
  isCurrent: CurrentContactSession,
  timeoutMs: number,
): Promise<ContactRegistration>
{
  const identity = { workspaceId: scope.workspaceId, accountId: scope.accountId, address };
  const indeterminate = (reason: ContactRegistrationReason): ContactRegistration => ({
    ...identity,
    status: "INDETERMINATE",
    reason,
  });
  let phone = address;
  const decoded = jidDecode(address);
  if (decoded?.server === "s.whatsapp.net") phone = "+" + decoded.user;
  if (!/^\+[1-9][0-9]{1,14}$/u.test(phone)) return indeterminate("UNSUPPORTED_ADDRESS");
  if (!isCurrent() || signal.aborted) return indeterminate("OWNERSHIP_CHANGED");
  const query = new USyncQuery().withContactProtocol().withUser(new USyncUser().withPhone(phone));
  const contact = query.protocols.find(protocol => protocol.name === "contact");
  if (!contact) throw new Error("Pinned Baileys contact protocol is unavailable");
  const parseContact = contact.parser;
  contact.parser = node =>
  {
    const parsed = parseContact(node); // Retain native error-node validation.
    return node.attrs.type === "in" || node.attrs.type === "out" ? parsed : undefined;
  };
  try
  {
    // onWhatsApp filters false results; the lower-level query preserves explicit negatives.
    const response = await withBaileysTimeout(
      socket.executeUSyncQuery(query),
      timeoutMs,
      "contact registration",
      signal,
    );
    if (!isCurrent()) return indeterminate("OWNERSHIP_CHANGED");
    if (!response || response.list.length !== 1) return indeterminate("INCOMPLETE_RESPONSE");
    const result = response.list[0];
    if (result?.["contact"] === false)
    {
      const negative = jidDecode(result.id);
      if (negative?.server !== "s.whatsapp.net" || negative.user !== phone.slice(1))
      {
        return indeterminate("INCOMPLETE_RESPONSE");
      }
      return { ...identity, status: "UNREGISTERED" };
    }
    if (result?.["contact"] !== true) return indeterminate("INCOMPLETE_RESPONSE");
    const target = jidDecode(result.id);
    if (!target || (target.server !== "s.whatsapp.net" && target.server !== "lid"))
    {
      return indeterminate("INCOMPLETE_RESPONSE");
    }
    return { ...identity, status: "REGISTERED", resolvedAddress: jidNormalizedUser(result.id) };
  }
  catch (error)
  {
    if (!isCurrent() || signal.aborted) return indeterminate("OWNERSHIP_CHANGED");
    return indeterminate(error instanceof BaileysOperationTimeoutError ? "TIMEOUT" : "UNAVAILABLE");
  }
}
