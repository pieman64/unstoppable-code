import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  injectChatEvent,
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
  seedWorkspaceApprovals,
} from './seeders/index.mjs';
import {
  seedCreatedFiles,
  CREATED_FILES_CHAT,
} from './createdFilesFixture.mjs';

export const EDIT_WORKSPACE = 'cowork-default';
export const EDIT_ENTRY = 'created-files-entry';
export const EDIT_CHAT = CREATED_FILES_CHAT;

export const FINDINGS_NAME = 'onboarding-findings.md';
export const INITIAL_FINDINGS = '# Findings\n\nSix participants\n';
export const UPDATED_FINDINGS =
  '# Findings\n\nEight participants\n\nP7: Clearer onboarding\n\nP8: More guidance\n';

export function seedAgentEditViewer(userDataDir, providerType = 'claude') {
  const { root: home } = seedCreatedFiles(userDataDir, true, {
    fileNames: [FINDINGS_NAME],
  });
  const filePath = path.join(home, 'outputs', FINDINGS_NAME);
  writeFileSync(filePath, INITIAL_FINDINGS);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: EDIT_WORKSPACE,
    defaultMode: 'full-access',
  });
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    EDIT_WORKSPACE,
    'chats',
    `${EDIT_ENTRY}.json`,
  );
  const chat = JSON.parse(readFileSync(chatPath, 'utf8'));
  if (providerType === 'codex') {
    chat.providerType = 'codex';
    chat.tabs[0].providerType = 'codex';
    chat.tabs[0].model = 'gpt-6-sol';
  }
  const write = chat.tabs[0].messages.find(
    (message) => message.id === 'write-0',
  );
  write.blocks[0].toolName = 'Write';
  write.blocks[0].input = JSON.stringify({
    file_path: filePath,
    content: INITIAL_FINDINGS,
  });
  const result = chat.tabs[0].messages.find(
    (message) => message.id === 'result-0',
  );
  result.blocks[0].toolName = 'Write';
  result.blocks[0].output = `File created successfully at: ${filePath}`;
  const final = chat.tabs[0].messages.find(
    (message) => message.id === 'created-files-final',
  );
  final.blocks.push({
    type: 'text',
    text: `Review [${FINDINGS_NAME}](outputs/${FINDINGS_NAME}).`,
  });
  writeFileSync(chatPath, JSON.stringify(chat));
  return { home, filePath };
}

/** A relative edit and absolute presentation receipt exercise host deduplication. */
export function seedPresentedAgentEdit(userDataDir) {
  const { home } = seedAgentEditViewer(userDataDir);
  const filename = 'review#1?100%.md';
  const relativePath = `outputs/${filename}`;
  const filePath = path.join(home, relativePath);
  writeFileSync(filePath, UPDATED_FINDINGS);
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    EDIT_WORKSPACE,
    'chats',
    `${EDIT_ENTRY}.json`,
  );
  const chat = JSON.parse(readFileSync(chatPath, 'utf8'));
  chat.tabs[0].messages.push(
    {
      id: 'presented-edit-user',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'Revise the findings.' }],
    },
    {
      id: 'presented-edit',
      role: 'assistant',
      timestamp: 101,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'review-edit',
          toolName: 'Edit',
          input: JSON.stringify({
            file_path: relativePath,
            old_string: 'Six',
            new_string: 'Eight',
          }),
        },
      ],
    },
    {
      id: 'presented-edit-result',
      role: 'system',
      timestamp: 102,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'review-edit',
          toolName: 'Edit',
          output: 'Done',
          isError: false,
        },
      ],
    },
    {
      id: 'presented-show',
      role: 'assistant',
      timestamp: 103,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'review-show',
          toolName: 'ShowFiles',
          input: '{}',
        },
      ],
    },
    {
      id: 'presented-show-result',
      role: 'system',
      timestamp: 104,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'review-show',
          toolName: 'ShowFiles',
          output: JSON.stringify({
            files: [{ path: filePath, absolutePath: filePath, ok: true }],
          }),
          isError: false,
        },
      ],
    },
    {
      id: 'presented-final',
      role: 'assistant',
      timestamp: 105,
      blocks: [{ type: 'text', text: 'Revision complete.' }],
    },
    {
      id: 'presented-timer',
      role: 'system',
      timestamp: 106,
      blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: 106 }],
    },
  );
  writeFileSync(chatPath, JSON.stringify(chat));
  return { filePath, filename };
}

/** A vanished absolute Write source must transfer Saved provenance on a relative move. */
export function seedMovedAgentFile(userDataDir) {
  const { home, filePath } = seedAgentEditViewer(userDataDir);
  const filename = 'renamed-findings.md';
  const destination = path.join(home, 'outputs', filename);
  writeFileSync(filePath, UPDATED_FINDINGS);
  renameSync(filePath, destination);
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    EDIT_WORKSPACE,
    'chats',
    `${EDIT_ENTRY}.json`,
  );
  const chat = JSON.parse(readFileSync(chatPath, 'utf8'));
  chat.tabs[0].messages.push(
    {
      id: 'move-user',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'Save and rename the findings.' }],
    },
    {
      id: 'move-write',
      role: 'assistant',
      timestamp: 101,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'move-write',
          toolName: 'Write',
          input: JSON.stringify({
            file_path: filePath,
            content: UPDATED_FINDINGS,
          }),
        },
      ],
    },
    {
      id: 'move-write-result',
      role: 'system',
      timestamp: 102,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'move-write',
          toolName: 'Write',
          output: 'Done',
          isError: false,
        },
      ],
    },
    {
      id: 'move-patch',
      role: 'assistant',
      timestamp: 103,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'move-patch',
          toolName: 'apply_patch',
          input: `*** Update File: outputs/${FINDINGS_NAME}\n*** Move to: outputs/${filename}\n@@\n-old\n+new`,
        },
      ],
    },
    {
      id: 'move-patch-result',
      role: 'system',
      timestamp: 104,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'move-patch',
          toolName: 'apply_patch',
          output: 'Done',
          isError: false,
        },
      ],
    },
    {
      id: 'move-final',
      role: 'assistant',
      timestamp: 105,
      blocks: [{ type: 'text', text: 'CAN4954-MOVE-DONE' }],
    },
    {
      id: 'move-timer',
      role: 'system',
      timestamp: 106,
      blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: 106 }],
    },
  );
  writeFileSync(chatPath, JSON.stringify(chat));
  return { filename, filePath: destination };
}

/** The real bundled Claude SDK executes Read and Edit against mocked inference. */
export async function registerAgentEditScenario(
  filePath,
  marker,
  finalText = `Updated [${FINDINGS_NAME}](outputs/${FINDINGS_NAME}) with P7 and P8 quotes.`,
) {
  const steps = [
    {
      toolCalls: [{ name: 'Read', input: { file_path: filePath } }],
      stopReason: 'tool_use',
    },
    {
      toolCalls: [
        {
          name: 'Edit',
          input: {
            file_path: filePath,
            old_string: INITIAL_FINDINGS,
            new_string: UPDATED_FINDINGS,
          },
        },
      ],
      stopReason: 'tool_use',
    },
    {
      text: finalText,
      stopReason: 'end_turn',
    },
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps, stepsByRequestTag: { findings: steps } },
  });
}

export async function startAgentEditFromDesktop(window, marker) {
  await window.evaluate((request) => window.api.chat.sendMessage(request), {
    projectId: EDIT_WORKSPACE,
    worktreeId: EDIT_ENTRY,
    chatId: EDIT_CHAT,
    userMessageId: 'can4953-live-user',
    text: `[${marker}] [Canopy-Mock-Request:findings] Update the findings from six to eight participants.`,
    providerType: 'claude',
    model: 'opus[1m]',
    approvalMode: 'full-access',
  });
}

export async function completeAgentFileEdit(electronApp, filePath, id) {
  const scope = {
    projectId: EDIT_WORKSPACE,
    worktreeId: EDIT_ENTRY,
    chatId: EDIT_CHAT,
  };
  await injectChatEvent(electronApp, {
    ...scope,
    data: {
      type: 'assistant',
      message: {
        id,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id,
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: 'Six',
              new_string: 'Eight',
            },
          },
        ],
      },
    },
  });
  await injectChatEvent(electronApp, {
    ...scope,
    data: {
      type: 'user',
      message: {
        id: `${id}-result`,
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'Updated',
            is_error: false,
          },
        ],
      },
    },
  });
}
