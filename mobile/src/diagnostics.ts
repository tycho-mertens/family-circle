import { nativeErrorCodes } from "./native-errors";

const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
]);
const errorCodes = new Set([
  ...nativeErrorCodes,
  "RELAY_HTTP",
  "RELAY_THROTTLED",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOSPC",
  "EACCES",
  "EPERM",
]);

// Only known classifications and numeric HTTP statuses may reach device logs.
// Error messages, stacks, arbitrary codes, and server bodies may contain secrets.
function failureDetails(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object") return typeof error;
  const fields = error as Record<string, unknown>;
  const details = [
    typeof fields.name === "string" && errorNames.has(fields.name)
      ? fields.name
      : "Error",
  ];
  if (typeof fields.code === "string" && errorCodes.has(fields.code))
    details.push(`code=${fields.code}`);
  if (
    typeof fields.status === "number" &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599
  )
    details.push(`status=${fields.status}`);
  if (typeof fields.retryable === "boolean")
    details.push(`retryable=${fields.retryable}`);
  if (fields.cause && depth < 2)
    details.push(`cause=[${failureDetails(fields.cause, depth + 1)}]`);
  return details.join(" ");
}

// Retry loops report once per operation per minute, including the number of
// suppressed failures. A changed cause is reported immediately.
export function createRuntimeDiagnostics(
  warn: (message: string) => void = console.warn,
  now: () => number = Date.now,
) {
  const failures = new Map<string, { at: number; details: string; suppressed: number }>();
  return (operation: string, error: unknown) => {
    const time = now();
    const details = failureDetails(error);
    const previous = failures.get(operation);
    if (
      previous &&
      previous.details === details &&
      time >= previous.at &&
      time - previous.at < 60_000
    ) {
      previous.suppressed++;
      return;
    }
    const repeated = previous?.suppressed
      ? `; ${previous.suppressed} repeated failures suppressed`
      : "";
    failures.set(operation, { at: time, details, suppressed: 0 });
    warn(`[Circle runtime] ${operation} failed (${details}${repeated}).`);
  };
}
