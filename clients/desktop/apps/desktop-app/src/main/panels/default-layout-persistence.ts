/**
 * Per-surface default panel-layout persistence.
 *
 * Stores one template layout per `PanelLayoutSurface`: `'code'` at
 * `{dataDir}/default-panel-layout.json` (the original pre-surface filename,
 * so existing saved defaults keep working with zero migration) and
 * `'cowork'` at `{dataDir}/default-panel-layout.cowork.json`. Templates seed
 * newly created worktrees / cowork workspaces of that surface (see the
 * renderer persistence bridge's restore-or-default fallback). Mirrors the
 * per-worktree store's validation posture: both load and save run through
 * `migratePanelLayout`, a corrupt file loads as `null`, and an invalid save
 * is dropped instead of clobbering the last good file. Writes are
 * synchronous — this is a deliberate, infrequent user action, not
 * high-frequency layout churn, so no debounce is needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PanelLayoutSurface } from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  PANEL_LAYOUT_FILE_VERSION,
  sanitizeRawPlanPanelBindings,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import { getDefaultPanelLayoutFilePath } from '../lib/paths';

interface DefaultPanelLayoutFileShape {
  readonly version: 1;
  readonly layout: SerializablePanelLayoutFile;
}

export class DefaultPanelLayoutStore {
  public loadDefaultLayout(
    surface: PanelLayoutSurface,
  ): SerializablePanelLayoutFile | null {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(
        readFileSync(getDefaultPanelLayoutFilePath(surface), 'utf8'),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('layout' in parsed)
    ) {
      return null;
    }
    // Drop malformed plan panel bindings first so one damaged plan entry
    // cannot reject (and reset) the whole saved default.
    return migratePanelLayout(sanitizeRawPlanPanelBindings(parsed.layout));
  }

  public saveDefaultLayout(
    surface: PanelLayoutSurface,
    layout: SerializablePanelLayoutFile,
  ): void {
    const validated = migratePanelLayout(layout);
    if (validated === null) {
      return;
    }
    const file: DefaultPanelLayoutFileShape = {
      version: PANEL_LAYOUT_FILE_VERSION,
      layout: validated,
    };
    const filePath = getDefaultPanelLayoutFilePath(surface);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
  }
}

export const defaultPanelLayoutStore = new DefaultPanelLayoutStore();
