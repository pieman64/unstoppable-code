import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const interactiveQuestions = [
  {
    question: 'Continue?',
    options: ['Yes', 'No'],
    control: 'buttons',
    required: true,
  },
  { question: 'Project name', options: [], control: 'text', required: true },
  {
    question: 'Environment',
    options: ['Staging', 'Production'],
    control: 'select',
    required: true,
  },
];

export function seedInteractiveQuestion(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    activeTabId: 'interactive',
    tabs: [
      {
        id: 'interactive',
        title: 'Release details',
        messages: [
          {
            id: 'interactive-message',
            role: 'assistant',
            timestamp: 1788782400000,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'interactive-tool',
                toolName: 'mcp__canopy__AskUserQuestion',
                input: JSON.stringify({ questions: interactiveQuestions }),
              },
            ],
          },
        ],
      },
      // A second tab to switch to, so specs can unmount the question prompt
      // by changing panels.
      { id: 'other', title: 'Other chat', messages: [] },
    ],
    pendingQuestions: [
      {
        requestId: 'interactive-request',
        chatId: 'interactive',
        toolUseId: 'interactive-tool',
        questions: interactiveQuestions,
      },
    ],
  });
}
