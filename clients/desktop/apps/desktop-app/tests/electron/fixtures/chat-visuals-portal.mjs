import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { seedCoworkWorkspace, seedWorktreeChat } from '../seeders/index.mjs';

export const PORTAL_VISUAL_CHAT_ID = 'portal-visual-chat';
export const PORTAL_VISUAL_COWORK_CHAT_ID = 'portal-visual-cowork-chat';
export const PORTAL_VISUAL_TOOL_USE_ID = 'toolu-portal-visual';
export const PORTAL_VISUAL_RESULT_MESSAGE_ID = 'portal-visual-result';
export const PORTAL_VISUAL_TITLE = 'Portal multi-page chart';

const SCOPE = {
  worktree: {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: PORTAL_VISUAL_CHAT_ID,
  },
  standalone: {
    projectId: 'portal-visual-cowork',
    worktreeId: 'home',
    chatId: PORTAL_VISUAL_COWORK_CHAT_ID,
  },
};

function visualDocument(sizeBytes) {
  const minimum = Math.max(sizeBytes, 384_001);
  const prefix =
    '<!doctype html><html><body><h1>Portal multi-page chart</h1><div id="chart">';
  const suffix = '</div></body></html>';
  return (
    prefix +
    'x'.repeat(Math.max(0, minimum - prefix.length - suffix.length)) +
    suffix
  );
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

/** Seed a promoted, multi-page artifact in a real canonical worktree or Cowork chat. */
export async function seedPortalVisualChat({
  userDataDir,
  scope = 'worktree',
  sizeBytes = 768_100,
}) {
  const target = SCOPE[scope];
  if (!target) throw new Error(`Unsupported visual fixture scope: ${scope}`);
  const timestamp = Date.parse('2026-10-07T12:00:00Z');
  if (scope === 'worktree') {
    seedWorktreeChat({
      userDataDir,
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
      activeTabId: target.chatId,
      providerType: 'codex',
      tabs: [
        {
          id: target.chatId,
          title: 'Portal visual',
          messages: [
            {
              id: 'portal-visual-user',
              role: 'user',
              timestamp,
              blocks: [{ type: 'text', text: 'Show a chart' }],
            },
          ],
        },
      ],
    });
  } else {
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: target.projectId,
      chatId: target.chatId,
      chatTitle: 'Portal visual Cowork',
    });
  }
  const html = visualDocument(sizeBytes);
  const bytes = Buffer.from(html, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reference = {
    version: 1,
    visualId: 'vis_123e4567-e89b-42d3-a456-426614174099',
    artifactId: `sha256-v1-${sha256}`,
    byteLength: bytes.length,
    sha256,
    mediaType: 'text/html',
    title: PORTAL_VISUAL_TITLE,
    maxHeight: 720,
    heights: [[800, 400]],
  };
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = userDataDir;
  const { require: tsRequire, register } = await import('tsx/cjs/api');
  const unregister = register();
  try {
    createRequire(import.meta.url)(
      '../../../src/main/agents/delegation/recovery.ts',
    );
    const { ChatStateV2Repository } = tsRequire(
      '../../../src/main/services/chat-state-v2-repository.ts',
      import.meta.url,
    );
    const root = join(userDataDir, 'workspaces', target.projectId);
    const repository = new ChatStateV2Repository({
      resolvePaths: () => ({
        tabs: join(root, 'chats', `${target.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${target.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${target.worktreeId}.jsonl`),
      }),
    });
    await repository.getState(target);
    await repository.stageVisual(
      target,
      { chatId: target.chatId },
      {
        visualId: reference.visualId,
        html,
        title: reference.title,
        maxHeight: reference.maxHeight,
        heights: reference.heights,
      },
    );
    await repository.transactProviderEventWith(
      target,
      () =>
        [
          {
            id: 'portal-visual-call',
            role: 'assistant',
            timestamp: timestamp + 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: PORTAL_VISUAL_TOOL_USE_ID,
                toolName: 'canopy_show_visual',
                input: JSON.stringify({
                  title: reference.title,
                  html: '<hidden>',
                }),
              },
            ],
          },
          {
            id: PORTAL_VISUAL_RESULT_MESSAGE_ID,
            role: 'assistant',
            timestamp: timestamp + 2,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: PORTAL_VISUAL_TOOL_USE_ID,
                toolName: 'canopy_show_visual',
                output: `${reference.visualId} Shown to the user above your reply.`,
                isError: false,
              },
            ],
          },
          {
            id: 'portal-visual-final',
            role: 'assistant',
            timestamp: timestamp + 3,
            blocks: [{ type: 'text', text: 'Here is the chart.' }],
          },
        ].map((message) => ({
          type: 'message.upserted',
          chatId: target.chatId,
          message,
        })),
      { source: 'provider' },
      { resolveToolKey: () => 'show_visual' },
    );
    const state = await repository.getState(target, {
      chatIds: [target.chatId],
    });
    const promoted = state.tabsFile.tabs
      .find((tab) => tab.id === target.chatId)
      ?.messages.find(
        (message) => message.id === PORTAL_VISUAL_RESULT_MESSAGE_ID,
      )
      ?.blocks.find((block) => block.type === 'tool_result')?.visualRef;
    if (stableJson(promoted) !== stableJson(reference)) {
      throw new Error('Portal visual fixture was not promoted');
    }
    await repository.drainAll();
  } finally {
    unregister();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
  }
  return { ...target, reference, html };
}
