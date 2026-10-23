export interface WhatsAppErrorDetails
{
  readonly errorName: string;
  readonly errorCode?: string;
  readonly disconnectCode?: number;
}

/** Error messages and protocol payloads can contain credentials or message text. */
export function describeWhatsAppError(error: unknown): WhatsAppErrorDetails
{
  const knownNames = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ZodError",
    "DatabaseError",
    "AggregateError",
    "WhatsAppSessionError",
    "WhatsAppSenderUnresolvedError",
    "WhatsAppSenderUnregisteredError",
    "WhatsAppRecipientUnregisteredError",
    "WhatsAppRecoveryExhaustedError",
  ]);
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const output = typeof error === "object" && error !== null && "output" in error ? error.output : undefined;
  return {
    errorName: error instanceof Error && knownNames.has(error.name) ? error.name : "UnknownError",
    ...(typeof code === "string"
        && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)$/u.test(code)
      ? { errorCode: code }
      : {}),
    ...(typeof output === "object" && output !== null && "statusCode" in output
        && typeof output.statusCode === "number"
      ? { disconnectCode: output.statusCode }
      : {}),
  };
}
