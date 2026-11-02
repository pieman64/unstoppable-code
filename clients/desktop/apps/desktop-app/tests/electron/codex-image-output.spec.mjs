// ---------------------------------------------------------------------------
// Codex image output — live normalized event, persistence, and relaunch.
//
// Reproduces the image-generation flow without a live model or network:
// seed a Codex chat, inject the normalized image-generation completion emitted
// by the app-server adapter, assert the image renders through file-preview IPC,
// then relaunch against the same user data to verify the durable image block.
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  createFixture,
  conversationRequests,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'codex-image-output-chat';
const IMAGE_ALT = 'A luminous tree above a midnight ocean';
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg==';

function seedChat(userDataDir) {
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Generated artwork',
        messages: [
          {
            id: 'image-request',
            role: 'user',
            blocks: [{ type: 'text', text: 'Make me a work of art.' }],
            timestamp: Date.parse('2026-09-04T19:10:52.224Z'),
          },
        ],
      },
    ],
  });
  return summary;
}

function protocolServerMessages(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.direction === 'server')
    .map((entry) => entry.message);
}

async function openChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  // Inspect individual steps while retaining the Clean chat look.
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
  await expect(
    window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    ),
  ).toBeVisible();
  return window;
}

test('generated Codex images render, persist, and restore after relaunch', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-image-output-'),
  );
  const imagePath = path.join(
    userDataDir,
    'provider-state',
    'codex',
    'generated_images',
    'art.png',
  );
  mkdirSync(path.dirname(imagePath), { recursive: true });
  writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  seedChat(userDataDir);

  // Keep canonical-home discovery deterministic without bypassing the real
  // file-preview authorization/read path or starting a native SQLite runtime.
  const fixture = createFixture('success');
  const env = {
    ...fixture.env,
    CANOPY_E2E_CODEX_CANONICAL_HOME: path.join(
      userDataDir,
      'provider-state',
      'codex',
    ),
  };
  let launched = await launchCanopy({ userDataDir, env });
  try {
    let window = await openChat(launched.electronApp);
    const imageContent = await window.evaluate(
      (absolutePath) =>
        window.api.readFileContent({
          absolutePath,
          allowedRoot: 'codex-generated-images',
        }),
      imagePath,
    );
    expect(imageContent.kind).toBe('image');
    expect(imageContent.content).toBe(
      `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
    );
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.started',
          thread_id: 'image-thread',
          turn_id: 'image-turn',
        },
      },
    });
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          thread_id: 'image-thread',
          turn_id: 'image-turn',
          item: {
            id: 'generated-image-1',
            type: 'image_generation',
            status: 'completed',
            revised_prompt: IMAGE_ALT,
            saved_path: imagePath,
          },
        },
      },
    });

    let image = window.getByTestId('chat-generated-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', IMAGE_ALT);
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(image).toHaveJSProperty('naturalWidth', 1);

    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.completed',
          thread_id: 'image-thread',
          turn_id: 'image-turn',
        },
      },
    });

    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir, env });
    window = await openChat(launched.electronApp);
    image = window.getByTestId('chat-generated-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', IMAGE_ALT);
    await expect(image).toHaveJSProperty('naturalWidth', 1);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('Codex report links open local files and mixed tool output stays visible', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-output-links-'),
  );
  const summary = seedChat(userDataDir);
  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await openChat(launched.electronApp);
    const reportPath = path.join(
      summary.workspaces[0].worktreePath,
      'codex-evidence.md',
    );
    writeFileSync(
      reportPath,
      '# Verified evidence\n\nThe file panel opened the actual report.\n',
    );
    for (const item of [
      {
        id: 'report',
        type: 'agent_message',
        text: `[Fixes, evidence, and remaining checks](${reportPath}:3)`,
        phase: 'final_answer',
      },
      {
        id: 'tool-image',
        type: 'dynamic_tool_call',
        tool: 'preview',
        status: 'completed',
        success: true,
        content_items: [
          { type: 'inputText', text: 'Preview is ready' },
          {
            type: 'inputImage',
            imageUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
          },
          ...Array.from({ length: 148 }, (_, index) => ({
            type: 'inputText',
            text: `extra-${String(index)}`,
          })),
        ],
      },
      {
        id: 'standalone',
        type: 'function_call_output',
        name: 'tests',
        output:
          '42 passed\n\n![Untrusted tool image](https://attacker.invalid/tool-output)',
      },
      {
        id: 'bounded-output',
        type: 'mcp_tool_call',
        server: 'evidence',
        tool: 'bounded-output',
        status: 'completed',
        arguments: {},
        result: {
          content: Array.from({ length: 150 }, (_, index) => ({
            type: 'text',
            text: index === 0 ? 'Evidence output' : '',
          })),
        },
        error: null,
      },
      { id: 'review', type: 'entered_review_mode', review: 'current changes' },
      {
        id: 'activity',
        type: 'sub_agent_activity',
        kind: 'completed',
        agent_path: '/root/tests',
      },
      {
        id: 'question',
        type: 'agent_message',
        text: '',
        delivery: 'async',
        questions: [
          {
            title: 'Which scope?',
            options: [
              'Focused',
              'Full',
              ...Array.from(
                { length: 19 },
                (_, index) => `Extra ${String(index + 1)}`,
              ),
            ],
          },
          { title: 'Second question?', options: [] },
          { title: 'Third question?', options: [] },
          { title: 'Fourth question?', options: [] },
        ],
      },
    ]) {
      await injectChatEvent(launched.electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        data: { type: 'codex', event: { type: 'item.completed', item } },
      });
    }
    await expect(
      window.getByText('Tool output (tests)', { exact: false }),
    ).toBeVisible();
    const boundedOutputCard = window.locator(
      '[data-testid="chat-tool-call"][data-tool-name="mcp__evidence__bounded-output"]',
    );
    await boundedOutputCard.getByRole('button').click();
    // #5296 stores the full approved MCP result; the old 100-item cut is gone.
    await expect(boundedOutputCard).toContainText('Evidence output');
    await expect(
      window.getByText(/additional content items omitted/),
    ).toHaveCount(0);
    await expect(window.getByTestId('chat-verbatim-text')).toContainText(
      '![Untrusted tool image](https://attacker.invalid/tool-output)',
    );
    await expect(window.locator('img[alt="Untrusted tool image"]')).toHaveCount(
      0,
    );
    await expect(
      window.getByText('Review started: current changes'),
    ).toBeVisible();
    await expect(window.getByText('Agent /root/tests: completed')).toHaveCount(
      0,
    );
    await expect(
      window
        .getByTestId('chat-question-prompt')
        .getByRole('button', { name: 'Extra 19', exact: true }),
    ).toHaveCount(1);
    // The card shows one question per step; all four are steps of it.
    await expect(
      window
        .getByTestId('chat-question-prompt')
        .getByRole('listitem', { name: 'Question 4 of 4', exact: true }),
    ).toHaveCount(1);
    await expect(window.getByText('Which scope?')).toBeVisible();
    await expect(window.getByTestId('chat-generated-image')).toHaveJSProperty(
      'naturalWidth',
      1,
    );
    await expect(
      window.getByText('Fixes, evidence, and remaining checks', {
        exact: true,
      }),
    ).toBeVisible();
    // A workspace file path opens through the file viewer, without becoming
    // a navigable URL in the transcript.
    const reportLink = window
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'Fixes, evidence, and remaining checks' });
    await expect(reportLink).toBeVisible();
    await expect(reportLink).toHaveAttribute('title', `${reportPath}:3`);
    expect(await reportLink.getAttribute('href')).toBeNull();
    await reportLink.click();
    await expect(
      window.locator(
        '[data-testid^="panel-tab-panel-file-"]:not([data-testid="panel-tab-panel-file-explorer"])',
      ),
    ).toContainText('codex-evidence.md');
    await expect(
      window.getByText('The file panel opened the actual report.'),
    ).toBeVisible();
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    window = await openChat(launched.electronApp);
    await expect(window.getByTestId('chat-generated-image')).toHaveJSProperty(
      'naturalWidth',
      1,
    );
    await expect(
      window.getByText('Tool output (tests)', { exact: false }),
    ).toBeVisible();
    await window
      .locator(
        '[data-testid="chat-tool-call"][data-tool-name="mcp__evidence__bounded-output"]',
      )
      .getByRole('button')
      .click();
    await expect(
      window.locator(
        '[data-testid="chat-tool-call"][data-tool-name="mcp__evidence__bounded-output"]',
      ),
    ).toContainText('Evidence output');
    await expect(
      window.getByText(/additional content items omitted/),
    ).toHaveCount(0);
    await expect(window.getByTestId('chat-verbatim-text')).toContainText(
      '![Untrusted tool image](https://attacker.invalid/tool-output)',
    );
    await expect(window.locator('img[alt="Untrusted tool image"]')).toHaveCount(
      0,
    );
    await expect(
      window
        .getByTestId('chat-question-prompt')
        .getByRole('button', { name: 'Extra 19', exact: true }),
    ).toHaveCount(1);
    await expect(
      window
        .getByTestId('chat-question-prompt')
        .getByRole('listitem', { name: 'Question 4 of 4', exact: true }),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

for (const mode of [
  'async-question-active',
  'async-question-idle',
  'async-question-freeform',
  'async-question-race',
]) {
  test(`Codex async questions reuse the question card and answer once (${mode})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-async-question-'),
    );
    seedChat(userDataDir);
    const fixture = createFixture(mode, 'Answer received.');
    let launched = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      let window = await openChat(launched.electronApp);
      const composer = window.getByRole('textbox').first();
      await composer.fill('Ask an async question');
      await composer.press('Enter');
      let card = window.getByTestId('chat-question-prompt');
      await expect(card).toHaveCount(1);
      await expect(card.getByText('Which scope?', { exact: true })).toHaveCount(
        1,
      );
      // Nothing is chosen ahead of time: an answer acts on click.
      if (mode !== 'async-question-freeform')
        await expect(
          card.getByRole('button', { name: 'Focused', exact: true }),
        ).toBeVisible();
      expect(
        conversationRequests(fixture.logPath).filter(
          (request) => request.method === 'turn/steer',
        ),
      ).toHaveLength(0);
      if (mode === 'async-question-idle') {
        await expect(
          window.getByText('Answer received.', { exact: true }),
        ).toBeVisible();
        await expect
          .poll(async () => {
            const snapshot = await window.evaluate(
              ({ projectId, worktreeId }) =>
                window.api.chat.getState({ projectId, worktreeId }),
              { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
            );
            return snapshot.runtimeByChatId[CHAT_ID]?.status;
          })
          .toBe('completed');
        await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
        // Close the prompt to keep chatting; the question keeps waiting.
        await window.getByTestId('chat-question-close').click();
        await expect(
          window.getByTestId('chat-input-question-ready-chip'),
        ).toBeVisible();
        await composer.fill('Continue after replay');
        await composer.press('Enter');
        await expect
          .poll(() =>
            conversationRequests(fixture.logPath).some(
              (request) =>
                request.method === 'turn/start' &&
                JSON.stringify(request.params.input).includes(
                  'Continue after replay',
                ),
            ),
          )
          .toBe(true);
        await closeCanopy(launched.electronApp, userDataDir, {
          keepUserData: true,
        });
        launched = await launchCanopy({ userDataDir, env: fixture.env });
        window = await openChat(launched.electronApp);
        card = window.getByTestId('chat-question-prompt');
      }
      // A classic question takes the composer's text as its own answer.
      if (mode === 'async-question-freeform') {
        await card.getByRole('textbox').fill('Only the model switch');
        await card.getByTestId('chat-question-send').click();
      } else
        await card.getByRole('button', { name: 'Full', exact: true }).click();
      await expect(card).toHaveCount(0);
      await expect
        .poll(() =>
          conversationRequests(fixture.logPath)
            .filter(
              (request) =>
                ['turn/start', 'turn/steer'].includes(request.method) &&
                JSON.stringify(request.params.input).includes(
                  'Q: Which scope?',
                ),
            )
            .map((request) => request.method),
        )
        .toEqual(
          mode === 'async-question-race'
            ? ['turn/steer', 'turn/start']
            : [mode === 'async-question-idle' ? 'turn/start' : 'turn/steer'],
        );
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir, env: fixture.env });
      window = await openChat(launched.electronApp);
      await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0);
      await expect(window.getByTestId('answered-questions')).toHaveCount(1);
      await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0);
      const snapshot = await window.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.chat.getState({ projectId, worktreeId }),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      const persisted = snapshot.tabsFile.tabs.find(
        (tab) => tab.id === CHAT_ID,
      );
      expect(persisted).toBeDefined();
      expect(
        new Set(persisted.messages.map((message) => message.id)).size,
      ).toBe(persisted.messages.length);
      expect(
        persisted.messages
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'text' && block.asyncQuestion),
      ).toHaveLength(1);
      expect(
        persisted.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.blocks.some(
              (block) =>
                block.type === 'text' &&
                block.text.startsWith('Q: Which scope?'),
            ),
        ),
      ).toHaveLength(1);
      expect(
        snapshot.tabsFile.pendingQuestions.filter(
          (question) =>
            question.chatId === CHAT_ID && question.delivery === 'async',
        ),
      ).toHaveLength(1);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir).catch(
        () => undefined,
      );
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fixture.runtimeDir, { recursive: true, force: true });
    }
  });
}

for (const idle of [false, true]) {
  test(`Codex async submission timeline preserves timer ownership (${idle ? 'idle' : 'active'})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-answer-timeline-'),
    );
    seedChat(userDataDir);
    const fixture = createFixture(
      idle ? 'async-question-idle' : 'async-question-timeline-active',
      'Answer received.',
    );
    let launched = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      let window = await openChat(launched.electronApp);
      const readState = () =>
        window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
      await window.getByRole('textbox').first().fill('Ask an async question');
      await window.getByRole('textbox').first().press('Enter');
      const card = window.getByTestId('chat-question-prompt');
      await expect(card).toBeVisible();
      await expect(
        window.getByText('Continuing work before your answer.', {
          exact: true,
        }),
      ).toBeVisible();
      if (idle)
        await expect
          .poll(
            async () => (await readState()).runtimeByChatId[CHAT_ID]?.status,
          )
          .toBe('completed');
      else {
        // Mid-turn, the question owns the row until it is closed, with or
        // without early access.
        const stop = window.getByTestId('chat-stop-generation');
        for (const earlyAccess of [false, true]) {
          await window.evaluate(
            (enabled) =>
              window.api.experiments.setChoice({
                experimentId: 'early-access',
                enabled,
              }),
            earlyAccess,
          );
          await expect(stop).toHaveCount(0);
        }
        await window.getByTestId('chat-question-close').click();
        await expect(stop).toBeVisible();
        await window.getByTestId('chat-input-question-ready-chip').click();
        await expect(card).toBeVisible();
        await expect(stop).toHaveCount(0);
      }
      const before = await readState();
      const beforeTimers = before.tabsFile.tabs
        .find((tab) => tab.id === CHAT_ID)
        .messages.flatMap((m) => m.blocks)
        .filter((b) => b.type === 'turn_timer');
      expect(beforeTimers).toHaveLength(1);
      await card.getByRole('button', { name: 'Full', exact: true }).click();
      await expect
        .poll(() =>
          conversationRequests(fixture.logPath)
            .filter(
              (request) =>
                ['turn/start', 'turn/steer'].includes(request.method) &&
                JSON.stringify(request.params.input).includes(
                  'Q: Which scope?',
                ),
            )
            .map((request) => request.method),
        )
        .toEqual([idle ? 'turn/start' : 'turn/steer']);
      if (!idle) {
        const during = await readState();
        expect(during.runtimeByChatId[CHAT_ID].activeTurn).toEqual(
          before.runtimeByChatId[CHAT_ID].activeTurn,
        );
        expect(
          during.tabsFile.tabs
            .find((tab) => tab.id === CHAT_ID)
            .messages.flatMap((m) => m.blocks)
            .filter((b) => b.type === 'turn_timer'),
        ).toEqual(beforeTimers);
        writeFileSync(fixture.releasePath, 'complete');
      }
      await expect(
        window.getByText('Answer received.', { exact: true }),
      ).toHaveCount(idle ? 2 : 1);
      await expect
        .poll(async () => (await readState()).runtimeByChatId[CHAT_ID]?.status)
        .toBe('completed');
      const assertTimeline = async () => {
        await expect
          .soft(window.getByTestId('chat-question-prompt'))
          .toHaveCount(0);
        await expect
          .soft(window.getByTestId('answered-questions'))
          .toHaveCount(1);
        await expect
          .soft(
            window
              .getByTestId('chat-tool-call')
              .filter({ hasText: 'Asked you' }),
          )
          .toHaveCount(0);
        await expect
          .soft(window.getByTestId('answered-questions'))
          .toContainText('Full');
        await expect
          .soft(
            window
              .locator('[data-role="user"]')
              .filter({ hasText: 'Q: Which scope?' }),
          )
          .toHaveCount(0);
        const answer = await window
          .getByTestId('answered-questions')
          .boundingBox();
        const progress = await window
          .getByText('Continuing work before your answer.', { exact: true })
          .boundingBox();
        const final = await window
          .getByText('Answer received.', { exact: true })
          .last()
          .boundingBox();
        const timer = await window
          .getByTestId('turn-timer')
          .last()
          .boundingBox();
        expect.soft(answer?.y).toBeGreaterThan(progress.y);
        expect.soft(timer?.y).toBeGreaterThan(final.y);
        await expect
          .soft(window.getByTestId('turn-timer'))
          .toHaveCount(idle ? 2 : 1);
      };
      await assertTimeline();
      const after = await readState();
      const messages = after.tabsFile.tabs.find(
        (tab) => tab.id === CHAT_ID,
      ).messages;
      const timers = messages
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'turn_timer');
      expect(timers).toHaveLength(idle ? 2 : 1);
      expect(timers[0].startedAt).toBe(beforeTimers[0].startedAt);
      expect(timers[0].pausedAt).toBe(beforeTimers[0].pausedAt);
      if (idle) {
        expect(timers[0]).toEqual(beforeTimers[0]);
        expect(timers[1].startedAt).toBeGreaterThanOrEqual(
          timers[0].completedAt,
        );
      }
      const submitted = messages
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text' && b.asyncQuestionAnswer);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].asyncQuestionAnswer.startsTurn).toBe(idle);
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir, env: fixture.env });
      window = await openChat(launched.electronApp);
      await assertTimeline();
    } finally {
      await closeCanopy(launched.electronApp, userDataDir).catch(
        () => undefined,
      );
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fixture.runtimeDir, { recursive: true, force: true });
    }
  });
}

test('a Codex async answer whose steer fails ambiguously is kept once and never resent', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-async-question-retry-'),
  );
  seedChat(userDataDir);
  // The app-server answers the first steer with an error that does not prove
  // the input was refused. Main records the delivery as uncertain and does not
  // send the answer again, because the provider may already have it.
  const fixture = createFixture('async-question-retry', 'Answer received.');
  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await openChat(launched.electronApp);
    const composer = window.getByRole('textbox').first();
    await composer.fill('Ask an async question');
    await composer.press('Enter');
    const card = window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Full', exact: true }).click();
    await expect(card).toHaveCount(0);

    const answerSteers = () =>
      conversationRequests(fixture.logPath).filter(
        (request) =>
          request.method === 'turn/steer' &&
          JSON.stringify(request.params.input).includes('Q: Which scope?'),
      );
    await expect.poll(() => answerSteers().length).toBe(1);
    const readState = () =>
      window.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.chat.getState({ projectId, worktreeId }),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    await expect
      .poll(async () => {
        const tab = (await readState()).tabsFile.tabs.find(
          (candidate) => candidate.id === CHAT_ID,
        );
        return tab?.inputDelivery?.rows.map((row) => row.state);
      })
      .toEqual(['uncertain']);
    await expect(
      window
        .getByTestId('input-delivery-row')
        .filter({ hasText: 'Delivery uncertain' }),
    ).toHaveCount(1);

    // The question stays answered, and nothing sends the answer again.
    const snapshot = await readState();
    expect(
      snapshot.tabsFile.pendingQuestions.filter(
        (question) =>
          question.chatId === CHAT_ID &&
          question.delivery === 'async' &&
          question.answeredAt !== undefined,
      ),
    ).toHaveLength(1);
    await window.waitForTimeout(2_000);
    expect(answerSteers()).toHaveLength(1);
    expect(
      conversationRequests(fixture.logPath).filter(
        (request) =>
          request.method === 'turn/start' &&
          JSON.stringify(request.params.input).includes('Q: Which scope?'),
      ),
    ).toHaveLength(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('canceling or editing a queued async answer reopens its question', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-async-question-queued-'),
  );
  seedChat(userDataDir);
  const fixture = createFixture('async-question-queued', 'Answer received.');
  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await openChat(launched.electronApp);
    const composer = window.getByRole('textbox').first();
    await composer.fill('Ask an async question');
    await composer.press('Enter');
    const card = window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Full', exact: true }).click();

    let bubble = window.getByTestId('queued-message-bubble');
    await expect(bubble).toHaveCount(1);
    await expect(card).toHaveCount(0);
    await bubble.getByTestId('queued-message-more').click();
    await window
      .getByTestId('queued-message-more-menu')
      .getByTestId('queued-message-cancel')
      .click();
    await expect(bubble).toHaveCount(0);
    await expect(
      card.getByRole('button', { name: 'Full', exact: true }),
    ).toBeVisible();

    await card.getByRole('button', { name: 'Full', exact: true }).click();
    bubble = window.getByTestId('queued-message-bubble');
    await expect(bubble).toHaveCount(1);
    await bubble.getByTestId('queued-message-more').click();
    await window
      .getByTestId('queued-message-more-menu')
      .getByTestId('queued-message-edit')
      .click();
    const editor = window.getByTestId('queued-message-editor');
    const editTextBox = editor.getByRole('textbox');
    // Re-deliver the host snapshot mid-edit. It contains the same entry ID
    // but fresh row objects, as happens when the host queue publishes an update.
    await editTextBox.fill('Edited');
    const queueEvent = await window.evaluate(
      async ({ projectId, worktreeId, chatId }) =>
        (
          await window.api.chat.getChatQueueSnapshot({
            projectId,
            worktreeId,
          })
        ).find((event) => event.chatId === chatId),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
    );
    expect(queueEvent).toBeDefined();
    await window.evaluate(
      ({ chatId }) => {
        window.__queuedEditorSnapshotReceived = new Promise((resolve) => {
          const unsubscribe = window.api.chat.onChatQueueUpdated((event) => {
            if (event.chatId !== chatId) return;
            unsubscribe();
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
        });
      },
      { chatId: CHAT_ID },
    );
    await launched.electronApp.evaluate(({ BrowserWindow }, payload) => {
      const browserWindow = BrowserWindow.getAllWindows()[0];
      if (!browserWindow) throw new Error('Expected a browser window');
      browserWindow.webContents.send('chat:queue-updated', payload);
    }, queueEvent);
    await window.evaluate(() => window.__queuedEditorSnapshotReceived);
    await expect(editTextBox).toHaveText('Edited');
    await editTextBox.pressSequentially(' queued answer');
    await expect(editTextBox).toHaveText('Edited queued answer');
    await editor.getByTestId('queued-message-edit-save').click();
    await expect(bubble).toContainText('Edited queued answer');

    // Reopen the queued editor, insert a file reference, and save in the same
    // browser task. Slate mutates its live tree synchronously while React's
    // controlled value is still from the previous render, so this pins both
    // halves of the race: saved text and file-reference metadata must come
    // from the same live snapshot.
    await bubble.getByTestId('queued-message-more').click();
    await window
      .getByTestId('queued-message-more-menu')
      .getByTestId('queued-message-edit')
      .click();
    // Edit opens the editor after the More menu closes, so wait for it to
    // mount. The insert and save below still run in one browser task.
    await expect(
      window.getByTestId('queued-message-editor').getByRole('textbox'),
    ).toBeVisible();
    const raceFilePath = path.join(userDataDir, 'queued-race-file.txt');
    await window.evaluate(
      ({ absolutePath }) => {
        document.dispatchEvent(
          new CustomEvent('canopy:insert-file-reference', {
            detail: {
              displayPath: 'queued-race-file.txt',
              absolutePath,
            },
          }),
        );
        document
          .querySelector('[data-testid="queued-message-edit-save"]')
          ?.click();
      },
      { absolutePath: raceFilePath },
    );
    await expect(bubble).toContainText('queued-race-file.txt');

    await bubble.getByTestId('queued-message-more').click();
    await window
      .getByTestId('queued-message-more-menu')
      .getByTestId('queued-message-edit')
      .click();
    await expect(
      window
        .getByTestId('queued-message-editor')
        .getByTestId('file-reference-pill'),
    ).toHaveCount(1);
    await window
      .getByTestId('queued-message-editor')
      .getByTestId('queued-message-edit-cancel')
      .click();
    await expect(
      card.getByRole('button', { name: 'Full', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('reverting a turn removes its durable async pending question', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-async-question-reset-'),
  );
  const seeded = seedChat(userDataDir);
  const worktreePath = seeded.workspaces[0]?.worktreePath;
  expect(worktreePath).toEqual(expect.any(String));
  const startTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    path.join(worktreePath, 'async-question-reset.txt'),
    'created by the async question turn\n',
    'utf8',
  );
  execFileSync('git', ['add', 'async-question-reset.txt'], {
    cwd: worktreePath,
  });
  const endTree = execFileSync('git', ['write-tree'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
  const fixture = createFixture('async-question-idle', 'Answer received.');
  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await openChat(launched.electronApp);
    const composer = window.getByRole('textbox').first();
    await composer.fill('Ask an async question');
    await composer.press('Enter');
    await expect(window.getByTestId('chat-question-prompt')).toBeVisible();

    const userMessageId = await window.evaluate(
      async ({ projectId, worktreeId, chatId }) => {
        const snapshot = await window.api.chat.getState({
          projectId,
          worktreeId,
        });
        return snapshot.tabsFile.tabs
          .find((tab) => tab.id === chatId)
          ?.messages.find(
            (message) =>
              message.role === 'user' &&
              message.blocks.some(
                (block) =>
                  block.type === 'text' &&
                  block.text === 'Ask an async question',
              ),
          )?.id;
      },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
      },
    );
    expect(userMessageId).toEqual(expect.any(String));
    await expect
      .poll(
        () =>
          protocolServerMessages(fixture.logPath).filter(
            (message) =>
              message.method === 'item/completed' &&
              message.params?.item?.delivery === 'async',
          ).length,
        { timeout: 15_000 },
      )
      .toBe(3);
    // Item delivery can finish before the main process retires the active
    // turn. Revert is a between-turn operation, so cross that canonical
    // lifecycle boundary before injecting and acting on its snapshot.
    await expect
      .poll(async () => {
        const active = await window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.activeSessions({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return (
          active.sessions?.find((session) => session.chatId === CHAT_ID)
            ?.turnActive ?? false
        );
      })
      .toBe(false);
    // Tool completion precedes the host's asynchronous end-of-turn Git capture.
    // Wait for that real diff before injecting the synthetic reset fixture;
    // otherwise its later empty diff can overwrite the fixture's changed file.
    await expect
      .poll(() =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId, userMessageId }) => {
            const snapshot = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return Boolean(
              snapshot.tabsFile.tabs.find((tab) => tab.id === chatId)
                ?.turnDiffs?.[userMessageId],
            );
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: CHAT_ID,
            userMessageId,
          },
        ),
      )
      .toBe(true);
    await injectChatEvent(launched.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'turn_diff',
        userMessageId,
        files: [
          {
            path: 'async-question-reset.txt',
            status: 'added',
            insertions: 1,
            deletions: 0,
          },
        ],
        totalInsertions: 1,
        totalDeletions: 0,
        capturedAt: Date.now(),
        treeRefs: [{ startTree, endTree }],
      },
    });

    // The E2E ingress awaits the durable main-process commit, then broadcasts
    // the event to the renderer. Wait for that second phase before using the
    // newly enabled Revert action.
    await expect(
      window
        .locator('[data-turn-files-title]')
        .filter({ hasText: 'async-question-reset.txt' }),
    ).toBeVisible();

    const resetButton = window.getByTestId('reset-to-point-button');
    await expect(resetButton).toHaveCount(1);
    await resetButton.click({ force: true });
    await window.getByTestId('reset-to-point-confirm-btn').click();
    await expect(window.getByTestId('reset-to-point-dialog')).toHaveCount(0, {
      timeout: 30_000,
    });

    await expect(window.getByTestId('chat-question-prompt')).toHaveCount(0);
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return (snapshot.tabsFile.pendingQuestions ?? []).filter(
          (question) => question.chatId === CHAT_ID,
        ).length;
      })
      .toBe(0);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

for (const action of ['answer', 'dismiss']) {
  test(`unanswered questions survive completed turn collapse (${action})`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-question-collapse-'),
    );
    seedChat(userDataDir);
    const fixture = createFixture(
      'async-question-collapse',
      'Finished checking.',
    );
    const launched = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await openChat(launched.electronApp);
      const composer = window.getByRole('textbox').first();
      await composer.fill('Ask an async question');
      await composer.press('Enter');
      const card = window.getByTestId('chat-question-prompt');
      await expect(card).toBeVisible();
      writeFileSync(fixture.releasePath, 'complete');
      await expect(
        window.getByText('Finished checking.', { exact: true }),
      ).toBeVisible();
      const steps = window
        .getByRole('button', { name: /^Agent steps:/ })
        .last();
      // Clean keeps the live turn open on completion; explicitly fold it to
      // exercise the unanswered-question protection.
      if ((await steps.getAttribute('aria-expanded')) === 'true')
        await steps.click();
      await expect(steps).toHaveAttribute('aria-expanded', 'false');
      await expect(card).toBeVisible();
      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole('button', { name: 'Full', exact: true }),
      ).toBeVisible();
      await steps.click();
      await expect(steps).toHaveAttribute('aria-expanded', 'true');
      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole('button', { name: 'Full', exact: true }),
      ).toBeVisible();
      await steps.click();
      await expect(steps).toHaveAttribute('aria-expanded', 'false');
      await expect(
        card.getByRole('button', { name: 'Full', exact: true }),
      ).toBeVisible();
      if (action === 'answer')
        await card.getByRole('button', { name: 'Full', exact: true }).click();
      else await card.getByTestId('chat-question-skip').click();
      await expect(card).toHaveCount(0);
      if (action === 'answer') {
        await expect(window.getByTestId('answered-questions')).toHaveCount(1);
        await expect
          .poll(
            () =>
              conversationRequests(fixture.logPath).filter(
                (request) => request.method === 'turn/start',
              ).length,
          )
          .toBe(2);
      }
      await steps.click();
      await expect(card).toHaveCount(0);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}
