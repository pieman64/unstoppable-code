import type { UsageLimitedSessionItem } from '@canopy/desktop-shared/types';
import {
  interruptedSessionDomId,
  interruptedSessionKey,
  interruptedSessionMetadata,
  interruptedSessionSecondaryMetadata,
} from '../sessionRowModel';

const RESET_MS = Date.parse('2026-07-27T18:13:00.000Z');

const chat = (
  overrides: Partial<UsageLimitedSessionItem & { kind: 'chat' }> = {},
): UsageLimitedSessionItem => ({
  kind: 'chat',
  projectId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat-1',
  provider: 'codex',
  chatTitle: 'Fix login',
  detectedAt: 1,
  resumeReason: 'usage_limit',
  worktreeName: 'main',
  ...overrides,
});

const waiting = {
  state: 'waiting',
  provider: 'codex',
  windowLabel: 'Weekly limit',
  resetMs: RESET_MS,
  displayResetMs: RESET_MS,
} as const;

describe('interruptedSessionMetadata', () => {
  it('describes a ready session', () => {
    expect(
      interruptedSessionMetadata(chat({ provider: 'claude' }), {
        state: 'ready',
      }),
    ).toBe('Claude · Usage limit · Ready now');
  });

  it('names the blocking window and its reset', () => {
    expect(interruptedSessionMetadata(chat(), waiting)).toMatch(
      /^Codex · Weekly limit · Resets .+$/,
    );
  });

  it('keeps other interruption reasons beside the window', () => {
    const pipeline: UsageLimitedSessionItem = {
      kind: 'pipeline',
      executionId: 'exec-1',
      statusReasonIds: ['r1'],
      provider: 'codex',
      pipelineName: 'Release',
      detectedAt: 1,
      resumeReasons: ['app_shutdown', 'usage_limit', 'usage_limit'],
      pausedStepCount: 2,
      modelLabels: ['GPT-5'],
      otherBlockingReasonCount: 0,
    };
    expect(interruptedSessionMetadata(pipeline, waiting)).toMatch(
      /^Codex · Application stopped · Weekly limit · Resets .+$/,
    );
    expect(
      interruptedSessionMetadata(
        chat({ resumeReason: 'authentication' }),
        waiting,
      ),
    ).toMatch(/^Codex · Authentication issue · Weekly limit · Resets /);
    expect(interruptedSessionSecondaryMetadata(pipeline)).toBe(
      'Workflow · 2 paused steps · GPT-5',
    );
  });

  it('keeps the known window reset separate from another unknown reset', () => {
    expect(
      interruptedSessionMetadata(chat(), {
        ...waiting,
        resetMs: undefined,
        hasAdditionalUnknownReset: true,
      }),
    ).toMatch(/^Codex · Weekly limit · Resets .+ · Waiting for another reset$/);
  });

  it('handles unknown resets, missing providers, and ungated origins', () => {
    expect(
      interruptedSessionMetadata(chat(), {
        state: 'waiting',
        provider: 'codex',
        windowLabel: 'Usage limit',
      }),
    ).toBe('Codex · Usage limit · Waiting for reset');
    expect(
      interruptedSessionMetadata(chat({ provider: undefined }), undefined),
    ).toBe('Provider unavailable · Usage limit');
    expect(
      interruptedSessionMetadata(chat({ resumeReason: undefined }), undefined),
    ).toBe('Codex · Usage limit');
  });

  it('retains a neutral label for a future interruption reason', () => {
    const legacy = chat();
    Reflect.set(legacy, 'resumeReason', 'future_reason');
    expect(interruptedSessionMetadata(legacy, undefined)).toBe(
      'Codex · Interruption reason unavailable',
    );
  });

  it('does not invent a usage limit for a pipeline with missing reason metadata', () => {
    expect(
      interruptedSessionMetadata(
        {
          kind: 'pipeline',
          executionId: 'exec',
          statusReasonIds: [],
          pipelineName: 'Pipeline',
          detectedAt: 1,
          pausedStepCount: 1,
          modelLabels: [],
          otherBlockingReasonCount: 0,
        },
        undefined,
      ),
    ).toBe('Provider unavailable · Interruption reason unavailable');
  });
});

describe('interruptedSessionDomId', () => {
  it('derives distinct ids from full keys', () => {
    const chatKey = interruptedSessionKey(chat({ chatId: 'x' }));
    const pipelineKey = interruptedSessionKey({
      kind: 'pipeline',
      executionId: 'x',
      statusReasonIds: [],
    });
    const ids = [
      interruptedSessionDomId('row', chatKey),
      interruptedSessionDomId('row', pipelineKey),
      interruptedSessionDomId('row', 'chat_3a_ws'),
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('interruptedSessionSecondaryMetadata for chats', () => {
  const now = new Date(2026, 9, 26, 19, 0);
  const stoppedAt = new Date(2026, 9, 26, 18, 33);
  const stopped = `Stopped today ${stoppedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  it('joins the last step, stop time, uncommitted state, and a resend', () => {
    expect(
      interruptedSessionSecondaryMetadata(
        chat({
          detectedAt: stoppedAt.getTime(),
          lastStep: { toolName: 'Edit', detail: 'src/api/client.ts' },
          resumePromptKind: 'resend_user_message',
        }),
        { now, uncommittedChanges: true, showEveryResumeEffect: false },
      ),
    ).toBe(
      `Last step: Edit src/api/client.ts · ${stopped} · Uncommitted changes · Re-sends your last message`,
    );
  });

  it.each([
    [
      true,
      `Last step: Edit settings.json (finished) · ${stopped} · Uncommitted changes · Sends "Continue"`,
    ],
    [
      false,
      `Stopped during Edit settings.json (not finished) · ${stopped.slice('Stopped '.length)} · Uncommitted changes · Sends "Continue"`,
    ],
    [
      undefined,
      `Last step: Edit settings.json · ${stopped} · Uncommitted changes · Sends "Continue"`,
    ],
  ])(
    'labels a finished=%s step without repeating the stop verb',
    (finished, line) => {
      expect(
        interruptedSessionSecondaryMetadata(
          chat({
            detectedAt: stoppedAt.getTime(),
            lastStep: {
              toolName: 'Edit',
              detail: 'settings.json',
              ...(finished === undefined ? {} : { finished }),
            },
            resumePromptKind: 'continue',
          }),
          { now, uncommittedChanges: true, showEveryResumeEffect: true },
        ),
      ).toBe(line);
    },
  );

  it('keeps the stop verb when no step says the work stopped', () => {
    expect(
      interruptedSessionSecondaryMetadata(
        chat({
          detectedAt: stoppedAt.getTime(),
          lastStep: { toolName: '', finished: false },
        }),
        { now, showEveryResumeEffect: false },
      ),
    ).toBe(stopped);
  });

  it('shows an unfinished step alone when the stop time is unknown', () => {
    expect(
      interruptedSessionSecondaryMetadata(
        chat({
          detectedAt: 0,
          lastStep: { toolName: 'Bash', finished: false },
        }),
        { now, showEveryResumeEffect: false },
      ),
    ).toBe('Stopped during Bash (not finished)');
  });

  it('never claims a clean or unknown worktree', () => {
    for (const uncommittedChanges of [false, undefined]) {
      expect(
        interruptedSessionSecondaryMetadata(
          chat({
            detectedAt: stoppedAt.getTime(),
            resumePromptKind: 'continue',
          }),
          { now, uncommittedChanges, showEveryResumeEffect: false },
        ),
      ).toBe(stopped);
    }
  });

  it('marks an unavailable message when rows spell out every effect', () => {
    expect(
      interruptedSessionSecondaryMetadata(
        chat({ detectedAt: stoppedAt.getTime() }),
        { now, showEveryResumeEffect: true },
      ),
    ).toBe(`${stopped} · Resume message unavailable`);
  });

  it('falls back to the kind when nothing else is known', () => {
    expect(
      interruptedSessionSecondaryMetadata(chat({ detectedAt: 0 }), {
        now,
        showEveryResumeEffect: false,
      }),
    ).toBe('Chat');
    expect(interruptedSessionSecondaryMetadata(chat())).toBe('Chat');
  });
});
