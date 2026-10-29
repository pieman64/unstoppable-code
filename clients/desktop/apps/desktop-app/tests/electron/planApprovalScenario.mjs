import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  buildApprovalRule,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Real bundled Claude and application approval hooks, with model responses
// scripted by the local mock server. Every mutation stays inside the fixture.
export async function exercisePlanApproval({
  mode = 'ask',
  decision = 'allow',
  tool = 'Bash',
  rule,
  stage = 'after',
  capture,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-plan-policy-'),
  );
  let electronApp;
  try {
    for (const key of Object.keys(process.env)) {
      if (/^CANOPY_[A-Z0-9]+_BINARY_PATH$/.test(key)) delete process.env[key];
    }
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspaceId = 'demo-ts-pnpm-vite';
    const worktreeId = 'demo-main';
    const markerPath = path.join(
      seeded.workspaces[0].worktreePath,
      'plan-approved.txt',
    );
    const command = `touch '${markerPath}'`;
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId,
      providerType: 'claude',
      tabs: [
        {
          id: 't1',
          title: 'Planning approvals',
          planMode: true,
          approvalMode: mode,
        },
      ],
    });
    if (rule) {
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId,
        rules: [
          buildApprovalRule({
            behavior: rule,
            target: { kind: 'command', pattern: command },
          }),
        ],
      });
    }
    const marker = `Canopy-CPLANPOLICY-${mode}-${decision}-${tool}-${rule ?? 'none'}`;
    const reply = 'Planning inspection complete.';
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: tool,
                input:
                  tool === 'Write'
                    ? {
                        file_path: markerPath,
                        content: 'Approved planning scratch file.\n',
                      }
                    : { command },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: reply, stopReason: 'end_turn' },
        ],
      },
    });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const planToggle = window.getByTestId('chat-input-plan-mode-inline-button');
    await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
    const label =
      mode === 'full-access'
        ? 'Full access'
        : mode === 'auto'
          ? 'Accept edits'
          : 'Ask';
    await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
      'aria-label',
      `Tool approval mode, current mode ${label}`,
    );
    await window
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Inspect the plan using the requested tool.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    const card = window.getByTestId('tool-approval-card');
    const shouldPrompt =
      stage === 'after' &&
      mode !== 'full-access' &&
      !rule &&
      !(mode === 'auto' && tool === 'Write');
    if (shouldPrompt) {
      await expect(card).toBeVisible({ timeout: 60_000 });
      expect(existsSync(markerPath)).toBe(false);
      if (capture) await capture(window.getByTestId('panel-content-chat'));
      await window.getByTestId(`tool-approval-${decision}`).click();
    }
    await expect(
      window.getByTestId('panel-content-chat').getByText(reply).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(0);
    await expect(planToggle).toHaveAttribute('aria-pressed', 'true');
    const shouldWrite =
      stage === 'after' &&
      (mode === 'full-access' || (rule !== 'deny' && decision === 'allow'));
    expect(existsSync(markerPath)).toBe(shouldWrite);
    if (capture && !shouldPrompt)
      await capture(window.getByTestId('panel-content-chat'));
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
}
