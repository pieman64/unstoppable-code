// CAN-4551 (7a): a chat automation converted into an automation that runs a
// pipeline it owns sends the same chat as the native action. Each case seeds
// the native automation and its converted twin (`fixtures/converted-chat-
// automations.json`, the converter's own output, checked by the main-side
// parity test), runs both with Run now, and compares what each run left:
// one chat per new task, the same message, title line, automation banner and
// chat settings.
//
// Offline: the staged fake Codex app-server answers at once; no network.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeFixture, createFixture } from './codexPipelineRuntime.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedCoworkWorkspace,
  seedStoredPipeline,
  seedWorktreeChat,
} from './seeders/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  readFileSync(
    path.join(here, 'fixtures', 'converted-chat-automations.json'),
    'utf8',
  ),
);
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const COWORK_ID = 'automation-cowork';
const REPLY = 'Done: nothing else to report.';

function automation(id, name, action, extra = {}) {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2099-06-01T15:00:00.000Z',
      timezone: 'local',
    },
    action,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    failureCount: 0,
    ...extra,
  };
}

/** The native automation and its converted twin, under the same name. */
function seedPair(userDataDir, key) {
  const { activity, pipeline, inputs } = CASES[key];
  const pipelineId = `converted-${key}`;
  seedStoredPipeline({
    userDataDir,
    id: pipelineId,
    name: pipeline.name,
    yaml: JSON.stringify({ pipeline }),
  });
  return [
    automation(`native-${key}`, activity.name, activity.action),
    automation(
      `converted-${key}`,
      activity.name,
      {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId,
        pipelineSource: 'user',
        pipelineName: pipeline.name,
        inputs,
      },
      { executionContext: 'personal' },
    ),
  ];
}

function readRun(userDataDir, activityId) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  ).recentRuns?.find((run) => run.activityId === activityId);
}

function readExecution(userDataDir, executionId) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'pipeline-executions', `${executionId}.json`),
      'utf8',
    ),
  );
}

/** Run now from the Library; returns the run once it records a chat. */
async function runNow(app, userDataDir, activityId, chatField) {
  await app.openAutomationsPage();
  await app
    .workflowsLibraryAutomationRow(activityId)
    .getByTestId('workflows-library-run')
    .click();
  let run;
  await expect
    .poll(
      () => {
        run = readRun(userDataDir, activityId);
        return run?.status === 'success' && run.result?.[chatField];
      },
      { timeout: 90_000 },
    )
    .toBeTruthy();
  return run.result;
}

/** A converted run's execution, once it has ended. */
async function endedExecution(userDataDir, executionId) {
  let state;
  await expect
    .poll(
      () => {
        state = readExecution(userDataDir, executionId);
        return state.status;
      },
      { timeout: 90_000 },
    )
    .toBe('success');
  return state;
}

async function canonicalChatTabs(window, projectId, worktreeId) {
  const file = await window.evaluate(
    async (target) => {
      const metadata = await window.api.chat.loadTabs(target);
      return {
        ...metadata,
        tabs: await Promise.all(
          metadata.tabs.map(async (tab) => {
            if (tab.kind === 'file') return tab;
            const transcript = await window.api.chat.getTranscriptPage({
              ...target,
              chatId: tab.id,
            });
            return { ...tab, messages: transcript.messages };
          }),
        ),
      };
    },
    { projectId, worktreeId },
  );
  return file.tabs.filter((tab) => (tab.kind ?? 'chat') === 'chat');
}

/** What the run's message looks like, without its IDs. */
function sentFacts(tab, name) {
  const messages = tab?.messages ?? [];
  const sent = messages.find(
    (message) => message.role === 'user' && message.agentSent !== undefined,
  );
  return {
    text: (sent?.blocks ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    title: sent?.agentSent?.chatTitle,
    sender: sent?.agentSent?.sender?.kind,
    fromAutomation: sent?.agentSent?.sender?.automationId !== undefined,
    banners: messages.filter((message) =>
      message.blocks?.some(
        (block) =>
          block.type === 'automation_info' && block.activityName === name,
      ),
    ).length,
    model: tab?.model,
    providerType: tab?.providerType,
  };
}

async function launch(userDataDir, fixture) {
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  return { electronApp, window, app };
}

test.describe.configure({ mode: 'serial' });

test('a converted Cowork prompt sends the same chat as the native one', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-cowork-'));
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_ID,
    name: 'Team notes',
    collapsed: false,
  });
  mkdirSync(path.join(userDataDir, 'workspaces', COWORK_ID, 'home'), {
    recursive: true,
  });
  seedAutomations({ userDataDir, activities: seedPair(userDataDir, 'cowork') });
  const fixture = createFixture('completed', REPLY);
  const { electronApp, window, app } = await launch(userDataDir, fixture);
  try {
    const name = CASES.cowork.activity.name;
    const native = await runNow(
      app,
      userDataDir,
      'native-cowork',
      'standaloneChatId',
    );
    const converted = await runNow(
      app,
      userDataDir,
      'converted-cowork',
      'standaloneChatId',
    );
    const execution = await endedExecution(
      userDataDir,
      converted.pipelineExecutionId,
    );
    const convertedEntry = execution.jobs.chat.steps.entry.outputs.task_id;
    // A new Work Entry's founding chat shares its ID on the native path.
    const nativeTabs = await canonicalChatTabs(
      window,
      COWORK_ID,
      native.standaloneChatId,
    );
    const convertedTabs = await canonicalChatTabs(
      window,
      COWORK_ID,
      convertedEntry,
    );
    // One chat per created entry, carrying the settings.
    expect(nativeTabs).toHaveLength(1);
    expect(convertedTabs).toHaveLength(1);
    expect(convertedTabs[0].id).toBe(converted.standaloneChatId);
    expect(sentFacts(convertedTabs[0], name)).toEqual(
      sentFacts(nativeTabs[0], name),
    );
    expect(sentFacts(nativeTabs[0], name)).toMatchObject({
      title: name,
      fromAutomation: true,
      banners: 1,
    });
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a converted Orchestrator prompt sends the same chat as the native one', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-advisor-'));
  seedAutomations({
    userDataDir,
    activities: seedPair(userDataDir, 'orchestrator'),
  });
  const fixture = createFixture('completed', REPLY);
  const { electronApp, window, app } = await launch(userDataDir, fixture);
  try {
    const name = CASES.orchestrator.activity.name;
    // A window the run opens reports its surface hidden headless.
    await app.openAppAdvisorWindow(electronApp);
    const native = await runNow(
      app,
      userDataDir,
      'native-orchestrator',
      'appAdvisorChatId',
    );
    const converted = await runNow(
      app,
      userDataDir,
      'converted-orchestrator',
      'appAdvisorChatId',
    );
    const execution = await endedExecution(
      userDataDir,
      converted.pipelineExecutionId,
    );
    const convertedEntry = execution.jobs.chat.steps.entry.outputs.task_id;
    const nativeTabs = await canonicalChatTabs(
      window,
      'app-advisor',
      native.appAdvisorChatId,
    );
    const convertedTabs = await canonicalChatTabs(
      window,
      'app-advisor',
      convertedEntry,
    );
    expect(nativeTabs).toHaveLength(1);
    expect(convertedTabs).toHaveLength(1);
    expect(sentFacts(convertedTabs[0], name)).toEqual(
      sentFacts(nativeTabs[0], name),
    );
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a converted session prompt sends into the same chat as the native one', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-session-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: 'session-chat',
    tabs: [
      {
        id: 'session-chat',
        title: 'Review',
        messages: [
          {
            id: 'session-history',
            role: 'user',
            timestamp: Date.parse('2026-10-28T12:00:00.000Z'),
            blocks: [{ type: 'text', text: 'Start the review.' }],
          },
        ],
      },
    ],
  });
  seedAutomations({
    userDataDir,
    activities: seedPair(userDataDir, 'session'),
  });
  const fixture = createFixture('completed', REPLY);
  const { electronApp, window, app } = await launch(userDataDir, fixture);
  try {
    const name = CASES.session.activity.name;
    await runNow(app, userDataDir, 'native-session', 'chatId');
    const converted = await runNow(
      app,
      userDataDir,
      'converted-session',
      'chatId',
    );
    await endedExecution(userDataDir, converted.pipelineExecutionId);
    const [tab] = await canonicalChatTabs(window, WORKSPACE_ID, 'demo-main');
    const sent = tab.messages.filter(
      (message) => message.role === 'user' && message.agentSent !== undefined,
    );
    expect(sent).toHaveLength(2);
    const facts = sent.map((message) => ({
      text: message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      title: message.agentSent.chatTitle,
      sender: message.agentSent.sender.kind,
    }));
    expect(facts[1]).toEqual(facts[0]);
    expect(
      tab.messages.filter((message) =>
        message.blocks?.some(
          (block) =>
            block.type === 'automation_info' && block.activityName === name,
        ),
      ),
    ).toHaveLength(2);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a converted worktree prompt starts the same chat in a new worktree', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4551-worktree-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAutomations({
    userDataDir,
    activities: seedPair(userDataDir, 'worktree'),
  });
  const fixture = createFixture('completed', REPLY);
  const { electronApp, window, app } = await launch(userDataDir, fixture);
  try {
    const name = CASES.worktree.activity.name;
    const native = await runNow(app, userDataDir, 'native-worktree', 'chatId');
    const converted = await runNow(
      app,
      userDataDir,
      'converted-worktree',
      'chatId',
    );
    await endedExecution(userDataDir, converted.pipelineExecutionId);
    const nativeTabs = await canonicalChatTabs(
      window,
      WORKSPACE_ID,
      native.worktreeId,
    );
    const convertedTabs = await canonicalChatTabs(
      window,
      WORKSPACE_ID,
      converted.worktreeId,
    );
    expect(nativeTabs).toHaveLength(1);
    expect(convertedTabs).toHaveLength(1);
    expect(sentFacts(convertedTabs[0], name)).toEqual(
      sentFacts(nativeTabs[0], name),
    );
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});
