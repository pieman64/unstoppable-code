// CAN-4996: real approval service, provider tool loop, and canonical persistence.
// Barriers hold the next model response after every answer, so a working
// interval is observable without racing the next card or terminal event.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import {
  injectApprovalRequestEvent,
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE = 'demo-main';
const CHAT = 'timer-approvals';

test('a closed pause arriving before the card clears preserves elapsed (CAN-4996)', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-timer-reconcile-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
    activeTabId: CHAT,
    tabs: [{ id: CHAT, title: 'Timer reconciliation' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE);
    const scope = { projectId: PROJECT, worktreeId: WORKTREE };
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      scope,
    );
    let revision = snapshot.revision;
    const now = Date.now();
    await window.clock.setFixedTime(now);
    const startedAt = now - 5_000;
    const publish = async (timing) => {
      const baseRevision = revision++;
      await electronApp.evaluate(
        ({ BrowserWindow }, event) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            'chat:state-changed',
            event,
          );
        },
        {
          ...scope,
          schemaVersion: 1,
          eventId: `timer-reconcile-${revision}`,
          occurredAt: new Date().toISOString(),
          baseRevision,
          revision,
          changes: [
            ...[
              {
                id: 'reconcile-user',
                role: 'user',
                timestamp: startedAt,
                blocks: [{ type: 'text', text: 'Check the next step.' }],
              },
              {
                id: 'reconcile-reply',
                role: 'assistant',
                timestamp: startedAt + 1,
                blocks: [
                  {
                    type: 'text',
                    text: timing.resumedAt
                      ? 'Closed pause received.'
                      : 'Preparing the next step.',
                  },
                ],
              },
              {
                id: 'reconcile-timer',
                role: 'system',
                timestamp: startedAt + 1,
                blocks: [
                  {
                    type: 'turn_timer',
                    turnId: 'reconcile-turn',
                    startedAt,
                    completedAt: null,
                    ...timing,
                  },
                ],
              },
            ].map((message) => ({
              type: 'message.upserted',
              chatId: CHAT,
              message,
            })),
            {
              type: 'runtime.patched',
              chatId: CHAT,
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
        },
      );
    };
    await publish({});
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT}"]`,
    );
    const timer = panel.getByTestId('turn-timer');
    const status = panel.getByTestId('turn-work-header');
    await expect(timer).toHaveAttribute('data-state', 'live');
    await injectApprovalRequestEvent(electronApp, {
      ...scope,
      chatId: CHAT,
      requestId: 'reconcile-approval',
      provider: 'claude',
      title: 'Run shell command',
      details: { kind: 'command', command: 'touch can4996-reconcile' },
    });
    await expect(window.getByTestId('tool-approval-card')).toBeVisible();
    await expect(status).toContainText('Waiting for you · 0:05');
    // Coalesced transport delivery skips the open canonical pause.
    await window.clock.setFixedTime(now + 8_000);
    await publish({
      pausedAt: now,
      resumedAt: now + 8_000,
      accumulatedPausedDurationMs: 8_000,
    });
    await expect(
      panel.getByText('Closed pause received.', { exact: true }),
    ).toBeVisible();
    await expect(status).toContainText('Waiting for you · 0:05');
    await expect(timer).toHaveAttribute('data-state', 'paused');
    await window.clock.setFixedTime(now + 10_000);
    await window.getByTestId('tool-approval-allow').click();
    await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    await expect(timer).toHaveAttribute('data-state', 'live');
    await expect(status).toContainText('Working for 7s');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

async function control(key, name) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });
  expect(response.ok).toBe(true);
}

for (const withReceipt of [true, false]) {
  test(`an approval-held relative edit keeps its resolved file chip waiting (${withReceipt ? 'receipt' : 'mixed contributions'}, CAN-5291)`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-alias-approval-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seeded.workspaces.find((entry) => entry.id === PROJECT);
    expect(workspace?.worktreePath).toBeTruthy();
    const relativePath = 'approval-alias.md';
    const absolutePath = path.join(workspace.worktreePath, relativePath);
    writeFileSync(absolutePath, 'Original\n');
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT,
      worktreeId: WORKTREE,
      activeTabId: CHAT,
      tabs: [{ id: CHAT, title: 'Alias approval', approvalMode: 'ask' }],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE);
      const scope = { projectId: PROJECT, worktreeId: WORKTREE };
      const snapshot = await window.evaluate(
        (scope) => window.api.chat.getState(scope),
        scope,
      );
      const now = Date.now();
      const messages = [
        {
          id: 'alias-user',
          role: 'user',
          timestamp: now,
          blocks: [{ type: 'text', text: 'Edit the presented file.' }],
        },
        {
          id: 'alias-tools',
          role: 'assistant',
          timestamp: now + 1,
          blocks: [
            ...(withReceipt
              ? [
                  {
                    type: 'tool_use',
                    toolUseId: 'alias-receipt',
                    toolName: 'ShowFiles',
                    input: '{}',
                  },
                  {
                    type: 'tool_result',
                    toolUseId: 'alias-receipt',
                    toolName: 'ShowFiles',
                    output: JSON.stringify({
                      files: [{ path: relativePath, absolutePath, ok: true }],
                    }),
                    isError: false,
                  },
                ]
              : []),
            {
              type: 'tool_use',
              toolUseId: 'alias-edit',
              toolName: 'Edit',
              input: JSON.stringify({
                file_path: relativePath,
                old_string: 'Original',
                new_string: 'Changed',
              }),
            },
            ...(!withReceipt
              ? [
                  {
                    type: 'tool_use',
                    toolUseId: 'alias-executing',
                    toolName: 'Edit',
                    input: JSON.stringify({
                      file_path: absolutePath,
                      old_string: 'Original',
                      new_string: 'Executing',
                    }),
                  },
                ]
              : []),
          ],
        },
        {
          id: 'alias-timer',
          role: 'system',
          timestamp: now + 1,
          blocks: [
            {
              type: 'turn_timer',
              turnId: 'alias-turn',
              startedAt: now,
              completedAt: null,
            },
          ],
        },
      ];
      await electronApp.evaluate(
        ({ BrowserWindow }, event) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            'chat:state-changed',
            event,
          );
        },
        {
          ...scope,
          schemaVersion: 1,
          eventId: 'alias-state',
          occurredAt: new Date().toISOString(),
          baseRevision: snapshot.revision,
          revision: snapshot.revision + 1,
          changes: [
            ...messages.map((message) => ({
              type: 'message.upserted',
              chatId: CHAT,
              message,
            })),
            {
              type: 'runtime.patched',
              chatId: CHAT,
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
        },
      );
      await injectApprovalRequestEvent(electronApp, {
        ...scope,
        chatId: CHAT,
        requestId: 'alias-approval',
        toolUseId: 'alias-edit',
        provider: 'claude',
        title: 'Edit file',
        details: { kind: 'file-write', path: relativePath },
      });
      const panel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT}"]`,
      );
      await expect(window.getByTestId('tool-approval-card')).toBeVisible();
      await expect(
        panel.locator('[data-tool-name="Edit"]').first(),
      ).toHaveAttribute('data-tool-approval', 'waiting');
      const chip = panel
        .getByTestId('turn-file-chip')
        .filter({ hasText: relativePath });
      await expect(chip).toContainText('Waiting for approval');
      await expect(chip.locator('button').first()).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expect(chip).toContainText('Updating…');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

function timerRows(userDataDir) {
  const state = readChatStorageTabs(
    path.join(userDataDir, 'workspaces', PROJECT),
    WORKTREE,
  );
  const canonicalTurn = state.runtimeByChatId?.[CHAT]?.turn;
  return (
    state.tabs
      .find((tab) => tab.id === CHAT)
      ?.messages.flatMap((message) =>
        message.blocks
          .filter((block) => block.type === 'turn_timer')
          .map((block) => ({
            ...block,
            timerMessageId: message.id,
            canonicalTurn,
            canonicalPauseOwnerIds: (canonicalTurn?.current?.pauses ?? [])
              .filter((pause) => pause.endedAtMs === undefined)
              .map((pause) => pause.ownerId),
          })),
      ) ?? []
  );
}

for (const mode of ['ask', 'auto']) {
  test(`three sequential approvals freeze the whole-turn timer (${mode}, CAN-4996)`, async ({}, testInfo) => {
    test.setTimeout(240_000);
    const key = `Canopy-C4996-CLEAN-${mode}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-timer-approvals-'),
    );
    const readPath = path.join(userDataDir, 'read-fixture.txt');
    writeFileSync(readPath, 'Approval timer fixture.');
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT,
      worktreeId: WORKTREE,
      providerType: 'claude',
      activeTabId: CHAT,
      tabs: [{ id: CHAT, title: 'Timer approvals', approvalMode: mode }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      llm: {
        steps: [
          ...[0, 1, 2].map((step) => ({
            text: `Approval step ${step + 1}`,
            waitFor: `step-${step}`,
            barrierTimeoutMs: 120_000,
            toolCalls:
              mode === 'auto' && step === 1
                ? [{ name: 'Read', input: { file_path: readPath } }]
                : [
                    {
                      name: 'Bash',
                      input: { command: `touch can4996-${step}` },
                    },
                  ],
            stopReason: 'tool_use',
          })),
          {
            text: 'All three approvals finished',
            waitFor: 'step-3',
            barrierTimeoutMs: 120_000,
            stopReason: 'end_turn',
          },
        ],
      },
    });
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    const observations = [];
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'compact' }),
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE);
      const panel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT}"]`,
      );
      await expect(panel).toBeVisible();
      const timer = panel.getByTestId('turn-timer').last();
      const status = panel.getByTestId('turn-work-header').last();
      const card = window.getByTestId('tool-approval-card');
      // Sample immediately before paint. Mutation observers alone cannot
      // establish that a transient DOM mutation reached the screen.
      await window.evaluate((chatId) => {
        const visible = (node) =>
          node instanceof HTMLElement &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== 'hidden' &&
          getComputedStyle(node).display !== 'none';
        const state = { violations: [], cardFrames: 0, running: true };
        Reflect.set(window, '__can4996Frames', state);
        const sample = () => {
          if (!state.running) return;
          const panel = document.querySelector(
            `[data-panel-id="panel-chat-${chatId}"][data-testid="panel-content-chat"]`,
          );
          if (
            visible(
              document.querySelector('[data-testid="tool-approval-card"]'),
            ) &&
            visible(panel)
          ) {
            state.cardFrames++;
            const timers = [
              ...panel.querySelectorAll('[data-testid="turn-timer"]'),
            ];
            const timer = timers.at(-1);
            const header = [
              ...panel.querySelectorAll('[data-testid="turn-work-header"]'),
            ].at(-1);
            if (
              timer?.getAttribute('data-state') !== 'paused' ||
              header?.getAttribute('data-turn-header') === 'live'
            )
              state.violations.push({
                timer: timer?.outerHTML,
                header: header?.textContent,
              });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, CHAT);
      const assertFrames = async () => {
        const frames = await window.evaluate(() =>
          Reflect.get(window, '__can4996Frames'),
        );
        expect(frames.violations).toEqual([]);
        return frames;
      };
      await window
        .getByRole('textbox')
        .first()
        .fill(`[${key}] Run the three approval steps.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      observations.push({
        stage: 'started',
        timers: timerRows(userDataDir),
        renderedTimerCount: await timer.count(),
      });
      let original;
      let previousTotal = 0;
      for (let step = 0; step < 3; step++) {
        await control(key, `step-${step}`);
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card).toContainText(
          mode === 'auto' && step === 1 ? 'Read' : `touch can4996-${step}`,
        );
        await expect(timer).toHaveAttribute('data-state', 'paused');
        await expect(status).toContainText(/Waiting for you · \d+:\d{2}/);
        await expect(status).toHaveAttribute('data-turn-header', 'paused');
        await expect(panel.getByText('Thinking', { exact: true })).toHaveCount(
          0,
        );
        await expect(
          window.getByTestId('worktree-row-tool-approval').first(),
        ).toBeVisible();
        await expect(
          window.getByTestId(`panel-tab-tool-approval-${CHAT}`),
        ).toBeVisible();
        // The visible tool row (or grouped summary) identifies the current gate.
        const liveLine = panel.locator(
          '[data-testid="chat-tool-step-group"][data-live][data-tool-approval="waiting"], [data-testid="chat-tool-call"][data-tool-approval="waiting"]',
        );
        await expect(liveLine).toHaveAttribute('data-tool-approval', 'waiting');
        await expect(liveLine).toContainText('Waiting for approval');
        await expect(liveLine).toContainText(
          mode === 'auto' && step === 1 ? 'Read' : `Run touch can4996-${step}`,
        );
        await expect(
          liveLine.locator('[class*="canopy-text-shimmer"]'),
        ).toHaveCount(0);
        const rows = timerRows(userDataDir);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        original ??= { turnId: row.turnId, startedAt: row.startedAt };
        expect(row).toMatchObject(original);
        expect(row.pausedAt).toEqual(expect.any(Number));
        expect(row.resumedAt).toBeNull();
        observations.push({ stage: `card-${step}`, ...row });
        const frozen = await status.textContent();
        // This wait verifies display freezing, never estimates pause totals.
        await window.waitForTimeout(1_100);
        expect(await status.textContent()).toBe(frozen);
        await assertFrames();
        await window.getByTestId('tool-approval-allow').click();
        await expect(card).toHaveCount(0);
        await expect(
          panel.locator('[data-tool-approval="waiting"]'),
        ).toHaveCount(0);
        await expect(timer).toHaveAttribute('data-state', 'live');
        await expect(status).toContainText('Working for');
        await expect(
          window.getByTestId('worktree-row-tool-approval'),
        ).toHaveCount(0);
        await expect(
          window.getByTestId(`panel-tab-tool-approval-${CHAT}`),
        ).toHaveCount(0);
        const resumed = timerRows(userDataDir)[0];
        expect(resumed).toMatchObject(original);
        expect(resumed.accumulatedPausedDurationMs).toBe(
          previousTotal + resumed.resumedAt - row.pausedAt,
        );
        previousTotal = resumed.accumulatedPausedDurationMs;
        observations.push({ stage: `answer-${step}`, ...resumed });
        const active = await status.textContent();
        await expect.poll(() => status.textContent()).not.toBe(active);
        await assertFrames();
      }
      await control(key, 'step-3');
      await expect(timer).toHaveAttribute('data-state', 'completed', {
        timeout: 60_000,
      });
      await expect
        .poll(() => timerRows(userDataDir)[0]?.completedAt)
        .toEqual(expect.any(Number));
      const completed = timerRows(userDataDir)[0];
      expect(completed).toMatchObject({
        ...original,
        accumulatedPausedDurationMs: previousTotal,
      });
      const activeSeconds = Math.floor(
        (completed.completedAt - completed.startedAt - previousTotal) / 1000,
      );
      expect(activeSeconds).toBeGreaterThanOrEqual(3);
      // Completion puts the duration in the header; the footer shows the
      // completion stamp. Assert the same exact active seconds there.
      const minutes = Math.floor(activeSeconds / 60);
      const seconds = activeSeconds % 60;
      const words = [
        minutes > 0 ? `${minutes}m` : null,
        seconds > 0 || minutes === 0 ? `${seconds}s` : null,
      ]
        .filter(Boolean)
        .join(' ');
      await expect(status).toContainText(`Worked for ${words}`);
      const finalFrames = await assertFrames();
      expect(finalFrames.cardFrames).toBeGreaterThan(0);
      observations.push({
        stage: 'completed',
        activeSeconds,
        ...completed,
        frames: finalFrames,
      });
    } finally {
      const window = electronApp.windows()[0];
      if (window)
        await window
          .evaluate(() => {
            const state = Reflect.get(window, '__can4996Frames');
            if (state) state.running = false;
          })
          .catch(() => undefined);
      await testInfo.attach('can-4996-timer-observations.json', {
        body: JSON.stringify(observations, null, 2),
        contentType: 'application/json',
      });
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('approval waiting rows and file contributions resume or disappear after Allow and Deny (CAN-5291)', async () => {
  test.setTimeout(240_000);
  const key = 'Canopy-C5291-WRITES';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-waiting-files-'),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seeded.workspaces.find((entry) => entry.id === PROJECT);
  expect(workspace?.worktreePath).toBeTruthy();
  const firstPath = path.join(workspace.worktreePath, 'approval-first.md');
  const deniedPath = path.join(workspace.worktreePath, 'approval-denied.md');
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
    providerType: 'claude',
    activeTabId: CHAT,
    tabs: [{ id: CHAT, title: 'Waiting files', approvalMode: 'ask' }],
  });
  const calls = [
    { name: 'Bash', input: { command: 'sleep 3; touch can5291-running' } },
    { name: 'Write', input: { file_path: firstPath, content: 'Original\n' } },
    {
      name: 'Edit',
      input: {
        file_path: firstPath,
        old_string: 'Original',
        new_string: 'Changed',
      },
    },
    { name: 'Write', input: { file_path: deniedPath, content: 'Denied\n' } },
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    llm: {
      steps: [
        ...calls.map((call, step) => ({
          toolCalls: [call],
          waitFor: `gate-${step}`,
          barrierTimeoutMs: 120_000,
          stopReason: 'tool_use',
        })),
        {
          text: 'Approval file flow complete',
          waitFor: 'gate-4',
          barrierTimeoutMs: 120_000,
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT}"]`,
    );
    await window
      .getByRole('textbox')
      .first()
      .fill(`[${key}] Run the approval file flow.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    for (let step = 0; step < calls.length; step++) {
      await control(key, `gate-${step}`);
      await expect(window.getByTestId('tool-approval-card')).toBeVisible({
        timeout: 60_000,
      });
      const target =
        step === 0
          ? 'sleep 3'
          : step === 3
            ? 'approval-denied.md'
            : 'approval-first.md';
      const row = panel
        .locator(`[data-tool-name="${calls[step].name}"]`)
        .filter({ hasText: target })
        .last();
      await expect(row).toHaveAttribute('data-tool-approval', 'waiting');
      await expect(row).toHaveAttribute('data-tool-status', 'pending');
      await expect(row.locator('[class*="canopy-text-shimmer"]')).toHaveCount(
        0,
      );
      if (step === 1 || step === 3) {
        const chip = panel
          .getByTestId('turn-file-chip')
          .filter({ hasText: target });
        await expect(chip).toContainText('Waiting for approval');
        await expect(chip.getByTestId('turn-file-chip-open')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await expect(chip.getByTestId('turn-file-chip-open')).toHaveAttribute(
          'aria-disabled',
          'true',
        );
        await expect(chip.getByTestId('turn-file-chip-reveal')).toHaveCount(0);
      }
      await window
        .getByTestId(step < 2 ? 'tool-approval-allow' : 'tool-approval-deny')
        .click();
      await expect(row).not.toHaveAttribute('data-tool-approval', 'waiting');
      if (step === 0) {
        await expect(row).toHaveAttribute('data-tool-status', 'pending');
        await expect(row).toContainText('Run sleep 3');
        await expect(row.locator('[class*="canopy-text-shimmer"]')).toHaveCount(
          1,
        );
      }
      await expect(row).toHaveAttribute(
        'data-tool-status',
        step < 2 ? 'success' : 'blocked',
        { timeout: 60_000 },
      );
      if (step === 3) {
        await expect(
          panel
            .getByTestId('turn-file-chip')
            .filter({ hasText: 'approval-denied.md' }),
        ).toHaveCount(0);
      }
    }
    await control(key, 'gate-4');
    await expect(panel.getByText('Approval file flow complete')).toBeVisible({
      timeout: 60_000,
    });
    await expect(panel.locator('[data-tool-approval="waiting"]')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
