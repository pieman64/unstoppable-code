import { shell } from 'electron';
import type { PlatformTrashServices } from '@canopy/core-runtime';

/**
 * Electron main's PlatformServices Trash member. The only caller of
 * `shell.trashItem` (check:core-filesystem-boundary); failures propagate.
 */
export const electronTrashServices: PlatformTrashServices = Object.freeze({
  trashItem: (path: string): Promise<void> => shell.trashItem(path),
});
