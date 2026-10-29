import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';

export const VISUAL_SCOPE = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};
export const VISUAL_CHAT_ID = 'chat-visuals';
export const VISUAL_RESULT_MESSAGE_ID = 'visual-result';
export const VISUAL_TOOL_USE_ID = 'toolu-visual-demo';
export const VISUAL_TITLE = 'Interactive revenue chart';
export const VISUAL_DOCUMENT = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src *">
<meta http-equiv="refresh" content="0;url=https://example.invalid/refresh-leak">
</head><body>
<main id="chart">Revenue chart <input id="focus-probe" aria-label="Focus probe"></main>
<a id="internal-link" href="#target">Jump within chart</a>
<a id="external-link" href="https://example.com/visual-landing">Open reference</a>
<button id="busy-trigger" onclick="const end=Date.now()+12000;while(Date.now()<end){}">Run busy task</button>
<div style="height:1500px"></div><div id="target">Jump target</div>
</body></html>`;

const bytes = Buffer.from(VISUAL_DOCUMENT, 'utf8');
const sha256 = createHash('sha256').update(bytes).digest('hex');
export const VISUAL_REFERENCE = Object.freeze({
  version: 1,
  visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
  artifactId: `sha256-v1-${sha256}`,
  byteLength: bytes.byteLength,
  sha256,
  mediaType: 'text/html',
  title: VISUAL_TITLE,
  maxHeight: 720,
  heights: [[800, 400]],
});

function stableJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

/** A desktop profile holding one visual chat in a seeded demo worktree. */
export async function seedChatVisuals() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'chat-visuals-'));
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
      },
    }),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Missing seeded visual worktree');
  await seedVisualChat({ userDataDir });
  return { userDataDir, worktreePath };
}

/**
 * Seeds the visual chat into an existing profile: a visual staged and
 * promoted through the trusted provider path.
 */
export async function seedVisualChat({ userDataDir }) {
  const timestamp = Date.parse('2026-10-07T12:00:00Z');
  seedWorktreeChat({
    userDataDir,
    workspaceId: VISUAL_SCOPE.projectId,
    worktreeId: VISUAL_SCOPE.worktreeId,
    activeTabId: VISUAL_CHAT_ID,
    providerType: 'codex',
    tabs: [
      {
        id: VISUAL_CHAT_ID,
        title: 'Chat visuals',
        messages: [
          {
            id: 'visual-user',
            role: 'user',
            timestamp,
            blocks: [{ type: 'text', text: 'Show a revenue chart' }],
          },
        ],
      },
    ],
  });

  // The repository migrates the legacy fixture into canonical chat-storage-v2.
  // Use the same tsx/CJS loading precedent as chat-transcript-storage.spec.mjs.
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
    const root = join(userDataDir, 'workspaces', VISUAL_SCOPE.projectId);
    const repository = new ChatStateV2Repository({
      resolvePaths: () => ({
        tabs: join(root, 'chats', `${VISUAL_SCOPE.worktreeId}.json`),
        archives: join(
          root,
          'chat-archives',
          `${VISUAL_SCOPE.worktreeId}.json`,
        ),
        journal: join(
          root,
          'chat-journals',
          `${VISUAL_SCOPE.worktreeId}.jsonl`,
        ),
      }),
    });
    await repository.getState(VISUAL_SCOPE);
    // Stage, then promote through the trusted provider-event path, exactly as
    // a ShowVisual call does; the result row then owns a real visualRef.
    await repository.stageVisual(
      VISUAL_SCOPE,
      { chatId: VISUAL_CHAT_ID },
      {
        visualId: VISUAL_REFERENCE.visualId,
        html: VISUAL_DOCUMENT,
        title: VISUAL_TITLE,
        maxHeight: VISUAL_REFERENCE.maxHeight,
        heights: VISUAL_REFERENCE.heights,
      },
    );
    await repository.transactProviderEventWith(
      VISUAL_SCOPE,
      () =>
        [
          {
            id: 'visual-call',
            role: 'assistant',
            timestamp: timestamp + 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: VISUAL_TOOL_USE_ID,
                toolName: 'canopy_show_visual',
                input: JSON.stringify({
                  title: VISUAL_TITLE,
                  html: '<hidden>',
                }),
              },
            ],
          },
          {
            id: VISUAL_RESULT_MESSAGE_ID,
            role: 'assistant',
            timestamp: timestamp + 2,
            blocks: [
              {
                type: 'tool_result',
                toolUseId: VISUAL_TOOL_USE_ID,
                toolName: 'canopy_show_visual',
                output: `${VISUAL_REFERENCE.visualId} Shown to the user above your reply.`,
                isError: false,
              },
            ],
          },
          {
            id: 'visual-final',
            role: 'assistant',
            timestamp: timestamp + 3,
            blocks: [{ type: 'text', text: 'Here is the chart.' }],
          },
          {
            id: 'visual-timer',
            role: 'system',
            timestamp: timestamp + 4,
            blocks: [
              {
                type: 'turn_timer',
                startedAt: timestamp,
                completedAt: timestamp + 4,
              },
            ],
          },
        ].map((message) => ({
          type: 'message.upserted',
          chatId: VISUAL_CHAT_ID,
          message,
        })),
      { source: 'provider' },
      { resolveToolKey: () => 'show_visual' },
    );
    const state = await repository.getState(VISUAL_SCOPE, {
      chatIds: [VISUAL_CHAT_ID],
    });
    const promoted = state.tabsFile.tabs
      .find((tab) => tab.id === VISUAL_CHAT_ID)
      ?.messages.find((message) => message.id === VISUAL_RESULT_MESSAGE_ID)
      ?.blocks.find((block) => block.type === 'tool_result')?.visualRef;
    if (stableJson(promoted) !== stableJson(VISUAL_REFERENCE))
      throw new Error(
        `Fixture visual was not promoted as expected: ${JSON.stringify(promoted)}`,
      );
    await repository.drainAll();
  } finally {
    unregister();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
  }
}
