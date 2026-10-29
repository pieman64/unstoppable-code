// @capture-keep: paired visual proof that a Cursor chat inherits the user's installed skills and commands
// @capture-reference: docs/cursor-chat.md
// Cursor inherited capabilities — feature-verification captures
// (docs/planning/2026-10-05-cursor-inherited-capabilities/design.md).
//
// What changed: a Cursor chat now copies the skills and commands from the
// user's own `~/.cursor`, `~/.claude`, `~/.codex`, `~/.agents`, and `~/.grok`
// folders into its private HOME before every message and lists them in the
// composer's `/` menu. Before the change those folders were invisible to the
// chat and the menu showed only Canopy's own catalog.
//
// Run (light, then dark) on the unmodified tree, then on the changed tree:
//   CURSOR_INHERITED_STAGE=before pnpm run test:electron:captures:built cursor-inherited.capture-spec.ts --reporter=line
//   CURSOR_INHERITED_STAGE=before pnpm run test:electron:captures:built cursor-inherited.capture-spec.ts --reporter=line --dark-mode
//   # apply the change, rebuild with `pnpm run build:e2e`
//   CURSOR_INHERITED_STAGE=after pnpm run test:electron:captures:built cursor-inherited.capture-spec.ts --reporter=line
//   CURSOR_INHERITED_STAGE=after pnpm run test:electron:captures:built cursor-inherited.capture-spec.ts --reporter=line --dark-mode
//
// Determinism: the managed Cursor runtime is the deterministic ACP fixture
// agent (no live Cursor, no account usage); the inherited skills are seeded
// under the harness's relocated provider-state home. No network.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';

const STAGE =
  process.env.CURSOR_INHERITED_STAGE === 'before' ? 'before' : 'after';
const COLOR_MODE =
  process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  repoRoot,
  '.playwright',
  'cursor-inherited-capabilities',
);

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'cursor-inherited';

function seedInheritedSkills(userDataDir: string): void {
  const home = path.join(userDataDir, 'provider-state', 'home');
  const claude = path.join(userDataDir, 'provider-state', 'claude');
  for (const [root, name] of [
    [path.join(home, '.cursor', 'skills'), 'home-review'],
    [path.join(claude, 'skills'), 'claude-review'],
  ]) {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Inherited ${name}\n---\nUse ${name}.\n`,
    );
  }
  mkdirSync(path.join(claude, 'commands'), { recursive: true });
  writeFileSync(
    path.join(claude, 'commands', 'ship.md'),
    '# Ship\n\nShip $ARGUMENTS.\n',
  );
}

test(`Cursor inherited capabilities captures (${STAGE}, ${COLOR_MODE})`, async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cursor-inherited-capture-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedInheritedSkills(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'cursor',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Cursor inherited',
        model: 'cursor-default',
        approvalMode: 'ask',
      },
    ],
  });
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({
    userDataDir,
    env: managed.env,
    viewportSize: { width: 1200, height: 860 },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expect(window.getByTestId('cursor-connection-status')).toHaveText(
      'Cursor connected',
    );
    await driver.closeSettings();
    await driver.openMainPage();
    await driver.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    // One message so the turn has run once: after the change it also
    // refreshes the inventory with the inherited rows.
    await panel
      .getByRole('textbox')
      .first()
      .fill('CURSOR_CHAT_E2E_TEXT: Reply exactly: Cursor chat works.');
    await panel
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(
      panel.getByText('Cursor chat works.', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const composer = panel.getByRole('textbox').first();
    await composer.click();
    await composer.fill('/');
    const menu = window.getByTestId('chat-input-plus-menu');
    await expect(menu).toBeVisible();
    if (STAGE === 'after') {
      const inheritedRow = menu.getByTestId(
        'chat-input-capability-home-review',
      );
      await expect(inheritedRow).toBeVisible({ timeout: 15_000 });
      await expect(
        menu.getByTestId('chat-input-capability-ship'),
      ).toBeVisible();
      // The inherited rows sit under "Skills and commands", below the
      // Commands group; bring them into the captured viewport.
      await inheritedRow.scrollIntoViewIfNeeded();
    } else {
      await expect(
        menu.getByTestId('chat-input-capability-home-review'),
      ).toHaveCount(0);
    }
    await menu.screenshot({
      path: path.join(
        captureDir,
        `slash-menu-desktop-${STAGE}-${COLOR_MODE}.png`,
      ),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    cleanupDemoWorkspaces(seeded);
  }
});
