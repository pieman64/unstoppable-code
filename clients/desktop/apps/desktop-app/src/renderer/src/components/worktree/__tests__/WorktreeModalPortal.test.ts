/**
 * @jest-environment node
 */
// Source-level coverage keeps the modal-root contract explicit without
// mounting the worktree components' store and Electron dependencies.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const readComponent = (name: string): string =>
  readFileSync(join(__dirname, '..', name), 'utf-8');

describe('sidebar-owned worktree modals', () => {
  // The shared DialogModal portals Branch Info to the document body with the
  // browser-native overlay marker; WorktreeBranchInfoDialog.replay.test.tsx
  // mounts it and asserts both.
  it('renders Branch Info through the shared DialogModal', () => {
    const source = readComponent('WorktreeBranchInfoDialog.tsx');

    expect(source).toMatch(/<DialogModal\b/);
    expect(source).not.toContain('createPortal');
  });

  // The confirmation itself portals through the shared DialogModal; its
  // overlay root and <body> placement are asserted by mounting it in
  // WorktreeRemovalConfirmDialog.test.tsx.
  it('renders the delete confirmation through the shared removal dialog', () => {
    const source = readComponent('WorktreeItem.tsx');

    expect(source).toMatch(
      /showConfirm\s*&&\s*\(\s*<WorktreeRemovalConfirmDialog\b/,
    );
  });
});
