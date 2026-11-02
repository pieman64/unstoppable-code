import {
  chatResumeEffectLabel,
  countInterruptedWork,
  formatStoppedAt,
  interruptedWorkReasonSummary as reasonSummary,
  type InterruptedWorkDisplay,
  lastStepLabel,
  resumeConfirmLabel,
  resumeDialogTitle,
  resumeEffectDisclosure,
  shouldShowEveryChatResumeEffect,
  stepLabelSaysStopped,
  type SelectedInterruptedWork,
} from '../interrupted-work-copy';

type ChatSession = Extract<InterruptedWorkDisplay, { kind: 'chat' }> & {
  chatId?: string;
};
type PipelineSession = Extract<InterruptedWorkDisplay, { kind: 'pipeline' }> & {
  executionId?: string;
};

const interruptedWorkReasonSummary = (
  sessions: readonly InterruptedWorkDisplay[],
): string => reasonSummary(sessions, 'Test app');

const chat = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  kind: 'chat',
  worktreeId: 'wt',
  chatId: 'chat-1',
  provider: 'claude',
  resumeReason: 'app_shutdown',
  worktreeName: 'main',
  ...overrides,
});

const pipeline = (
  overrides: Partial<PipelineSession> = {},
): PipelineSession => ({
  kind: 'pipeline',
  executionId: 'exec-1',
  resumeReasons: ['app_shutdown'],
  ...overrides,
});

const inWorktree = (
  session: ChatSession | PipelineSession,
): SelectedInterruptedWork => ({
  session,
  workspaceType: 'single-repo',
});

describe('interrupted work nouns', () => {
  it.each([
    [{ chats: 1, pipelines: 0 }, 'Resume interrupted chat', 'Resume chat'],
    [{ chats: 3, pipelines: 0 }, 'Resume interrupted chats', 'Resume 3 chats'],
    [
      { chats: 0, pipelines: 1 },
      'Resume interrupted workflow',
      'Resume workflow',
    ],
    [
      { chats: 0, pipelines: 2 },
      'Resume interrupted workflows',
      'Resume 2 workflows',
    ],
    [
      { chats: 1, pipelines: 2 },
      'Resume interrupted chats and workflows',
      'Resume 1 chat and 2 workflows',
    ],
    [{ chats: 0, pipelines: 0 }, 'Resume interrupted work', 'Resume'],
  ])('titles %j and labels its confirmation', (counts, title, button) => {
    expect(resumeDialogTitle(counts)).toBe(title);
    expect(resumeConfirmLabel(counts)).toBe(button);
  });

  it('uses a neutral title before anything loads', () => {
    expect(resumeDialogTitle(null)).toBe('Resume interrupted work');
  });

  it('counts listed kinds', () => {
    expect(countInterruptedWork([chat(), pipeline(), chat()])).toEqual({
      chats: 2,
      pipelines: 1,
    });
  });
});

describe('interruptedWorkReasonSummary', () => {
  it('names only the app stop when every entry stopped with the app', () => {
    const text = interruptedWorkReasonSummary([chat()]);
    expect(text).toBe(`Test app closed before this chat finished.`);
    expect(text).not.toMatch(/usage|sign-in|authentication/i);
    expect(
      interruptedWorkReasonSummary([chat(), chat({ chatId: 'chat-2' })]),
    ).toBe(`Test app closed before these chats finished.`);
    expect(interruptedWorkReasonSummary([chat(), pipeline()])).toBe(
      `Test app closed before this work finished.`,
    );
  });

  it('names a usage-limit provider only when every entry shares it', () => {
    const limited = chat({ resumeReason: 'usage_limit' });
    expect(interruptedWorkReasonSummary([limited])).toBe(
      'A Claude usage limit stopped this chat.',
    );
    expect(
      interruptedWorkReasonSummary([
        limited,
        chat({ chatId: 'c2', provider: 'codex', resumeReason: 'usage_limit' }),
      ]),
    ).toBe('A usage limit stopped these chats.');
    expect(
      interruptedWorkReasonSummary([
        pipeline({ resumeReasons: ['usage_limit'], provider: undefined }),
      ]),
    ).toBe('A usage limit stopped this workflow.');
  });

  it('treats legacy chats without a reason as usage limits', () => {
    expect(
      interruptedWorkReasonSummary([chat({ resumeReason: undefined })]),
    ).toBe('A Claude usage limit stopped this chat.');
  });

  it('treats authentication aliases as one sign-in cause', () => {
    expect(
      interruptedWorkReasonSummary([
        chat({ resumeReason: 'authentication' }),
        chat({ chatId: 'c2', resumeReason: 'provider_sign_in' }),
      ]),
    ).toBe('A sign-in problem stopped these chats.');
  });

  it.each(['future_reason', 'constructor', '__proto__'])(
    'keeps an unknown reason neutral (%s)',
    (resumeReason) => {
      expect(interruptedWorkReasonSummary([chat({ resumeReason })])).toBe(
        'Review why this work stopped below.',
      );
    },
  );

  it('omits an unknown provider label', () => {
    expect(
      interruptedWorkReasonSummary([
        chat({ resumeReason: 'usage_limit', provider: 'unknown' }),
      ]),
    ).toBe('A usage limit stopped this chat.');
  });

  it('defers to the rows for several causes or missing pipeline reasons', () => {
    const review = 'Review why this work stopped below.';
    expect(
      interruptedWorkReasonSummary([
        chat(),
        chat({ chatId: 'c2', resumeReason: 'usage_limit' }),
      ]),
    ).toBe(review);
    // One pipeline can carry several reasons; the copy stays grammatical.
    expect(
      interruptedWorkReasonSummary([
        pipeline({ resumeReasons: ['app_shutdown', 'usage_limit'] }),
      ]),
    ).toBe(review);
    expect(
      interruptedWorkReasonSummary([pipeline({ resumeReasons: undefined })]),
    ).toBe(review);
  });
});

describe('resumeEffectDisclosure', () => {
  const cont = chat({ resumePromptKind: 'continue' });
  const resend = chat({
    chatId: 'c2',
    resumePromptKind: 'resend_user_message',
  });

  it('promises nothing without a selection', () => {
    expect(resumeEffectDisclosure([])).toBeNull();
  });

  it('leads with the outcome for one or several chats that send Continue', () => {
    expect(resumeEffectDisclosure([inWorktree(cont)])).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree.`,
    );
    expect(
      resumeEffectDisclosure([
        inWorktree(cont),
        inWorktree({ ...cont, chatId: 'c3' }),
      ]),
    ).toBe(
      `Resuming sends "Continue" in each selected chat, so each agent picks up where it stopped without sending your original requests again. Each agent continues in its chat's worktree.`,
    );
  });

  it('describes resends without exposing the message', () => {
    expect(resumeEffectDisclosure([inWorktree(resend)])).toBe(
      'Resuming re-sends your last message in this chat. The agent continues in the same worktree.',
    );
    expect(
      resumeEffectDisclosure([
        inWorktree(resend),
        inWorktree({ ...resend, chatId: 'c4' }),
      ]),
    ).toMatch(/^Resuming re-sends your last message in each selected chat\./);
  });

  it('points at the rows for mixed messages', () => {
    expect(
      resumeEffectDisclosure([inWorktree(cont), inWorktree(resend)]),
    ).toMatch(
      /^Resuming sends "Continue" or re-sends your last message, as shown for each selected chat\./,
    );
  });

  it('never claims a message that is unavailable', () => {
    expect(resumeEffectDisclosure([inWorktree(chat())])).toBe(
      'Resuming asks the agent to continue in this chat. The agent continues in the same worktree.',
    );
    expect(
      resumeEffectDisclosure([
        inWorktree(cont),
        inWorktree(chat({ chatId: 'c5' })),
      ]),
    ).toBe(
      "Resuming asks the agent to continue in each selected chat. Each agent continues in its chat's worktree.",
    );
  });

  it('makes no worktree claim for cowork, standalone, or mixed workspaces', () => {
    expect(
      resumeEffectDisclosure([{ session: cont, workspaceType: 'cowork' }]),
    ).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.`,
    );
    expect(resumeEffectDisclosure([{ session: cont }])).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.`,
    );
    expect(
      resumeEffectDisclosure([
        inWorktree(cont),
        { session: chat({ ...cont, chatId: 'c6' }), workspaceType: 'cowork' },
      ]),
    ).toBe(
      `Resuming sends "Continue" in each selected chat, so each agent picks up where it stopped without sending your original requests again.`,
    );
  });

  it('omits a worktree promise when its display metadata is unavailable', () => {
    expect(
      resumeEffectDisclosure([inWorktree({ ...cont, worktreeName: '' })]),
    ).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.`,
    );
    expect(
      resumeEffectDisclosure([inWorktree({ ...cont, worktreeName: '  ' })]),
    ).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again.`,
    );
  });

  it('explains pipelines alone and alongside chats', () => {
    expect(resumeEffectDisclosure([{ session: pipeline() }])).toBe(
      'Resuming continues the selected workflow.',
    );
    expect(
      resumeEffectDisclosure([
        { session: pipeline() },
        { session: pipeline({ executionId: 'exec-2' }) },
      ]),
    ).toBe('Resuming continues the selected workflows.');
    expect(
      resumeEffectDisclosure([inWorktree(cont), { session: pipeline() }]),
    ).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree. Resuming continues the selected workflow.`,
    );
    // Workflows never count toward the chat lead-in's plural.
    expect(
      resumeEffectDisclosure([
        { session: cont },
        { session: pipeline() },
        { session: pipeline({ executionId: 'exec-2' }) },
      ]),
    ).toBe(
      `Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. Resuming continues the selected workflows.`,
    );
  });

  it('never says the request is not resent unless every chat sends Continue', () => {
    const noResend = /without sending your original requests? again/;
    const selections: SelectedInterruptedWork[][] = [
      [],
      [{ session: pipeline() }],
      [inWorktree(resend)],
      [inWorktree(cont), inWorktree(resend)],
      [inWorktree(chat())],
      [inWorktree(cont), inWorktree(chat({ chatId: 'c5' }))],
      [inWorktree(resend), { session: pipeline() }],
    ];
    for (const selection of selections) {
      expect(resumeEffectDisclosure(selection) ?? '').not.toMatch(noResend);
    }
  });
});

describe('row resume effect', () => {
  it('always shows a resend and otherwise only when listed chats differ', () => {
    const cont = chat({ resumePromptKind: 'continue' });
    const resend = chat({ resumePromptKind: 'resend_user_message' });
    expect(shouldShowEveryChatResumeEffect([cont, pipeline()])).toBe(false);
    expect(shouldShowEveryChatResumeEffect([cont, resend])).toBe(true);
    expect(shouldShowEveryChatResumeEffect([cont, chat()])).toBe(true);
    expect(chatResumeEffectLabel(cont, false)).toBeNull();
    expect(chatResumeEffectLabel(resend, false)).toBe(
      'Re-sends your last message',
    );
    expect(chatResumeEffectLabel(cont, true)).toBe('Sends "Continue"');
    expect(chatResumeEffectLabel(chat(), true)).toBe(
      'Resume message unavailable',
    );
  });
});

describe('formatStoppedAt', () => {
  const time = (at: Date): string =>
    at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date(2026, 9, 26, 9, 15);

  it('labels today and yesterday by local calendar day', () => {
    const today = new Date(2026, 9, 26, 0, 5);
    const yesterday = new Date(2026, 9, 25, 23, 55);
    expect(formatStoppedAt(today.getTime(), now)).toBe(
      `Stopped today ${time(today)}`,
    );
    expect(formatStoppedAt(yesterday.getTime(), now)).toBe(
      `Stopped yesterday ${time(yesterday)}`,
    );
  });

  it('keeps yesterday across a daylight-saving change', () => {
    // A 23- or 25-hour day never shifts the calendar comparison.
    const afterChange = new Date(2026, 2, 9, 0, 30);
    const beforeChange = new Date(2026, 2, 8, 0, 30);
    expect(formatStoppedAt(beforeChange.getTime(), afterChange)).toBe(
      `Stopped yesterday ${time(beforeChange)}`,
    );
  });

  it('uses a weekday this week, then a date, with the year when it differs', () => {
    const thisWeek = new Date(2026, 9, 21, 18, 33);
    expect(formatStoppedAt(thisWeek.getTime(), now)).toBe(
      `Stopped ${thisWeek.toLocaleDateString([], { weekday: 'short' })} ${time(thisWeek)}`,
    );
    const older = new Date(2026, 8, 3, 18, 33);
    expect(formatStoppedAt(older.getTime(), now)).toBe(
      `Stopped ${older.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time(older)}`,
    );
    const lastYear = new Date(2025, 11, 30, 18, 33);
    expect(formatStoppedAt(lastYear.getTime(), now)).toBe(
      `Stopped ${lastYear.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}, ${time(lastYear)}`,
    );
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 9e15])(
    'omits a missing or invalid time (%s)',
    (detectedAt) => {
      expect(formatStoppedAt(detectedAt, now)).toBeNull();
    },
  );

  it('omits a future time', () => {
    expect(formatStoppedAt(now.getTime() + 60_000, now)).toBeNull();
  });

  it('drops only the verb when asked, for every date form', () => {
    const dates = [
      new Date(2026, 9, 26, 0, 5),
      new Date(2026, 9, 25, 23, 55),
      new Date(2026, 9, 21, 18, 33),
      new Date(2026, 8, 3, 18, 33),
      new Date(2025, 11, 30, 18, 33),
    ];
    for (const at of dates) {
      const full = formatStoppedAt(at.getTime(), now);
      expect(full).toMatch(/^Stopped /);
      expect(formatStoppedAt(at.getTime(), now, { withVerb: true })).toBe(full);
      expect(formatStoppedAt(at.getTime(), now, { withVerb: false })).toBe(
        full?.slice('Stopped '.length),
      );
    }
    expect(formatStoppedAt(undefined, now, { withVerb: false })).toBeNull();
  });
});

describe('lastStepLabel', () => {
  it('shows the tool and its projected detail', () => {
    expect(
      lastStepLabel({ toolName: 'Edit', detail: 'src/api/client.ts' }),
    ).toBe('Last step: Edit src/api/client.ts');
    expect(lastStepLabel({ toolName: 'Bash' })).toBe('Last step: Bash');
    expect(lastStepLabel(undefined)).toBeNull();
  });

  it.each([
    [
      false,
      'settings.json',
      'Stopped during Edit settings.json (not finished)',
    ],
    [false, undefined, 'Stopped during Edit (not finished)'],
    [true, 'settings.json', 'Last step: Edit settings.json (finished)'],
    [true, undefined, 'Last step: Edit (finished)'],
    [undefined, 'settings.json', 'Last step: Edit settings.json'],
    [undefined, undefined, 'Last step: Edit'],
  ])('labels finished=%s with detail %s', (finished, detail, label) => {
    expect(
      lastStepLabel({
        toolName: 'Edit',
        ...(detail ? { detail } : {}),
        ...(finished === undefined ? {} : { finished }),
      }),
    ).toBe(label);
  });

  it('never shows a status without a step', () => {
    expect(lastStepLabel({ toolName: '', finished: false })).toBeNull();
    expect(lastStepLabel({ toolName: '  ', finished: true })).toBeNull();
  });

  it('reports whether the label already says the work stopped', () => {
    expect(
      stepLabelSaysStopped(
        lastStepLabel({ toolName: 'Bash', finished: false }),
      ),
    ).toBe(true);
    expect(
      stepLabelSaysStopped(lastStepLabel({ toolName: 'Bash', finished: true })),
    ).toBe(false);
    expect(stepLabelSaysStopped(lastStepLabel({ toolName: 'Bash' }))).toBe(
      false,
    );
    expect(stepLabelSaysStopped(null)).toBe(false);
  });
});
