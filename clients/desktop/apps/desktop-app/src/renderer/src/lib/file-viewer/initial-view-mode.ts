import type { FileTabViewMode } from '@canopy/desktop-shared/types';
import { defaultFileViewMode } from '@canopy/ui-app/file-kind';

/**
 * Kind default for a new file tab, delegated to the shared classification.
 * Ordinary openers defer to the store so session memory can take precedence.
 */
export function initialFileTabViewMode(
  filename: string,
): FileTabViewMode | undefined {
  return defaultFileViewMode(filename);
}
