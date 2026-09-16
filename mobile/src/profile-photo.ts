// Inline JPEG thumbnails travel only inside encrypted application messages and backups.
// Never accept remote URLs or arbitrary local file paths from another member.
export const MAX_PROFILE_PHOTO_LENGTH = 32 * 1024;
export function validProfilePhoto(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length <= MAX_PROFILE_PHOTO_LENGTH &&
      /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value))
  );
}
export function cleanProfilePhotos(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, photo]) => validProfilePhoto(photo)));
}
