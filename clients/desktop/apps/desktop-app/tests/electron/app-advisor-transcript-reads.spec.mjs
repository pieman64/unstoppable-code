// App Advisor transcript reads (unified agent transcripts phase 16).
//
// A global App Advisor chat reads project chats' retained delegation
// transcripts through the real `chat.transcript.page` DispatchAction, including
// a chat archived inside its live worktree. Main finds the owning workspace
// itself; the model supplies only the target. A chat no workspace owns is a
// closed `not_found`, and no reply relays a path.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { expandAppAdvisorToFullWindow } from './helpers/appAdvisorFullWindow.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { legacyDelegationMessages } from './seeders/seedDelegationTranscriptLog.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

const ENTRY_ID = 'advisor-transcript-entry';
const ADVISOR_CHAT_ID = 'advisor-transcript-chat';
const PROJECT_CHAT_ID = 'advisor-transcript-owner';
const DELEGATION_ID = 'advisor-transcript-delegate';
const CHILD_TEXT = 'ADVISOR_READ_DELEGATE_FINDING';
const ARCHIVED_CHAT_ID = 'advisor-transcript-archived';
const ARCHIVED_DELEGATION_ID = 'advisor-transcript-archived-delegate';
const ARCHIVED_CHILD_TEXT = 'ADVISOR_READ_ARCHIVED_DELEGATE_FINDING';
const CREATED_AT = '2026-10-16T12:00:00.000Z';
const MARKER = 'Canopy-CADVISORTRANSCRIPTREAD';
const REPLY = 'Read the delegate transcript.';
const dispatch = (action) => ({
  toolCalls: [
    { name: 'mcp__canopy_app_advisor__DispatchAction', input: { action } },
  ],
  stopReason: 'tool_use',
});

function seedAdvisorEntry(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
    },
  });
  const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  mkdirSync(path.join(advisorDir, 'chats'), { recursive: true });
  writeFileSync(
    path.join(advisorDir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [{ id: ENTRY_ID, createdAt: CREATED_AT, title: 'Transcripts' }],
    }),
  );
  // Prior history keeps the seeded title; an empty chat is auto-titled.
  writeFileSync(
    path.join(advisorDir, 'chats', `${ENTRY_ID}.json`),
    JSON.stringify({
      version: 1,
      activeTabId: ADVISOR_CHAT_ID,
      tabs: [
        {
          id: ADVISOR_CHAT_ID,
          title: 'Delegate review',
          createdAt: CREATED_AT,
          providerType: 'claude',
          model: 'sonnet',
          messages: [
            {
              id: 'advisor-history-user',
              role: 'user',
              timestamp: Date.parse(CREATED_AT),
              blocks: [{ type: 'text', text: 'Earlier context' }],
            },
            {
              id: 'advisor-history-reply',
              role: 'assistant',
              timestamp: Date.parse(CREATED_AT) + 1_000,
              blocks: [{ type: 'text', text: 'Noted.' }],
            },
          ],
        },
      ],
    }),
  );
}

const childText = (page) =>
  page.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'text')
    .map((block) => block.text);

test('an App Advisor chat reads live and archived project delegation transcripts and is denied a chat no workspace owns', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-advisor-transcripts-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAdvisorEntry(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: PROJECT_CHAT_ID,
        title: 'Delegating chat',
        messages: legacyDelegationMessages({
          delegationId: DELEGATION_ID,
          childText: CHILD_TEXT,
        }),
      },
      {
        id: ARCHIVED_CHAT_ID,
        title: 'Archived delegating chat',
        messages: [
          // Closing a chat that has a sent message archives it.
          {
            id: 'archived-user',
            role: 'user',
            timestamp: Date.parse(CREATED_AT),
            blocks: [{ type: 'text', text: 'Delegate the audit.' }],
          },
          ...legacyDelegationMessages({
            delegationId: ARCHIVED_DELEGATION_ID,
            childText: ARCHIVED_CHILD_TEXT,
          }),
        ],
      },
    ],
  });
  const target = {
    kind: 'delegation',
    chatId: PROJECT_CHAT_ID,
    delegationId: DELEGATION_ID,
    runGeneration: 1,
  };
  const archivedTarget = {
    kind: 'delegation',
    chatId: ARCHIVED_CHAT_ID,
    delegationId: ARCHIVED_DELEGATION_ID,
    runGeneration: 1,
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        dispatch({ type: 'chat.transcript.page', target }),
        dispatch({ type: 'chat.transcript.page', target: archivedTarget }),
        dispatch({
          type: 'chat.transcript.page',
          target: { ...target, chatId: 'advisor-transcript-missing' },
        }),
        { text: REPLY, stopReason: 'end_turn' },
      ],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await closePanelTab(window, `panel-chat-${ARCHIVED_CHAT_ID}`);
    await expect(window.getByTestId('chat-tab-archive-count')).toHaveText('1');
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await expandAppAdvisorToFullWindow(advisor);
    await advisor.getByTestId(`app-advisor-nav-entry-${ENTRY_ID}`).click();
    const panel = advisor.getByTestId('panel-content-chat');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${MARKER}] Read the delegate's transcript in my project.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(REPLY).first()).toBeVisible({
      timeout: 90_000,
    });

    const page = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      {
        projectId: 'app-advisor',
        worktreeId: ENTRY_ID,
        chatId: ADVISOR_CHAT_ID,
      },
    );
    const outputs = page.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.output);
    expect(outputs).toHaveLength(3);
    const [read, archived, denied] = outputs.map((output) =>
      JSON.parse(output),
    );
    expect(read, outputs[0]).toMatchObject({ ok: true });
    expect(childText(read.result)).toContain(CHILD_TEXT);
    expect(archived, outputs[1]).toMatchObject({ ok: true });
    expect(childText(archived.result)).toContain(ARCHIVED_CHILD_TEXT);
    expect(denied).toMatchObject({ ok: false, error: { code: 'not_found' } });
    for (const output of outputs) expect(output).not.toContain(userDataDir);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
