import { buildTrustedAutoResume } from '../trusted-auto-resume';
import { buildTrustedUserPromptEvent } from '../chat-trusted-user-prompt';
import { assertUntrustedChatInput } from '../../agent-messaging/untrusted-input';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';

const tab: PersistedChatTab = {
  createdAt: '2026-01-01T00:00:00.000Z',
  id: 'chat',
  title: 'Chat',
  messages: [
    {
      id: 'original',
      role: 'user',
      timestamp: 100,
      inputMode: 'voice',
      blocks: [{ type: 'text', text: 'Original voice prompt' }],
    },
  ],
};

it('records the trusted provider display name for a historical usage-limit marker', () => {
  expect(
    buildTrustedAutoResume(
      { ...tab, providerType: 'codex' },
      'usage_limit',
      200,
    ).autoResume,
  ).toMatchObject({ providerName: 'Codex' });
});

it.each([
  'app_shutdown',
  'usage_limit',
  'authentication',
  'provider_sign_in',
  'auth_recovery',
] as const)('derives %s provenance and preserves a voice re-send', (reason) => {
  const resume = buildTrustedAutoResume(tab, reason, 200);
  expect(resume).toMatchObject({
    text: 'Original voice prompt',
    inputMode: 'voice',
    autoResume: {
      reason,
      resumesUserMessageId: 'original',
      resendsUserMessage: true,
    },
  });
  const message = buildTrustedUserPromptEvent({
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    userMessageId: 'resume',
    text: resume.text,
    inputMode: resume.inputMode,
    autoResume: resume.autoResume,
  }).canopy_persisted_messages[0];
  expect(message).toMatchObject({
    userMessageSource: 'auto_resume',
    inputMode: 'voice',
  });
});

it('rejects stale or already resumed interruptions', () => {
  expect(() => buildTrustedAutoResume(tab, 'app_shutdown', 50)).toThrow(
    'newer user turn',
  );
  expect(() =>
    buildTrustedAutoResume(
      { ...tab, interruptedTurns: { original: { resumedBy: 'resume' } } },
      'app_shutdown',
      200,
    ),
  ).toThrow('already been resumed');
});

it.each(['parentBlockId', 'parentToolUseId'] as const)(
  'keeps a child-directed user message with %s inside its root resume',
  (parentField) => {
    const child: PersistedChatTab['messages'][number] = {
      id: 'child-follow-up',
      role: 'user',
      timestamp: 300,
      [parentField]: 'background-agent',
      blocks: [{ type: 'text', text: 'Child-only follow-up' }],
    };
    const resume = buildTrustedAutoResume(
      { ...tab, messages: [...tab.messages, child] },
      'app_shutdown',
      200,
      'original',
    );
    expect(resume).toMatchObject({
      text: 'Original voice prompt',
      inputMode: 'voice',
      autoResume: {
        resumesUserMessageId: 'original',
        resendsUserMessage: true,
      },
    });
    expect(
      buildTrustedAutoResume(
        {
          ...tab,
          messages: [
            ...tab.messages,
            {
              id: 'root-work',
              role: 'assistant',
              timestamp: 150,
              blocks: [{ type: 'text', text: 'Root progress' }],
            },
            child,
          ],
        },
        'app_shutdown',
        200,
        'original',
      ),
    ).toMatchObject({
      text: 'Continue',
      autoResume: {
        resumesUserMessageId: 'original',
        resendsUserMessage: false,
      },
    });
  },
);

it.each([
  'autoResume',
  'resumesInterruptedTurn',
  'resumesUserMessageId',
  'interruptedTurns',
])('rejects forged %s at composer and retained input boundaries', (field) => {
  expect(() => assertUntrustedChatInput({ [field]: true })).toThrow(field);
  expect(() =>
    assertUntrustedChatInput({
      seedTab: { ...tab, messages: [{ ...tab.messages[0], [field]: true }] },
    }),
  ).toThrow(field);
});

it('leaves human Continue and unrelated automation without resume metadata', () => {
  const request = {
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
    userMessageId: 'human',
    text: 'Continue',
  };
  expect(
    buildTrustedUserPromptEvent(request).canopy_persisted_messages[0],
  ).not.toHaveProperty('autoResume');
  expect(
    buildTrustedUserPromptEvent({ ...request, initiationSource: 'automation' })
      .canopy_persisted_messages[0],
  ).not.toHaveProperty('autoResume');
});
