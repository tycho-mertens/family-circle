/** Only authenticated sender metadata establishes their expected cadence. */
export function possiblyOffline(
  fix: { updateInterval?: number; updatedAt?: number } | null,
  now: number,
): boolean {
  if (
    !fix ||
    ![60000, 120000, 300000, 900000, 1800000].includes(fix.updateInterval ?? 0) ||
    !Number.isFinite(fix.updatedAt)
  )
    return false;
  return now - fix.updatedAt! > fix.updateInterval! * 1.25;
}
