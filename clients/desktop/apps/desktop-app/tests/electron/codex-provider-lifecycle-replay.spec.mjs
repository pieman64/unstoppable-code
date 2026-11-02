// Recorded skeletons enter at the real stdio provider boundary; no chat-event
// injection or mock API is involved in these real-host lifecycle round trips.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import {
  closeFixture,
  createFixture,
  protocolEntries,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspaceId = 'demo-ts-pnpm-vite';
const scopeId = 'demo-main';
const chatId = 'provider-lifecycle-replay';

function replayRecords(logPath) {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function serverFrames(fixture) {
  return protocolEntries(fixture.logPath)
    .filter((entry) => entry.direction === 'server')
    .map((entry) => entry.message);
}

function prepareLifecycleReplay({
  scenario,
  armedGates = [],
  scenarioOptions,
}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-lifecycle-'),
  );
  const fixture = createFixture('replay');
  const replayLog = path.join(fixture.runtimeDir, 'replay.jsonl');
  const gatesDir = path.join(fixture.runtimeDir, 'gates');
  mkdirSync(gatesDir, { recursive: true });
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: scopeId,
    providerType: 'codex',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Lifecycle replay',
        providerType: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'ask',
      },
    ],
  });
  const launchOptions = {
    userDataDir,
    env: {
      ...fixture.env,
      CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.resolve(
        directory,
        '../../../../scripts/harness-contract/lifecycle/fixtures/codex',
        `${scenario}.json`,
      ),
      CANOPY_LIFECYCLE_REPLAY_MODULE: path.join(
        directory,
        'fixtures/lifecycle-replay.mjs',
      ),
      CANOPY_LIFECYCLE_REPLAY_LOG: replayLog,
      CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
      CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify(armedGates),
      ...(scenarioOptions === undefined
        ? {}
        : {
            CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS:
              JSON.stringify(scenarioOptions),
          }),
    },
  };
  return { userDataDir, fixture, replayLog, gatesDir, launchOptions };
}

async function openLifecycleReplayChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(scopeId);
  const panel = window
    .locator('[data-testid="panel-content-chat"]:visible')
    .first();
  const composer = panel.locator('[data-chat-composer-root]');
  await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
    'aria-label',
    'Tool approval mode, current mode Ask',
    { timeout: 15_000 },
  );
  return { window, app, panel, composer };
}

async function listLiveBackgroundTasks(window) {
  return window.evaluate(
    async ({ projectId, worktreeId, targetChatId }) => {
      const snapshot = await window.api.activity.listLiveBgTasks({
        projectId,
        worktreeId,
      });
      return snapshot.chats[targetChatId]?.liveTasks ?? [];
    },
    { projectId: workspaceId, worktreeId: scopeId, targetChatId: chatId },
  );
}

async function chatTurnIsActive(window) {
  return window.evaluate(
    async ({ projectId, worktreeId, targetChatId }) => {
      const active = await window.api.chat.activeSessions({
        projectId,
        worktreeId,
      });
      return (
        active.sessions?.find((session) => session.chatId === targetChatId)
          ?.turnActive ?? false
      );
    },
    { projectId: workspaceId, worktreeId: scopeId, targetChatId: chatId },
  );
}

function storedMessageText(message) {
  return (message.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

// start-while-active is transport-covered by the node replay tests. A second
// composer send while this root is live uses steer/queue, not turn/start; the
// real-host merge setup needs an active resume and is not fabricated here.
for (const scenario of ['approval', 'background-terminal', 'fatal-error']) {
  test(`@provider-lifecycle codex/${scenario} retains its real-host settlement after reload`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-lifecycle-'),
    );
    const fixture = createFixture('replay');
    const replayLog = path.join(fixture.runtimeDir, 'replay.jsonl');
    const gatesDir = path.join(fixture.runtimeDir, 'gates');
    mkdirSync(gatesDir, { recursive: true });
    seedPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: scopeId,
      providerType: 'codex',
      activeTabId: chatId,
      tabs: [
        {
          id: chatId,
          title: 'Lifecycle replay',
          providerType: 'codex',
          model: 'gpt-6-sol',
          approvalMode: 'ask',
        },
      ],
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...fixture.env,
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.resolve(
          directory,
          '../../../../scripts/harness-contract/lifecycle/fixtures/codex',
          `${scenario}.json`,
        ),
        CANOPY_LIFECYCLE_REPLAY_MODULE: path.join(
          directory,
          'fixtures/lifecycle-replay.mjs',
        ),
        CANOPY_LIFECYCLE_REPLAY_LOG: replayLog,
        CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify(
          scenario === 'background-terminal' ? ['release-helper-finished'] : [],
        ),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(scopeId);
      const panel = window
        .locator('[data-testid="panel-content-chat"]:visible')
        .first();
      const composer = panel.locator('[data-chat-composer-root]');
      await expect(window.getByTestId('approval-mode-picker')).toHaveAttribute(
        'aria-label',
        'Tool approval mode, current mode Ask',
        { timeout: 15_000 },
      );
      await composer
        .getByRole('textbox')
        .fill('Run the synthetic lifecycle command.');
      await composer
        .getByRole('button', { name: 'Send message', exact: true })
        .click();

      if (scenario === 'fatal-error') {
        const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
        const runtime = () =>
          readChatStorageIndexes(workspaceRoot, scopeId).live.runtimeByChatId[
            chatId
          ];
        const fatalErrors = () =>
          serverFrames(fixture).filter(
            (frame) =>
              frame.method === 'error' && frame.params?.willRetry === false,
          );
        await expect.poll(fatalErrors, { timeout: 45_000 }).toHaveLength(1);
        const fatal = fatalErrors()[0];
        const failedCompletions = () =>
          serverFrames(fixture).filter(
            (frame) =>
              frame.method === 'turn/completed' &&
              frame.params?.threadId === fatal.params.threadId,
          );
        await expect
          .poll(failedCompletions, { timeout: 45_000 })
          .toHaveLength(1);
        const fatalFrames = serverFrames(fixture);
        const completion = failedCompletions()[0];
        expect(completion.params.turn).toMatchObject({
          id: fatal.params.turnId,
          status: 'failed',
        });
        const errors = fatalFrames.filter(
          (frame) =>
            frame.method === 'error' &&
            frame.params?.threadId === fatal.params.threadId,
        );
        expect(errors).toHaveLength(1);
        const errorDetail = errors[0].params.error.message;
        expect(errorDetail).toEqual(expect.any(String));
        expect(errorDetail.trim()).not.toBe('');
        expect(
          fatalFrames.findIndex(
            (frame) =>
              frame.method === 'error' &&
              frame.params?.threadId === fatal.params.threadId,
          ),
        ).toBeLessThan(
          fatalFrames.findIndex(
            (frame) =>
              frame.method === 'turn/completed' &&
              frame.params?.threadId === fatal.params.threadId,
          ),
        );
        await expect
          .poll(() =>
            replayRecords(replayLog).some((record) => record.kind === 'done'),
          )
          .toBe(true);

        const persistedOutcome = () => {
          const messages = readChatStorageMessages(
            workspaceRoot,
            scopeId,
            chatId,
          );
          return {
            prompts: messages
              .filter((message) => message.role === 'user')
              .map((message) => message.id),
            timers: messages.flatMap((message) =>
              (message.blocks ?? [])
                .filter((block) => block.type === 'turn_timer')
                .map((block) => ({ messageId: message.id, ...block })),
            ),
            notices: messages
              .filter((message) => message.role === 'system')
              .map((message) => ({
                id: message.id,
                text: (message.blocks ?? [])
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('\n'),
              }))
              .filter((notice) => notice.text.startsWith('Error:')),
          };
        };
        const assertFailedSettlement = async () => {
          await expect
            .poll(() => runtime()?.status, { timeout: 30_000 })
            .toBe('failed');
          expect(runtime()?.activeTurn).toBeUndefined();
          // The failed status can commit a moment before its error detail.
          await expect
            .poll(() => runtime()?.error?.message)
            .toContain(errorDetail);
          await expect
            .poll(() => persistedOutcome().notices)
            .toEqual([
              { id: expect.any(String), text: `Error: ${errorDetail}` },
            ]);
          await expect
            .poll(() => persistedOutcome().timers)
            .toEqual([
              expect.objectContaining({ completedAt: expect.any(Number) }),
            ]);
          expect(persistedOutcome().prompts).toHaveLength(1);
          // One rendered error and settled timer, rather than a duplicate
          // error/result pair or a phantom second turn after provider failure.
          await expect(
            panel.getByText(`Error: ${errorDetail}`, { exact: true }),
          ).toHaveCount(1);
          await expect(
            panel.getByText(`Error: ${errorDetail}`, { exact: true }),
          ).toBeVisible();
          await expect(panel.getByTestId('turn-timer')).toHaveCount(1);
          await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
            'data-state',
            'completed',
          );
          await expect(composerIdleAction(composer)).toBeVisible();
          await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
          expect(failedCompletions()).toHaveLength(1);
          expect(
            protocolEntries(fixture.logPath).filter(
              (entry) =>
                entry.direction === 'client' &&
                entry.message?.method === 'turn/start' &&
                entry.message.params?.threadId === fatal.params.threadId,
            ),
          ).toHaveLength(1);
        };
        await assertFailedSettlement();
        const beforeReload = persistedOutcome();
        await window.reload({ waitUntil: 'domcontentloaded' });
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
        await app.selectWorktree(scopeId);
        await assertFailedSettlement();
        // Reload must reuse the exact notice/timer rows, including their
        // completion stamp; merely seeing another equivalent row is not enough.
        expect(persistedOutcome()).toEqual(beforeReload);
        return;
      }

      await expect(window.getByTestId('tool-approval-dock')).toBeVisible({
        timeout: 45_000,
      });
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toHaveCount(1);
      const requests = serverFrames(fixture).filter(
        (frame) => frame.method === 'item/commandExecution/requestApproval',
      );
      expect(requests).toHaveLength(1);
      const approval = requests[0];
      await expect(card).toContainText(approval.params.command);
      const commandCompletions = () =>
        serverFrames(fixture).filter(
          (frame) =>
            frame.method === 'item/completed' &&
            frame.params?.item?.id === approval.params.itemId,
        );
      const turnCompletions = () =>
        serverFrames(fixture).filter(
          (frame) =>
            frame.method === 'turn/completed' &&
            frame.params?.threadId === approval.params.threadId,
        );
      // The approval control is blocked on the real response, not a timer.
      expect(commandCompletions()).toHaveLength(0);
      expect(turnCompletions()).toHaveLength(0);
      expect(
        replayRecords(replayLog).filter(
          (record) => record.kind === 'approval-response',
        ),
      ).toHaveLength(0);
      await window.getByTestId('tool-approval-allow').click();
      await expect(card).toHaveCount(0);
      await expect
        .poll(() =>
          replayRecords(replayLog).filter(
            (record) => record.kind === 'approval-response',
          ),
        )
        .toEqual([
          expect.objectContaining({
            type: 'accept',
            name: String(approval.id),
          }),
        ]);
      await expect
        .poll(() =>
          serverFrames(fixture).filter(
            (frame) =>
              frame.method === 'serverRequest/resolved' &&
              frame.params?.requestId === approval.id,
          ),
        )
        .toEqual([
          {
            method: 'serverRequest/resolved',
            params: {
              threadId: approval.params.threadId,
              requestId: approval.id,
            },
          },
        ]);
      expect(
        serverFrames(fixture).filter((frame) => frame.id === approval.id),
      ).toEqual([approval]);
      await expect.poll(turnCompletions).toHaveLength(1);
      await expect(composerIdleAction(composer)).toBeVisible({
        timeout: 30_000,
      });

      const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
      const status = () =>
        readChatStorageIndexes(workspaceRoot, scopeId).live.runtimeByChatId[
          chatId
        ]?.status;
      await expect.poll(status, { timeout: 30_000 }).toBe('completed');
      if (scenario === 'background-terminal') {
        await expect
          .poll(() =>
            replayRecords(replayLog).some(
              (record) =>
                record.kind === 'gate' &&
                record.name === 'release-helper-finished',
            ),
          )
          .toBe(true);
        expect(commandCompletions()).toHaveLength(0);
        writeFileSync(path.join(gatesDir, 'release-helper-finished'), '');
      }
      await expect.poll(commandCompletions).toHaveLength(1);
      expect(commandCompletions()[0].params.item.status).toBe('completed');
      await expect
        .poll(() =>
          replayRecords(replayLog).some((record) => record.kind === 'done'),
        )
        .toBe(true);
      await expect(composerIdleAction(composer)).toBeVisible();
      expect(status()).toBe('completed');
      const completedItem = serverFrames(fixture).find(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.item?.type === 'agentMessage' &&
          frame.params?.threadId === approval.params.threadId,
      );
      expect(completedItem?.params.item.text).toBeTruthy();
      await expect(
        panel
          .getByText(completedItem.params.item.text, { exact: true })
          .first(),
      ).toBeVisible();
      const commandResult = () =>
        readChatStorageMessages(workspaceRoot, scopeId, chatId)
          .flatMap((message) => message.blocks ?? [])
          .filter(
            (block) =>
              block.type === 'tool_result' &&
              block.toolUseId === `codex-${approval.params.itemId}`,
          );
      // The authoritative aggregate is what the fake sent on the command's final
      // item/completed (content-free fixtures carry synthetic output).
      const commandAggregate = () =>
        serverFrames(fixture)
          .filter(
            (frame) =>
              frame.method === 'item/completed' &&
              frame.params?.item?.type === 'commandExecution' &&
              frame.params.item.id === approval.params.itemId,
          )
          .at(-1)?.params.item.aggregatedOutput;
      await expect
        .poll(
          () =>
            readChatStorageMessages(workspaceRoot, scopeId, chatId)
              .flatMap((message) => message.blocks ?? [])
              .some(
                (block) =>
                  block.type === 'text' &&
                  block.text === completedItem.params.item.text,
              ),
          { timeout: 30_000 },
        )
        .toBe(true);
      if (scenario === 'background-terminal') {
        await expect.poll(commandResult, { timeout: 30_000 }).toHaveLength(1);
        expect(commandAggregate()).toEqual(expect.any(String));
        expect(commandAggregate()).not.toBe('');
        expect(commandResult()[0]).toMatchObject({
          type: 'tool_result',
          output: commandAggregate(),
          isError: false,
        });
      } else {
        await expect.poll(commandResult, { timeout: 30_000 }).toHaveLength(1);
      }

      await window.reload({ waitUntil: 'domcontentloaded' });
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(scopeId);
      await expect(
        panel
          .getByText(completedItem.params.item.text, { exact: true })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(composerIdleAction(composer)).toBeVisible();
      await expect(card).toHaveCount(0);
      expect(status()).toBe('completed');
      expect(commandResult()).toHaveLength(1);
      if (scenario === 'background-terminal') {
        expect(commandResult()[0]).toMatchObject({
          type: 'tool_result',
          output: commandAggregate(),
          isError: false,
        });
      }
      expect(
        serverFrames(fixture).filter(
          (frame) => frame.method === 'item/commandExecution/requestApproval',
        ),
      ).toHaveLength(1);
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });
}

test('@provider-lifecycle codex/provider-resolved-approval settles the live card without a client reply', async () => {
  test.setTimeout(180_000);
  const prepared = prepareLifecycleReplay({
    scenario: 'approval',
    armedGates: ['release-provider-resolution'],
    scenarioOptions: { providerResolvesRequest: true },
  });
  const { electronApp } = await launchCanopy(prepared.launchOptions);
  try {
    const { window, composer } = await openLifecycleReplayChat(electronApp);
    await composer
      .getByRole('textbox')
      .fill('Run the synthetic lifecycle command.');
    await composer
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    await expect(window.getByTestId('tool-approval-dock')).toBeVisible({
      timeout: 45_000,
    });
    const approvalCard = window.getByTestId('tool-approval-card');
    await expect(approvalCard).toHaveCount(1);
    const approval = serverFrames(prepared.fixture).find(
      (frame) => frame.method === 'item/commandExecution/requestApproval',
    );
    expect(approval).toBeTruthy();
    await expect(approvalCard).toContainText(approval.params.command);
    const turnCompletions = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === approval.params.threadId,
      );
    const clientReplies = () =>
      protocolEntries(prepared.fixture.logPath).filter(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === approval.id,
      );
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) =>
            record.kind === 'gate' &&
            record.name === 'release-provider-resolution',
        ),
      )
      .toBe(true);
    expect(turnCompletions()).toHaveLength(0);
    expect(clientReplies()).toHaveLength(0);
    expect(
      serverFrames(prepared.fixture).filter(
        (frame) => frame.method === 'serverRequest/resolved',
      ),
    ).toHaveLength(0);

    writeFileSync(
      path.join(prepared.gatesDir, 'release-provider-resolution'),
      '',
      'utf8',
    );
    await expect
      .poll(() =>
        serverFrames(prepared.fixture).filter(
          (frame) =>
            frame.method === 'serverRequest/resolved' &&
            frame.params?.requestId === approval.id,
        ),
      )
      .toEqual([
        {
          method: 'serverRequest/resolved',
          params: {
            threadId: approval.params.threadId,
            requestId: approval.id,
          },
        },
      ]);
    await expect(approvalCard).toHaveCount(0);
    expect(
      serverFrames(prepared.fixture).filter(
        (frame) => frame.id === approval.id,
      ),
    ).toEqual([approval]);
    expect(clientReplies()).toHaveLength(0);
    await expect.poll(turnCompletions).toHaveLength(1);
    await expect(composerIdleAction(composer)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) => record.kind === 'done',
        ),
      )
      .toBe(true);
    expect(clientReplies()).toHaveLength(0);
  } finally {
    await closeFixture(
      electronApp,
      prepared.userDataDir,
      prepared.fixture.runtimeDir,
    );
  }
});

test('@provider-lifecycle codex/provider-resolved-request-user-input settles the built-in question card without an answer', async () => {
  test.setTimeout(180_000);
  const prepared = prepareLifecycleReplay({
    scenario: 'approval',
    armedGates: ['release-provider-resolution'],
    scenarioOptions: {
      requestUserInput: true,
      providerResolvesRequest: true,
    },
  });
  const { electronApp } = await launchCanopy(prepared.launchOptions);
  try {
    const { window, composer } = await openLifecycleReplayChat(electronApp);
    await composer
      .getByRole('textbox')
      .fill('Run the synthetic lifecycle command.');
    await composer
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    await expect(window.getByTestId('tool-approval-dock')).toBeVisible({
      timeout: 45_000,
    });
    const approvalCard = window.getByTestId('tool-approval-card');
    await expect(approvalCard).toHaveCount(1);
    const approval = serverFrames(prepared.fixture).find(
      (frame) => frame.method === 'item/commandExecution/requestApproval',
    );
    expect(approval).toBeTruthy();
    await expect(approvalCard).toContainText(approval.params.command);
    const turnCompletions = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === approval.params.threadId,
      );
    expect(turnCompletions()).toHaveLength(0);
    await window.getByTestId('tool-approval-allow').click();
    await expect(approvalCard).toHaveCount(0);
    await expect
      .poll(() =>
        serverFrames(prepared.fixture).filter(
          (frame) =>
            frame.method === 'serverRequest/resolved' &&
            frame.params?.requestId === approval.id,
        ),
      )
      .toEqual([
        {
          method: 'serverRequest/resolved',
          params: {
            threadId: approval.params.threadId,
            requestId: approval.id,
          },
        },
      ]);
    expect(
      protocolEntries(prepared.fixture.logPath)
        .filter(
          (entry) =>
            entry.direction === 'client-response' &&
            entry.message?.id === approval.id,
        )
        .map((entry) => entry.message),
    ).toEqual([{ id: approval.id, result: { decision: 'accept' } }]);
    expect(
      serverFrames(prepared.fixture).filter(
        (frame) => frame.id === approval.id,
      ),
    ).toEqual([approval]);

    await expect
      .poll(() =>
        serverFrames(prepared.fixture).find(
          (frame) => frame.method === 'item/tool/requestUserInput',
        ),
      )
      .toBeTruthy();
    const question = serverFrames(prepared.fixture).find(
      (frame) => frame.method === 'item/tool/requestUserInput',
    );
    expect(question.params.threadId).toBe(approval.params.threadId);
    expect(question.params.questions[0].question).toBe(
      'Choose an option for the synthetic task.',
    );
    const questionCard = window.getByTestId('chat-question-prompt');
    await expect(questionCard).toBeVisible({ timeout: 30_000 });
    await expect(questionCard).toContainText(
      'Choose an option for the synthetic task.',
    );
    await expect(
      questionCard.getByTestId('chat-question-option-0'),
    ).toContainText('Continue');
    expect(turnCompletions()).toHaveLength(0);
    const questionReplies = () =>
      protocolEntries(prepared.fixture.logPath).filter(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === question.id,
      );
    expect(questionReplies()).toHaveLength(0);
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) =>
            record.kind === 'gate' &&
            record.name === 'release-provider-resolution',
        ),
      )
      .toBe(true);
    expect(
      replayRecords(prepared.replayLog).filter(
        (record) => record.kind === 'request-user-input-response',
      ),
    ).toHaveLength(0);

    writeFileSync(
      path.join(prepared.gatesDir, 'release-provider-resolution'),
      '',
      'utf8',
    );
    await expect
      .poll(() =>
        serverFrames(prepared.fixture).filter(
          (frame) =>
            frame.method === 'serverRequest/resolved' &&
            frame.params?.requestId === question.id,
        ),
      )
      .toEqual([
        {
          method: 'serverRequest/resolved',
          params: {
            threadId: question.params.threadId,
            requestId: question.id,
          },
        },
      ]);
    await expect(questionCard).toHaveCount(0);
    expect(questionReplies()).toHaveLength(0);
    expect(
      serverFrames(prepared.fixture).filter(
        (frame) => frame.id === question.id,
      ),
    ).toEqual([question]);
    await expect.poll(turnCompletions).toHaveLength(1);
    await expect(composerIdleAction(composer)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) => record.kind === 'done',
        ),
      )
      .toBe(true);
    expect(questionReplies()).toHaveLength(0);
    expect(
      replayRecords(prepared.replayLog).filter(
        (record) => record.kind === 'request-user-input-response',
      ),
    ).toHaveLength(0);
  } finally {
    await closeFixture(
      electronApp,
      prepared.userDataDir,
      prepared.fixture.runtimeDir,
    );
  }
});

test('@provider-lifecycle codex/subagent-after-root-turn keeps a late child result on its settled original turn', async () => {
  test.setTimeout(180_000);
  const prompt = 'Keep the recorded child result on this original turn.';
  const prepared = prepareLifecycleReplay({
    scenario: 'subagent-after-root-turn',
    armedGates: ['before-32'],
  });
  const { electronApp } = await launchCanopy(prepared.launchOptions);
  const workspaceRoot = path.join(
    prepared.userDataDir,
    'workspaces',
    workspaceId,
  );
  const runtime = () =>
    readChatStorageIndexes(workspaceRoot, scopeId).live.runtimeByChatId[chatId];
  const storedMessages = () =>
    readChatStorageMessages(workspaceRoot, scopeId, chatId);
  const userPrompts = () =>
    storedMessages().filter(
      (message) =>
        message.role === 'user' && storedMessageText(message).includes(prompt),
    );
  try {
    const { window, app, composer } =
      await openLifecycleReplayChat(electronApp);
    await composer.getByRole('textbox').fill(prompt);
    await composer
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    const rootTurnStarted = () =>
      serverFrames(prepared.fixture).find(
        (frame) => frame.method === 'turn/started',
      );
    await expect.poll(rootTurnStarted, { timeout: 45_000 }).toBeTruthy();
    const rootThreadId = rootTurnStarted().params.threadId;
    const rootTurnStartRequestCount = () =>
      protocolEntries(prepared.fixture.logPath).filter(
        (entry) =>
          entry.direction === 'client' &&
          entry.message?.method === 'turn/start' &&
          entry.message.params?.threadId === rootThreadId,
      ).length;
    const rootCompletion = () =>
      serverFrames(prepared.fixture).find(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === rootThreadId,
      );
    await expect.poll(rootCompletion, { timeout: 45_000 }).toBeTruthy();
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) => record.kind === 'gate' && record.name === 'before-32',
        ),
      )
      .toBe(true);
    await expect.poll(() => runtime()?.status).toBe('completed');
    await expect.poll(() => chatTurnIsActive(window)).toBe(false);
    expect(runtime()?.activeTurn).toBeUndefined();
    expect(userPrompts()).toHaveLength(1);
    const originalUserMessageId = userPrompts()[0].id;
    const rootStartedCount = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/started' &&
          frame.params?.threadId === rootThreadId,
      ).length;
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);
    expect(
      serverFrames(prepared.fixture).some(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.threadId === rootThreadId &&
          frame.params?.item?.type === 'subAgentActivity' &&
          frame.params?.item?.kind === 'completed',
      ),
    ).toBe(false);

    // The recording's child and root lanes are independent, and the replay
    // plays the child lane through its own idle and turn/completed before the
    // root turn ends, so no live child remains here. The pipeline proof
    // (incident-codex-background) holds a child past the root turn instead.
    writeFileSync(path.join(prepared.gatesDir, 'before-32'), 'release');
    const lateCompletion = () =>
      serverFrames(prepared.fixture).find(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.threadId === rootThreadId &&
          frame.params?.item?.type === 'subAgentActivity' &&
          frame.params?.item?.kind === 'completed',
      );
    await expect.poll(lateCompletion, { timeout: 30_000 }).toBeTruthy();
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) => record.kind === 'done',
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await listLiveBackgroundTasks(window)).some(
          (task) => task.taskType === 'local_agent',
        ),
      )
      .toBe(false);

    const rootTurnCompletions = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === rootThreadId,
      );
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);
    expect(rootTurnCompletions()).toHaveLength(1);
    expect(runtime()?.status).toBe('completed');
    expect(runtime()?.activeTurn).toBeUndefined();
    expect(await chatTurnIsActive(window)).toBe(false);

    // The late `subAgentActivity` completion carries no output text; the
    // transcript records it as the original turn's agent-call child state.
    const childThreadIds = new Set(
      serverFrames(prepared.fixture)
        .filter((frame) => frame.params?.item?.type === 'subAgentActivity')
        .map((frame) => frame.params.item.agentThreadId),
    );
    const lateResults = () => {
      const messages = storedMessages();
      const originalIndex = messages.findIndex(
        (message) => message.id === originalUserMessageId,
      );
      const nextUserIndex = messages.findIndex(
        (message, index) => index > originalIndex && message.role === 'user',
      );
      const originalTurnMessages = messages.slice(
        originalIndex,
        nextUserIndex < 0 ? undefined : nextUserIndex,
      );
      return originalTurnMessages
        .flatMap((message) => message.blocks ?? [])
        .filter(
          (block) =>
            block.type === 'codex_agent_call' &&
            Array.from(childThreadIds).some(
              (threadId) =>
                block.receiverThreadIds?.includes(threadId) &&
                block.agentsStates?.[threadId]?.status === 'completed',
            ),
        );
    };
    await expect.poll(lateResults, { timeout: 30_000 }).toHaveLength(1);
    const resultBeforeReload = lateResults();

    await window.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(scopeId);
    expect(userPrompts()).toHaveLength(1);
    expect(userPrompts()[0].id).toBe(originalUserMessageId);
    expect(lateResults()).toEqual(resultBeforeReload);
    expect(runtime()?.status).toBe('completed');
    expect(runtime()?.activeTurn).toBeUndefined();
    await expect.poll(() => chatTurnIsActive(window)).toBe(false);
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);
    expect(rootTurnCompletions()).toHaveLength(1);
  } finally {
    await closeFixture(
      electronApp,
      prepared.userDataDir,
      prepared.fixture.runtimeDir,
    );
  }
});

test('@provider-lifecycle codex/background-terminal keeps a live process after root settlement and persists its late result', async () => {
  test.setTimeout(180_000);
  const prompt = 'Keep the terminal result on this original turn.';
  const syntheticProcessId = 'codex-lifecycle-background-process-42';
  const prepared = prepareLifecycleReplay({
    scenario: 'background-terminal',
    armedGates: ['release-helper-finished'],
    scenarioOptions: { syntheticProcessId },
  });
  const { electronApp } = await launchCanopy(prepared.launchOptions);
  const workspaceRoot = path.join(
    prepared.userDataDir,
    'workspaces',
    workspaceId,
  );
  const runtime = () =>
    readChatStorageIndexes(workspaceRoot, scopeId).live.runtimeByChatId[chatId];
  const storedMessages = () =>
    readChatStorageMessages(workspaceRoot, scopeId, chatId);
  const userPrompts = () =>
    storedMessages().filter(
      (message) =>
        message.role === 'user' && storedMessageText(message).includes(prompt),
    );
  try {
    const { window, app, panel, composer } =
      await openLifecycleReplayChat(electronApp);
    await composer.getByRole('textbox').fill(prompt);
    await composer
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    await expect(window.getByTestId('tool-approval-dock')).toBeVisible({
      timeout: 45_000,
    });
    const card = window.getByTestId('tool-approval-card');
    const approval = serverFrames(prepared.fixture).find(
      (frame) => frame.method === 'item/commandExecution/requestApproval',
    );
    expect(approval).toBeTruthy();
    const rootThreadId = approval.params.threadId;
    const startedCommand = serverFrames(prepared.fixture).find(
      (frame) =>
        frame.method === 'item/started' &&
        frame.params?.threadId === rootThreadId &&
        frame.params?.item?.type === 'commandExecution' &&
        frame.params?.item?.id === approval.params.itemId,
    );
    expect(startedCommand).toBeTruthy();
    expect(startedCommand.params.item.processId).toBe(syntheticProcessId);
    const rootTurnStartRequestCount = () =>
      protocolEntries(prepared.fixture.logPath).filter(
        (entry) =>
          entry.direction === 'client' &&
          entry.message?.method === 'turn/start' &&
          entry.message.params?.threadId === rootThreadId,
      ).length;
    const turnCompletions = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === rootThreadId,
      );
    const commandCompletions = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.item?.type === 'commandExecution' &&
          frame.params?.item?.id === approval.params.itemId,
      );
    expect(commandCompletions()).toHaveLength(0);
    await window.getByTestId('tool-approval-allow').click();
    await expect(card).toHaveCount(0);
    await expect.poll(turnCompletions, { timeout: 45_000 }).toHaveLength(1);
    await expect.poll(() => runtime()?.status).toBe('completed');
    await expect.poll(() => chatTurnIsActive(window)).toBe(false);
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) =>
            record.kind === 'gate' && record.name === 'release-helper-finished',
        ),
      )
      .toBe(true);
    expect(commandCompletions()).toHaveLength(0);
    expect(runtime()?.activeTurn).toBeUndefined();
    expect(userPrompts()).toHaveLength(1);
    const originalUserMessageId = userPrompts()[0].id;
    const rootStartedCount = () =>
      serverFrames(prepared.fixture).filter(
        (frame) =>
          frame.method === 'turn/started' &&
          frame.params?.threadId === rootThreadId,
      ).length;
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);

    // The app-server replay has an opt-in process id while its completion is
    // held. The main process activity store must retain it independently of
    // the now-settled chat turn.
    await expect
      .poll(async () =>
        (await listLiveBackgroundTasks(window)).some(
          (task) => task.taskType === 'local_bash',
        ),
      )
      .toBe(true);
    // Canopy cannot stop a Codex task (turn-state D10), so the tray shows the
    // live terminal without a Stop control.
    expect(
      (await listLiveBackgroundTasks(window)).find(
        (task) => task.taskType === 'local_bash',
      ),
    ).toMatchObject({ stoppable: false });
    await window
      .locator('[data-testid="composer-work-drawer-toggle"]:visible')
      .first()
      .click();
    await expect(
      window.locator('[data-testid="background-tray-row"]:visible').first(),
    ).toBeVisible();
    await expect(
      window.locator('[data-testid="background-tray-row-stop"]:visible'),
    ).toHaveCount(0);

    writeFileSync(
      path.join(prepared.gatesDir, 'release-helper-finished'),
      'release',
    );
    await expect.poll(commandCompletions, { timeout: 30_000 }).toHaveLength(1);
    expect(commandCompletions()[0].params.item.status).toBe('completed');
    await expect
      .poll(() =>
        replayRecords(prepared.replayLog).some(
          (record) => record.kind === 'done',
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await listLiveBackgroundTasks(window)).some(
          (task) => task.taskType === 'local_bash',
        ),
      )
      .toBe(false);

    const commandAggregate = () =>
      commandCompletions().at(-1)?.params.item.aggregatedOutput;
    const commandResult = () =>
      storedMessages()
        .flatMap((message) => message.blocks ?? [])
        .filter(
          (block) =>
            block.type === 'tool_result' &&
            block.toolUseId === `codex-${approval.params.itemId}`,
        );
    await expect.poll(commandResult, { timeout: 30_000 }).toHaveLength(1);
    expect(commandAggregate()).toEqual(expect.any(String));
    expect(commandAggregate()).not.toBe('');
    expect(commandResult()[0]).toMatchObject({
      output: commandAggregate(),
      isError: false,
    });
    expect(runtime()?.status).toBe('completed');
    expect(runtime()?.activeTurn).toBeUndefined();
    await expect.poll(() => chatTurnIsActive(window)).toBe(false);
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);
    expect(turnCompletions()).toHaveLength(1);
    const resultBeforeReload = commandResult();

    await window.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(scopeId);
    expect(userPrompts()).toHaveLength(1);
    expect(userPrompts()[0].id).toBe(originalUserMessageId);
    expect(commandResult()).toEqual(resultBeforeReload);
    expect(runtime()?.status).toBe('completed');
    expect(runtime()?.activeTurn).toBeUndefined();
    await expect.poll(() => chatTurnIsActive(window)).toBe(false);
    expect(rootStartedCount()).toBe(1);
    expect(rootTurnStartRequestCount()).toBe(1);
    expect(turnCompletions()).toHaveLength(1);
    await expect(panel.getByTestId('tool-approval-card')).toHaveCount(0);
  } finally {
    await closeFixture(
      electronApp,
      prepared.userDataDir,
      prepared.fixture.runtimeDir,
    );
  }
});
