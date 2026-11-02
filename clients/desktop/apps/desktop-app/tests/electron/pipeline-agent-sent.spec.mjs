// Pipeline agent-sent titles (CAN-4547, 5a-1).
//
// A project chat holds two messages a pipeline step sent: one from a run an
// automation started, one from a run started directly. Each shows the shared
// title line with the workflow icon and the captured automation or pipeline
// name, survives a window reload from the durable transcript, never
// navigates when clicked, and shows none of the hidden sender note. The
// queued form is covered by the queue mirror's unit test; a real queued send
// gets flow coverage with the send-agent-message step in 5a-2.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'pipeline-sent-chat';
const OTHER_CHAT_ID = 'pipeline-sent-other';
const CREATED_AT = '2026-10-26T12:00:00.000Z';
const AUTOMATION_NAME = 'Morning report';
const PIPELINE_NAME = 'Nightly triage';
const AUTOMATION_TEXT = 'Summarize the overnight failures.';
const PIPELINE_TEXT = 'Triage the new issues.';

function pipelineMessage(id, text, offset, sender, chatTitle) {
  return {
    id,
    role: 'user',
    timestamp: Date.parse(CREATED_AT) + offset,
    userMessageSource: 'agent',
    agentSent: { sender, chatTitle, projectLabel: '' },
    blocks: [{ type: 'text', text }],
  };
}

function seed(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: OTHER_CHAT_ID,
        title: 'Other chat',
        messages: [
          {
            id: 'other-history',
            role: 'user',
            timestamp: Date.parse(CREATED_AT),
            blocks: [{ type: 'text', text: 'Earlier context' }],
          },
        ],
      },
      {
        id: CHAT_ID,
        title: 'Triage',
        messages: [
          pipelineMessage(
            'automation-sent-user',
            AUTOMATION_TEXT,
            0,
            {
              kind: 'pipeline',
              executionId: 'exec-automation',
              pipelineId: 'morning-report',
              stepId: 'notify',
              automationId: 'automation-1',
            },
            AUTOMATION_NAME,
          ),
          {
            id: 'automation-sent-reply',
            role: 'assistant',
            timestamp: Date.parse(CREATED_AT) + 1_000,
            blocks: [{ type: 'text', text: 'Failures summarized.' }],
          },
          pipelineMessage(
            'pipeline-sent-user',
            PIPELINE_TEXT,
            2_000,
            {
              kind: 'pipeline',
              executionId: 'exec-direct',
              pipelineId: 'nightly-triage',
              stepId: 'notify',
            },
            PIPELINE_NAME,
          ),
          {
            id: 'pipeline-sent-reply',
            role: 'assistant',
            timestamp: Date.parse(CREATED_AT) + 3_000,
            blocks: [{ type: 'text', text: 'Issues triaged.' }],
          },
        ],
      },
    ],
  });
}

async function expectPipelineTitles(window) {
  const panel = window.getByTestId('panel-content-chat');
  for (const [text, name] of [
    [AUTOMATION_TEXT, AUTOMATION_NAME],
    [PIPELINE_TEXT, PIPELINE_NAME],
  ]) {
    const bubble = panel
      .locator('[data-role="user"]')
      .filter({ hasText: text });
    const title = bubble.getByTestId('agent-sent-title');
    await expect(title).toHaveText(name, { timeout: 30_000 });
    await expect(title).toHaveAttribute('data-sender', 'pipeline');
    // Never a button: no host opens a run from a chat yet.
    await expect(bubble.getByRole('button', { name })).toHaveCount(0);
    await expect(bubble).not.toContainText('Sent by');
  }
  await expect(panel.getByText('agent-sender-context')).toHaveCount(0);
  await expect(panel.getByText('system_instruction')).toHaveCount(0);
}

test('pipeline sends show the automation or pipeline name and never navigate', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-sent-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seed(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
    ).toBeVisible({ timeout: 30_000 });
    await expectPipelineTitles(window);

    // Clicking the title opens nothing: the chat and window stay put.
    const windows = electronApp.windows().length;
    await window
      .getByTestId('agent-sent-title')
      .filter({ hasText: PIPELINE_NAME })
      .click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
    ).toHaveAttribute('data-active', 'true');
    expect(electronApp.windows()).toHaveLength(windows);

    // The captured title is durable transcript data.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expectPipelineTitles(window);
    const page = await window.evaluate(
      (scope) => window.api.chat.getTranscriptPage(scope),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
    );
    expect(
      page.messages.find((message) => message.id === 'pipeline-sent-user'),
    ).toMatchObject({
      agentSent: {
        sender: { kind: 'pipeline', executionId: 'exec-direct' },
        chatTitle: PIPELINE_NAME,
      },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
