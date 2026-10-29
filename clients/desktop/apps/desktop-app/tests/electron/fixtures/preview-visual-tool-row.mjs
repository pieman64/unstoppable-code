import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from '../seeders/fsHelpers.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';

export const PREVIEW_VISUAL_CHAT_ID = 'preview-visual-tool-row';
export const PREVIEW_VISUAL_HTML = '<div>RAW_PREVIEW_VISUAL_HTML_MARKER</div>';

/** One completed PreviewVisual call, as it is stored: no screenshot bytes. */
export function buildPreviewVisualMessages() {
  const timestamp = Date.parse('2026-10-08T12:00:00Z');
  return [
    {
      id: 'preview-user',
      role: 'user',
      timestamp,
      blocks: [{ type: 'text', text: 'Check the chart before showing it' }],
    },
    {
      id: 'preview-tool',
      role: 'assistant',
      timestamp: timestamp + 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'toolu-preview-visual',
          toolName: 'mcp__canopy__PreviewVisual',
          input: JSON.stringify({
            html: PREVIEW_VISUAL_HTML,
            width: 520,
            appearance: 'dark',
          }),
        },
        {
          type: 'tool_result',
          toolUseId: 'toolu-preview-visual',
          toolName: 'mcp__canopy__PreviewVisual',
          output:
            'Preview rendered at 520px. Content height: 320px; captured height: 320px.\nPreview screenshot, 18230 bytes, not stored',
          isError: false,
        },
      ],
    },
    {
      id: 'preview-timer',
      role: 'system',
      timestamp: timestamp + 2,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: timestamp,
          completedAt: timestamp + 2,
        },
      ],
    },
  ];
}

export function seedPortalPreviewVisualChat({ userDataDir }) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: PREVIEW_VISUAL_CHAT_ID,
        title: 'Preview visual row',
        messages: buildPreviewVisualMessages(),
      },
    ],
  });
}

/** Seeds one Cowork chat holding a completed PreviewVisual call. */
export function seedDesktopPreviewVisualChat(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-10-08T12:00:00Z';
  const project = {
    id: 'default',
    name: 'Default',
    createdAt,
    color: '#7C9B6D',
    defaultModel: 'gpt-6-luna',
  };
  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [project],
  });
  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    ...project,
    description: 'PreviewVisual tool row fixture',
  });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'Preview row fixture.\n');
  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-preview-visual',
    tabs: [
      {
        id: 'chat-preview-visual',
        title: 'Preview visual row',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildPreviewVisualMessages(),
      },
    ],
  });
}
