/**
 * Publisher-side gate for shared run metadata.
 *
 * The renderer hides run controls off macOS, but automatic republishing also
 * runs in main. Keep that path from widening a share with commands the owner
 * cannot review on the current platform.
 */
export function isSharedContainerRunPublishingEnabled(
  featureEnabled: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return featureEnabled && platform === 'darwin';
}
