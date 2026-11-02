import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  computeUsageLimitResumePrompt,
  describeUsageLimitResumePromptKind,
  USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
} from '../usage-limit-resume-prompt';

let messageCounter = 0;
function message(
  role: PersistedChatMessage['role'],
  blocks: PersistedChatMessage['blocks'],
): PersistedChatMessage {
  messageCounter += 1;
  return {
    id: `m-${messageCounter}`,
    role,
    blocks,
    timestamp: messageCounter,
  };
}

function userText(text: string): PersistedChatMessage {
  return message('user', [{ type: 'text', text }]);
}

function turnTimer(): PersistedChatMessage {
  return message('system', [{ type: 'turn_timer', completedAt: 123 }]);
}

describe('computeUsageLimitResumePrompt', () => {
  beforeEach(() => {
    messageCounter = 0;
  });

  it('falls back to Continue when there are no messages', () => {
    expect(computeUsageLimitResumePrompt([])).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('re-sends the user message when the last turn was just a user prompt that hit the limit', () => {
    const messages = [
      userText('First message'),
      message('assistant', [{ type: 'text', text: 'Done.' }]),
      userText('Please refactor the parser'),
      turnTimer(),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'Please refactor the parser',
      resendsUserMessage: true,
    });
  });

  it('re-sends the user message even with no trailing layout messages', () => {
    const messages = [userText('Just this one message')];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'Just this one message',
      resendsUserMessage: true,
    });
  });

  it('uses Continue when the agent produced assistant text before the limit', () => {
    const messages = [
      userText('Do the thing'),
      turnTimer(),
      message('assistant', [{ type: 'text', text: 'Working on it...' }]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('uses Continue when the agent made a tool call before the limit', () => {
    const messages = [
      userText('Do the thing'),
      message('assistant', [
        { type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: '{}' },
      ]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('uses Continue when the agent produced an image before the limit', () => {
    const messages = [
      userText('Generate an image'),
      message('assistant', [
        {
          type: 'image',
          path: '/tmp/generated.png',
          alt: 'Generated image',
        },
      ]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('uses Continue when a tool result system message follows the user message', () => {
    const messages = [
      userText('Do the thing'),
      message('system', [
        {
          type: 'tool_result',
          toolUseId: 't1',
          toolName: 'Read',
          output: 'file contents',
          isError: false,
        },
      ]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('treats empty assistant text as no agent activity and re-sends the user message', () => {
    const messages = [
      userText('Refactor please'),
      message('assistant', [{ type: 'text', text: '   ' }]),
      turnTimer(),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'Refactor please',
      resendsUserMessage: true,
    });
  });

  it('joins multiple text blocks and trims the re-sent user message', () => {
    const messages = [
      message('user', [
        { type: 'file_references', references: [] },
        { type: 'text', text: '  line one' },
        { type: 'text', text: 'line two  ' },
      ]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'line one\nline two',
      resendsUserMessage: true,
    });
  });

  it('preserves file references, attachments, prompt contexts, and input mode when re-sending', () => {
    const fileReference = {
      displayPath: 'src/parser.ts',
      absolutePath: '/repo/src/parser.ts',
    };
    const attachmentPromptContext = {
      attachmentPath: '/tmp/trace.log',
      promptKind: 'in-app-browser-resource' as const,
      sourceUrl: 'https://example.test/trace',
    };
    const messages = [
      message('user', [
        { type: 'file_references', references: [fileReference] },
        { type: 'text', text: 'Use this context' },
      ]),
    ];
    messages[0].attachmentPaths = ['/tmp/trace.log'];
    messages[0].attachmentPromptContexts = [attachmentPromptContext];
    messages[0].inputMode = 'voice';

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'Use this context',
      fileReferences: [fileReference],
      attachmentPaths: ['/tmp/trace.log'],
      attachmentPromptContexts: [attachmentPromptContext],
      inputMode: 'voice',
      resendsUserMessage: true,
    });
  });

  it('falls back to Continue when the last user message has no text to re-send', () => {
    const messages = [
      message('user', [{ type: 'file_references', references: [] }]),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    });
  });

  it('only considers the most recent turn (agent activity in an earlier turn is ignored)', () => {
    const messages = [
      userText('Earlier request'),
      message('assistant', [{ type: 'text', text: 'Handled earlier.' }]),
      userText('Latest request that got rate limited'),
      turnTimer(),
    ];

    expect(computeUsageLimitResumePrompt(messages)).toEqual({
      text: 'Latest request that got rate limited',
      resendsUserMessage: true,
    });
  });
});

describe('describeUsageLimitResumePromptKind', () => {
  it('keeps unavailable, empty and promptless transcripts unknown', () => {
    expect(describeUsageLimitResumePromptKind(undefined)).toBeUndefined();
    expect(describeUsageLimitResumePromptKind([])).toBeUndefined();
    expect(
      describeUsageLimitResumePromptKind([
        message('user', [
          {
            type: 'tool_result',
            toolUseId: 'tool',
            toolName: 'Read',
            output: 'output',
            isError: false,
          },
        ]),
      ]),
    ).toBeUndefined();
    expect(
      describeUsageLimitResumePromptKind([
        message('assistant', [{ type: 'text', text: 'Hello' }]),
      ]),
    ).toBeUndefined();
  });

  it('uses the authoritative policy, including assistant text and empty user text', () => {
    for (const messages of [
      [userText('Continue')],
      [userText('Fix it')],
      [
        userText('Fix it'),
        message('assistant', [{ type: 'text', text: 'Working' }]),
      ],
      [userText('')],
    ]) {
      expect(describeUsageLimitResumePromptKind(messages)).toBe(
        computeUsageLimitResumePrompt(messages).resendsUserMessage
          ? 'resend_user_message'
          : 'continue',
      );
    }
  });
});
