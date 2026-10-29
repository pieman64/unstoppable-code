import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from '../seeders/fsHelpers.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';

export const SHOW_VISUAL_CHAT_ID = 'show-visual-tool-row';
export const SHOW_VISUAL_TITLE = 'Revenue chart';
export const SHOW_VISUAL_HTML = '<div>RAW_SHOW_VISUAL_HTML_MARKER</div>';

export function buildShowVisualMessages() {
  const timestamp = Date.parse('2026-10-07T12:00:00Z');
  return [
    {
      id: 'visual-user',
      role: 'user',
      timestamp,
      blocks: [{ type: 'text', text: 'Show a chart' }],
    },
    {
      id: 'visual-tool',
      role: 'assistant',
      timestamp: timestamp + 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'toolu-show-visual',
          toolName: 'mcp__canopy__ShowVisual',
          input: JSON.stringify({
            html: SHOW_VISUAL_HTML,
            title: SHOW_VISUAL_TITLE,
            height: 320,
          }),
        },
        {
          type: 'tool_result',
          toolUseId: 'toolu-show-visual',
          toolName: 'mcp__canopy__ShowVisual',
          output:
            'vis_123e4567-e89b-12d3-a456-426614174000 Shown to the user above your reply.',
          isError: false,
        },
      ],
    },
    {
      id: 'visual-timer',
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

export function seedPortalShowVisualChat({ userDataDir }) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: SHOW_VISUAL_CHAT_ID,
        title: 'Show visual row',
        messages: buildShowVisualMessages(),
      },
    ],
  });
}

/** Seeds one Cowork chat holding a completed ShowVisual call. */
export function seedDesktopShowVisualChat(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-10-07T12:00:00Z';
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
    description: 'ShowVisual tool row fixture',
  });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'Visual row fixture.\n');
  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-show-visual',
    tabs: [
      {
        id: 'chat-show-visual',
        title: 'Show visual row',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildShowVisualMessages(),
      },
    ],
  });
}
