import { nativeErrorCode } from "../native-errors";

type RejectionCode = "ERR_MLS_UNAUTHORIZED_COMMIT" | "ERR_MLS_INVALID_CONTROL";

// Created only at the native commit boundary. The sync loop must not treat a
// matching code from storage or subsequent handler work as rejected input.
export class RejectedCommit extends Error {
  constructor(readonly code: RejectionCode) {
    super("Incoming membership commit rejected");
  }
}

export function rejectedCommit(error: unknown): RejectedCommit | undefined {
  const code = nativeErrorCode(error);
  if (code === "ERR_MLS_UNAUTHORIZED_COMMIT" || code === "ERR_MLS_INVALID_CONTROL")
    return new RejectedCommit(code);
  return undefined;
}
