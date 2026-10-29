import { expect } from '@playwright/test';
import { collectLeaves, getLayout } from './panelHarness.mjs';

/**
 * Waits until the visible worktree's layout holds a chat-bound panel: the one
 * for `chatTabId` when given, otherwise any.
 *
 * A chat tab's panel may materialize after the grid is ready (the
 * ensure-layout path can run before chat hydration seeds it, in which case
 * the sync bridge adds it on its next sweep), and it takes focus when it
 * arrives. `seedPanelWorktree()` waits for it only when it seeds the profile
 * itself, so a spec that passes its own `userDataDir` and then adds a panel
 * to the chat group can lose that panel to the late chat tab. Call this
 * first.
 *
 * Lives outside `panelHarness.mjs` because that file is byte-pinned by the
 * performance harness identity check.
 */
export async function waitForChatPanel(
  page,
  { chatTabId, timeout = 15_000 } = {},
) {
  await expect
    .poll(
      async () => {
        const layout = await getLayout(page);
        if (!layout) {
          return false;
        }
        return collectLeaves(layout.root).some((leaf) =>
          leaf.panels.some((panel) =>
            chatTabId === undefined
              ? typeof panel.instance?.chatTabId === 'string'
              : panel.instance?.chatTabId === chatTabId,
          ),
        );
      },
      { timeout },
    )
    .toBe(true);
}
