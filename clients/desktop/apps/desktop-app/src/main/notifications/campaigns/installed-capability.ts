import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { readLockFile } from '../../skills/lock-file';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read canonical installed state; uncertainty must never qualify a campaign. */
export async function hasInstalledCapability(): Promise<boolean> {
  const lock: unknown = readLockFile();
  if (
    isRecord(lock) &&
    isRecord(lock.skills) &&
    Object.keys(lock.skills).length > 0
  )
    return true;
  const result = await loadMarketplacesCacheOnly();
  if (!result.success || result.data === undefined)
    throw new Error('Installed plugins could not be read.');
  return result.data.marketplaces.some((marketplace) =>
    marketplace.plugins.some(
      (plugin) =>
        plugin.globalInstallStatus?.claude?.installed === true ||
        plugin.globalInstallStatus?.codex?.installed === true,
    ),
  );
}
