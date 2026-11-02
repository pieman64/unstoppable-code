import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect as baseExpect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  claudeToolName,
  createDelegationInference,
} from './delegationRuntime.mjs';
import { seedWorkspaceApprovals, seedWorktreeChat } from './seeders/index.mjs';

const expect = baseExpect.configure({
  timeout: process.platform === 'win32' ? 45_000 : 15_000,
});
const TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;
const scaled = (milliseconds) => milliseconds * TIMEOUT_SCALE;
const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const chatId = 'delegating-parent';
const unavailableParentTurn = 'The owning parent turn is unavailable.';

test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

function retainedRuns(userDataDir) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'delegation',
    'runs',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
    );
}

function retainedTranscript(userDataDir) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chat-storage-v2',
    worktreeId,
    'transcripts',
  );
  const readJsonLines = (file) =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const committed = readJsonLines(path.join(directory, `${chatId}.jsonl`));
  const committedIds = new Set(committed.map((message) => message.id));
  const activeRows = readJsonLines(
    path.join(directory, `${chatId}.active.json`),
  );
  const activeMessages =
    activeRows[0]?.version === 2
      ? activeRows
          .filter((row) => row.kind === 'message')
          .map((row) => row.message)
      : (activeRows[0]?.messages ?? []);
  return [
    ...committed,
    ...activeMessages.filter((message) => !committedIds.has(message.id)),
  ];
}

async function expandCollapsedTurns(panel) {
  const collapsed = panel.locator(
    'button[aria-label^="Agent steps"][aria-expanded="false"]',
  );
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await collapsed.count()) === 0) return;
    const previous = await collapsed.count();
    await collapsed.first().click();
    await expect.poll(() => collapsed.count()).toBeLessThan(previous);
  }
  await expect(collapsed).toHaveCount(0);
}

test('Claude self-started wake can use managed delegation', async ({}, testInfo) => {
  test.setTimeout(scaled(180_000));
  const caseId = 'claude-managed-delegation-wake';
  const taskOutput = `WAKE_TASK_FINISHED_${caseId}`;
  const userMessage = `Start one short background command, then finish. ${caseId}`;
  const initialReply = 'The background task is running.';
  const wakeReply = 'The wake started a managed review.';
  // Steps are chosen from the conversation, not by counting requests: chat
  // title and other helper requests also carry the user's message.
  let phase = 0;
  let wakeRequestContext = '';
  let wakeRequestText = '';
  let backgroundLaunchResults = '';
  let wakeToolResults = '';
  let notificationFoldedIntoFirstTurn = false;
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'foreground',
    caseId,
    script: ({
      role,
      item,
      context,
      text,
      results,
      markers,
      spawnInput,
      reply,
    }) => {
      if (role !== 'parent') return undefined;
      // Title generation and other helpers offer no tools; only turns do.
      if (!item.toolNames.includes('Bash'))
        return reply({ text: 'Wake regression', stopReason: 'end_turn' });
      if (!text.includes('<task-notification>')) {
        if (phase === 0) {
          phase = 1;
          return reply({
            toolCalls: [
              {
                name: 'Bash',
                input: {
                  // Long enough for the first turn to end before the task does.
                  command: `sleep 8; printf '%s\\n' ${taskOutput}`,
                  run_in_background: true,
                  description: 'Complete the wake regression task',
                },
              },
            ],
            stopReason: 'tool_use',
          });
        }
        phase = Math.max(phase, 2);
        backgroundLaunchResults = results;
        return reply({ text: initialReply, stopReason: 'end_turn' });
      }
      // The CLI injected the task notification: this is the self-started turn.
      if (phase < 2) notificationFoldedIntoFirstTurn = true;
      if (phase < 3) {
        phase = 3;
        wakeRequestContext = context;
        wakeRequestText = text;
        return {
          marker: markers.parent,
          step: {
            toolCalls: [
              {
                name: claudeToolName('DelegateTask'),
                input: spawnInput,
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      wakeToolResults = results;
      phase = 4;
      return reply({ text: wakeReply, stopReason: 'end_turn' });
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-wake-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  writeFileSync(
    path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
    `// ${fixture.canary}\nexport async function wakeEvidence() { return true; }\n`,
  );
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId,
    defaultMode: 'full-access',
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        managedDelegationMode: 'explicit-only',
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
        codexMultiAgentWorktreeChatsEnabled: false,
      },
    }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: chatId,
        title: 'Delegating parent',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
      },
    ],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  let assertionsCompleted = false;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const panel = window.getByTestId('panel-content-chat');
    await window
      .getByRole('textbox')
      .first()
      .fill(`[${fixture.parentMarker}] ${userMessage}`);
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText(initialReply, { exact: true })).toBeVisible({
      timeout: scaled(90_000),
    });
    await expect(panel.getByText(wakeReply, { exact: true })).toBeVisible({
      timeout: scaled(120_000),
    });
    await expect.poll(() => phase, { timeout: scaled(30_000) }).toBe(4);
    expect(
      notificationFoldedIntoFirstTurn,
      'the task notification must start its own turn, not join the first one',
    ).toBe(false);

    // Check this first so the unchanged build's red run fails specifically on
    // the wake's refused managed-tool call, before any card assertions.
    expect(
      wakeToolResults,
      'the wake must not be refused because its owning parent turn is unavailable',
    ).not.toContain(unavailableParentTurn);

    // The CLI must have injected its task notification before this model
    // request; the managed call below is made by that self-started turn.
    expect(wakeRequestContext).toMatch(/<task-notification>/i);
    expect(wakeRequestText).toMatch(/<task-notification>/i);
    expect(backgroundLaunchResults).not.toBe('');

    const transcript = retainedTranscript(userDataDir);
    const transcriptText = JSON.stringify(transcript);
    expect(transcriptText).not.toContain(unavailableParentTurn);
    expect(transcriptText).toContain(userMessage);
    expect(transcriptText).toContain(initialReply);
    expect(transcriptText).toContain(wakeReply);

    await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
      'data-state',
      'completed',
      { timeout: scaled(30_000) },
    );
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);

    await expandCollapsedTurns(panel);
    const card = panel.getByTestId('chat-delegated-agent');
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    const userBubble = panel
      .locator('[data-chat-message-id]')
      .filter({ hasText: userMessage })
      .first();
    await expect(userBubble).toBeVisible();
    // The wake's card sits with the latest user message, below it on screen.
    const userBox = await userBubble.boundingBox();
    const cardBox = await card.boundingBox();
    expect(userBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(
      cardBox.y,
      'the delegate card renders below the user message',
    ).toBeGreaterThan(userBox.y);

    const [run] = retainedRuns(userDataDir);
    expect(run).toMatchObject({ depth: 1, state: { status: 'completed' } });
    expect(run.state.finalText).toContain(fixture.finding);
    assertionsCompleted = true;
  } finally {
    await testInfo.attach('wake-inference-state', {
      body: JSON.stringify(
        {
          phase,
          backgroundLaunchResults,
          wakeRequestContext,
          wakeRequestText,
          wakeToolResults,
          requests: fixture.requests,
          errors: fixture.errors,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    const keepUserData = !assertionsCompleted;
    await closeCanopy(electronApp, userDataDir, { keepUserData });
    await fixture.close();
    if (!keepUserData) cleanupDemoWorkspaces(demo);
  }
});
