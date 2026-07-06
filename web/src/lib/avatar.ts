/** Generates a default DiceBear avatar URL for a username. No upload in MVP. */
export function defaultAvatarUrl(username: string): string {
  const seed = encodeURIComponent(username);
  return `https://api.dicebear.com/9.x/initials/svg?seed=${seed}&backgroundType=gradientLinear`;
}
