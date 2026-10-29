import { selectModelOption } from './model-selection-fixture.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Live-turn pilot — proves the full E2E provider seam end to end:
//
//   composer send → chatStore.sendMessage IPC → Claude session spawns the
//   bundled `claude` binary with the E2E `envOverride`
//   (ANTHROPIC_BASE_URL=http://127.0.0.1:4011) → the binary POSTs the Anthropic
//   Messages request to the shared mock server's `/v1/messages` SSE surface →
//   the mock resolves the scenario registered under the `[Canopy-CPILOT]` marker
//   embedded in the user message → the scripted assistant text streams back →
//   the renderer's chat transcript renders it.
//
// This is the de-risk spec for the whole "live tier": every other live-turn
// spec depends on this exact path working. It does NOT assert a seeded block —
// the asserted assistant text can ONLY come from the mock provider answering
// the live turn, so a green run is proof the bundled Claude SDK actually drove
// a turn against the mock.
//
// Prereqs already wired by the harness (see launchCanopy.mjs / claude-session.ts
// / mock-server/routes/llm.mjs):
//   - `out/` is a `build:e2e` build (`__CANOPY_E2E__` compiled to true), so the
//     `claude-session.ts` default `prepareInvocation` returns the mock
//     `envOverride` only when `CANOPY_MOCK_LLM_BASE_URL` is set.
//   - `launchCanopy` injects `CANOPY_MOCK_LLM_BASE_URL=http://127.0.0.1:4011`
//     and `CANOPY_MOCK_API_KEY=mock` into the Electron env.
//   - The bundled `claude` binary is staged at `.cache/bin/darwin-<arch>/claude`.
//
// ENVIRONMENT HYGIENE (why we scrub `CANOPY_*_BINARY_PATH` below):
//   The dev binary directory is resolved by `getBundledBinDir()`
//   (packages/desktop-shared/src/pipelines/config-paths.ts). Its FIRST check is
//   `getPipelineBundledBinDirOverride()`, which derives the bundled bin dir from
//   any `CANOPY_<TOOL>_BINARY_PATH` override env var (CLAUDE/CODEX/GH/OLLAMA/RTK/
//   RG/DICTATE). A machine with the packaged app installed exports e.g.
//   `CANOPY_RTK_BINARY_PATH=/Applications/Canopy.app/Contents/Resources/bin/rtk`
//   in the developer's login shell. `launchCanopy` spreads `process.env`, so that
//   override leaks into the test Electron, repointing the WHOLE bin dir at
//   `/Applications/Canopy.app/.../bin`. The bundled `claude` there belongs to a
//   different (possibly quarantined) build and "exists but failed to launch",
//   so every in-app SDK turn errors out before reaching the mock. Scrubbing the
//   overrides from the parent process env BEFORE launch (launchCanopy reads
//   `process.env` at spawn time) restores the dev `.cache/bin/<target>`
//   resolution. This is harness/environment hygiene, not an app change.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

const CONVERSATION_MARKER = 'Canopy-CPILOT';
// No trailing punctuation: the assistant text streams into a markdown <span>,
// and a trailing '.' is not reliably part of the same matched text node. A
// punctuation-free phrase makes the transcript assertion deterministic.
const ASSISTANT_REPLY = 'Greetings from the deterministic Canopy mock provider';

test.describe('chat live turn (pilot)', () => {
  test('a live Claude turn is redirected to the mock and renders the scripted reply', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-live-turn-'),
    );

    // Phase 1: real git worktree (plain `ts-pnpm-vite` fixture).
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready to
    // send. No seeded transcript blocks — the only assistant text in this spec
    // must come from the live turn against the mock.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat', model: 'sonnet' }],
    });

    // Register the scripted conversation under the `[Canopy-CPILOT]` marker. The
    // LLM route resolves the scenario from the marker found in the user message
    // text, so the single scripted step drives the streamed reply.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await app.selectWorktree(WORKTREE_BRANCH);

      // The Claude chat panel + composer mount.
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // Type the marker-bearing message into the Slate composer (a
      // contenteditable with role="textbox") and send it.
      const userMessage = `[${CONVERSATION_MARKER}] Say hello.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);

      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders in the transcript once sent.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The live turn is the real validator: the bundled `claude` binary POSTs
      // to the mock and streams the scripted reply back. The SDK turn takes a
      // few seconds (process spawn + handshake + stream), so allow a generous
      // timeout. This text can ONLY originate from the mock provider, scoped to
      // the chat transcript panel.
      await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(
        window.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await panel.getByTestId('chat-model-picker').click();
      await expect(
        window.getByTestId('chat-model-option-sonnet'),
      ).toHaveAttribute('aria-checked', 'true');
      // Rows that would bill to AI Credits say so; Sonnet stays on its
      // subscription, so its row carries no AI credits label.
      await expect(
        window.locator('[data-testid="chat-model-row-credits-sonnet"]:visible'),
      ).toHaveCount(0);
      await expect(panel.getByText(/Claude model changed from/)).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('restores a resolved Sonnet chat as native Sonnet with subscription billing', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sonnet-alias-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'sonnet-chat',
        title: 'Sonnet alias',
        model: 'claude-sonnet-5-5',
        blocks: [{ type: 'text', text: 'A previous Sonnet reply' }],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const picker = window.getByTestId('chat-model-picker');
    await picker.click();
    await expect(
      window.getByTestId('chat-model-option-sonnet'),
    ).toHaveAttribute('aria-checked', 'true');
    // The restored Sonnet chat stays on its subscription.
    await expect(
      window.locator('[data-testid="chat-model-row-credits-sonnet"]:visible'),
    ).toHaveCount(0);
    await expect(picker).toContainText('Sonnet 5.5');
    await selectModelOption(window, 'opus[1m]');
    await expect(picker).toContainText('Opus 5.5');
    await picker.click();
    await selectModelOption(window, 'sonnet');
    await expect(picker).toContainText('Sonnet 5.5');

    // The previous Sonnet generation stays selectable under Claude's More.
    await picker.click();
    await expect(
      window.getByTestId('chat-model-option-claude-sonnet-5'),
    ).toHaveCount(0);
    await window.getByTestId('chat-model-more-anthropic').click();
    const legacySonnet = window
      .getByTestId('chat-model-more-group-anthropic')
      .getByTestId('chat-model-option-claude-sonnet-5');
    await expect(legacySonnet).toBeVisible();
    await legacySonnet.click();
    await expect(picker).toHaveText(/Sonnet 5(?!\.5)/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
