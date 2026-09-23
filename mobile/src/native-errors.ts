export const nativeErrorCodes = [
  "ERR_CIRCLE_SYNC_BUSY",
  "ERR_MLS_ALREADY_PROCESSED",
  "ERR_MLS_OWN_MESSAGE",
  "ERR_MLS_STALE_EPOCH",
  "ERR_MLS_UNAUTHORIZED_COMMIT",
  "ERR_MLS_INVALID_CONTROL",
] as const;

export type NativeErrorCode = (typeof nativeErrorCodes)[number];

const legacyCodes: Record<string, NativeErrorCode> = {
  AlreadyProcessed: "ERR_MLS_ALREADY_PROCESSED",
  OwnMessage: "ERR_MLS_OWN_MESSAGE",
  StaleEpoch: "ERR_MLS_STALE_EPOCH",
};

/** Read stable bridge codes. The message fallback supports older native builds. */
export function nativeErrorCode(error: unknown): NativeErrorCode | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const fields =
      typeof current === "object" ? (current as Record<string, unknown>) : {};
    if (nativeErrorCodes.includes(fields.code as NativeErrorCode))
      return fields.code as NativeErrorCode;
    // Do not override a deliberate error classification with words in its message.
    if (fields.code && fields.code !== "ERR_UNEXPECTED") return undefined;
    const message = typeof current === "string" ? current : fields.message;
    if (typeof message === "string") {
      const match = /CryptoCoreException\$(AlreadyProcessed|OwnMessage|StaleEpoch):/.exec(
        message,
      );
      if (match) return legacyCodes[match[1]];
      if (
        /(?:^|java\.lang\.IllegalStateException: )(?:Error: )?Circle sync is busy(?:; try again shortly)?$/.test(
          message,
        )
      )
        return "ERR_CIRCLE_SYNC_BUSY";
    }
    current = fields.cause;
  }
  return undefined;
}

export function isExpectedMlsEcho(error: unknown): boolean {
  const code = nativeErrorCode(error);
  return code === "ERR_MLS_ALREADY_PROCESSED" || code === "ERR_MLS_OWN_MESSAGE";
}
