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

export function seedAsyncInteractiveQuestion(userDataDir) {
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const requestId = 'seeded-claude-async-question';
  const chatId = 't1';
  const question = 'Which scope?';
  const options = ['Focused', 'Full'];
  const chosenOption = 'Full';
  // The answer form records which question each answer belongs to, by the
  // seeded question's id below.
  const answers = [
    { question, questionId: 'scope', selectedOptions: [chosenOption] },
  ];

  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Async scope question',
        interfaceMode: 'canopy',
        model: 'claude-sonnet-4-6',
        messages: [
          {
            id: 't1-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Review this project.' }],
            timestamp: Date.parse('2026-09-08T12:00:00.000Z'),
          },
          {
            id: 't1-assistant-1',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'The project is ready for a focused or full review.',
              },
            ],
            timestamp: Date.parse('2026-09-08T12:00:01.000Z'),
          },
          {
            id: 't1-assistant-async-question',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'Which scope should I use for the review?',
                asyncQuestion: {
                  requestId,
                  questions: [{ title: question, options }],
                },
              },
            ],
            timestamp: Date.parse('2026-09-08T12:00:02.000Z'),
          },
        ],
      },
    ],
    pendingQuestions: [
      {
        delivery: 'async',
        requestId,
        chatId,
        questions: [
          {
            id: 'scope',
            question,
            options,
            multiSelect: false,
          },
        ],
      },
    ],
  });

  return {
    demo,
    requestId,
    chatId,
    question,
    chosenOption,
    answerText: `Q: ${question}\nA: ${chosenOption}`,
    answers,
  };
}
