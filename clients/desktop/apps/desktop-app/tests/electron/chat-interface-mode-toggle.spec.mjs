import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { openChatInterfaceModeMenu } from './chatInterfaceMode.mjs';

// Doc 2 — Spec 1: `chat-interface-mode-toggle.spec.mjs`.
//
// Covers PRs 686 (the Canopy ↔ Claude Code interface-mode switch) and 767 (the
// idle-gating reasons). A Claude chat's composer offers the modes under View
// in its + menu (`buildChatComposerPlusItems`); the Claude Code terminal
// surface floats `ChatInterfaceModeToggle` to switch back. Neither shows for
// non-Claude tabs.
//
// TWO-PHASE SEEDING: a worktree chat needs a real git worktree (so the row is
// selectable and `ChatPanel`/`ChatContent` mount) *and* a seeded chat file
// (`workspaces/{workspaceId}/chats/{worktreeId}.json`, `ChatTabsFile`) with a
// controlled `providerType`. We seed two plain demo workspaces:
//   - `demo-ts-pnpm-vite` / `demo-main`  → a Claude-backed tab (toggle visible).
//   - `demo-ts-npm-next`  / `demo-main`  → a Codex-backed tab (toggle absent).
// Both fixtures are plain (no setup/launch scripts — see
// demo-workspaces.spec.mjs), so the seeded worktrees stay idle.
//
// `providerType` survives hydration (`fromPersistedTab` in chatStore.ts), so the
// Claude/Codex distinction — and therefore the toggle's visibility — is fully
// reachable from a seeded chat file.
//
// LIMITATION (PR 767 streaming-disabled state): a chat tab's live `status`
// (`'idle' | 'streaming' | 'error'`) is runtime store state, NOT a persisted
// field. `fromPersistedTab` hardcodes `status: 'idle'` and there is no
// window-exposed store seam to inject `'streaming'` without modifying app
// source. Driving the streaming state requires a live Claude turn, which the
// harness cannot do. We therefore assert the fully-reachable idle surface:
// both buttons enabled, each carrying a non-empty idle `title` tooltip. The
// streaming-disabled `title` swap (767) stays at unit level
// (`ChatInterfaceModeToggle.test.tsx`).

const CLAUDE_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const CODEX_WORKSPACE_ID = 'demo-ts-npm-next';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

test.describe('chat interface mode toggle (686/767)', () => {
  test('the + menu offers the modes, enabled and checked, for an idle Claude tab', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-mode-claude-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: CLAUDE_WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 'claude-tab-1', title: 'Claude Chat' }],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const panel = window.getByTestId('panel-content-chat');
      // The Canopy surface floats no toggle: the modes live in the
      // composer's + menu, under View.
      await expect(panel.getByTestId('chat-interface-mode-toggle')).toHaveCount(
        0,
      );
      await openChatInterfaceModeMenu(window, panel);
      const canopyRow = window.getByTestId('chat-interface-mode-option-canopy');
      const autoRow = window.getByTestId('chat-interface-mode-option-auto');
      const claudeCodeRow = window.getByTestId(
        'chat-interface-mode-option-claude-code',
      );

      // Idle tab → no option is disabled (686).
      await expect(canopyRow).toBeEnabled();
      await expect(autoRow).toBeEnabled();
      await expect(claudeCodeRow).toBeEnabled();

      // A fresh Claude tab defaults to the Canopy-native mode, so Canopy is
      // the checked option and neither terminal-backed mode is (686). The
      // modes are one single-select choice, so each row is a radio.
      await expect(canopyRow).toHaveAttribute('role', 'radio');
      await expect(canopyRow).toHaveAttribute('aria-checked', 'true');
      await expect(canopyRow.locator('[data-menu-check]')).toHaveCount(1);
      await expect(autoRow).toHaveAttribute('aria-checked', 'false');
      await expect(claudeCodeRow).toHaveAttribute('aria-checked', 'false');

      // Each row says what the mode does.
      await expect(autoRow).toContainText('Auto');
      await expect(autoRow).toContainText('terminal execution');
      await expect(claudeCodeRow).toContainText('Claude Code');

      // Pointer selection switches the chat and closes the menu.
      await autoRow.click();
      await expect(window.getByTestId('chat-input-plus-menu')).toBeHidden();
      await openChatInterfaceModeMenu(window, panel);
      await expect(autoRow).toHaveAttribute('aria-checked', 'true');
      await expect(canopyRow).toHaveAttribute('aria-checked', 'false');

      // Keyboard activation reaches the same selection; Claude Code swaps in
      // the terminal surface, whose floating toggle is the way back.
      await claudeCodeRow.focus();
      await window.keyboard.press('Enter');
      await expect(
        window.getByTestId('chat-interface-mode-toggle-claude-code'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId('chat-interface-mode-toggle-auto'),
      ).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the modes are absent for a Codex-backed tab', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-mode-codex-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-npm-next'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: CODEX_WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [{ id: 'codex-tab-1', title: 'Codex Chat' }],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      await app.selectWorktree(WORKTREE_BRANCH);

      // The chat panel mounts for the Codex tab...
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // ...but the modes are Claude-only: no floating toggle, and the + menu
      // carries no View section (686 negative case).
      await window
        .getByTestId('panel-content-chat')
        .getByTestId('chat-input-plus-button')
        .click();
      await expect(window.getByTestId('chat-input-plus-menu')).toBeVisible();
      await expect(window.getByTestId('chat-input-plus-view')).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(
        window.getByTestId('chat-interface-mode-toggle'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-interface-mode-toggle-canopy'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-interface-mode-toggle-auto'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-interface-mode-toggle-claude-code'),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
