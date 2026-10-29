/**
 * Architectural guard: durable chat state is main-owned, and the legacy
 * renderer snapshot writers are removed. NO renderer module may reference the
 * legacy writer surface (`saveTabs`, `saveTabsPartial`, `scheduleSave`,
 * `flushPendingSave`) — renderer code issues typed commands via
 * `dispatchChatCommand` instead of writing snapshots.
 *
 * ADDING an allowlist entry requires a conscious ownership decision; the only
 * remaining entry is the panel-layout module, whose local `scheduleSave` is
 * its own (non-chat) persisted-UI debounce and merely collides with the
 * banned symbol name.
 */
// Node built-ins are restricted in renderer production code; this guard is a
// Jest-only source scan that never ships to the renderer bundle.
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join, relative, sep } from 'node:path';

const RENDERER_SRC = join(__dirname, '..', '..', '..');

const LEGACY_WRITER_PATTERN =
  /\b(saveTabs|saveTabsPartial|scheduleSave|flushPendingSave)\b/;

/** Non-chat modules whose own symbols collide with the banned names. */
const LEGACY_ALLOWLIST = new Set(['lib/panels/persistence-bridge.ts']);

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('renderer persistence guard', () => {
  it('no new renderer module references the legacy chat snapshot writers', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(RENDERER_SRC)) {
      const relativePath = relative(RENDERER_SRC, file).split(sep).join('/');
      if (LEGACY_ALLOWLIST.has(relativePath)) continue;
      const content = readFileSync(file, 'utf8');
      if (LEGACY_WRITER_PATTERN.test(content)) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the revisioned modules themselves are free of legacy writer references', () => {
    for (const module of [
      'stores/chat/revisioned-sync.ts',
      'stores/chat/revisioned-commands.ts',
      'stores/chat/canonical-changes.ts',
      'stores/chat/slices/revisioned.ts',
    ]) {
      const content = readFileSync(join(RENDERER_SRC, module), 'utf8');
      expect(LEGACY_WRITER_PATTERN.test(content)).toBe(false);
    }
  });
});
