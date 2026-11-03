import type { PortalChatPart } from '@canopy/protocol/portal';
import {
  applyComposerRecovery,
  composerRecoveryPortalTranscript,
  composerRecoveryTranscriptHead,
  createComposerRecoveryStore,
  decideComposerRecovery,
  type ComposerRecoveryLiveState,
  type ComposerRecoveryStore,
  type ComposerRecoverySubmission,
  type ComposerRecoveryTranscriptMessage,
} from '../composer-recovery';

type Value = { text: string }[];
type Inputs = { attachments: string[] };

const KEY = 'project/worktree/chat';

function submission(
  overrides: Partial<ComposerRecoverySubmission<Value, Inputs>> = {},
): ComposerRecoverySubmission<Value, Inputs> {
  const captured = {
    userMessageId: 'u2',
    editorValue: [{ text: 'Fix the bug' }],
    reservedInputs: { attachments: [] },
    outboundText: 'Fix the bug',
    priorLastUserMessageId: 'u1',
    composerCleared: true,
    ...overrides,
  };
  return captured;
}

const user = (id: string): ComposerRecoveryTranscriptMessage => ({
  id,
  isUser: true,
  hasAgentActivity: false,
});
const assistant = (
  id: string,
  hasAgentActivity = true,
): ComposerRecoveryTranscriptMessage => ({
  id,
  isUser: false,
  hasAgentActivity,
});

const EMPTY_OCCUPANCY = {
  editorContent: false,
  attachments: false,
  selections: false,
  revertAttachment: false,
  savedDraft: false,
};

function live(
  transcript: ComposerRecoveryTranscriptMessage[] | null,
  overrides: Partial<ComposerRecoveryLiveState> = {},
): ComposerRecoveryLiveState {
  return {
    composerHydrated: true,
    transcript,
    occupancy: EMPTY_OCCUPANCY,
    mode: 'compose',
    ...overrides,
  };
}

// Earlier completed turn, then the refused prompt and its error row.
const REFUSED = [
  user('u1'),
  assistant('a1'),
  user('u2'),
  assistant('err', false),
];

function abortedEntry(
  overrides: Partial<ComposerRecoverySubmission<Value, Inputs>> = {},
): { store: ComposerRecoveryStore<Value, Inputs>; generation: number } {
  const store = createComposerRecoveryStore<Value, Inputs>();
  const generation = store.record(KEY, submission(overrides));
  store.settle(KEY, generation, 'accepted');
  expect(store.recordAbort(KEY, composerRecoveryTranscriptHead(REFUSED))).toBe(
    true,
  );
  return { store, generation };
}

describe('decideComposerRecovery (CAN-5348)', () => {
  it('retains input edits made during asynchronous submission preparation', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const generation = store.beginSubmission(KEY);
    store.noteUserInput(KEY);
    store.record(KEY, submission(), generation);
    store.settle(KEY, generation, 'accepted');
    store.recordAbort(KEY, composerRecoveryTranscriptHead(REFUSED));
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'skip',
      reason: 'user-input',
    });
  });

  it('starts a newer preparation without the older input conflict', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    store.beginSubmission(KEY);
    store.noteUserInput(KEY);
    const generation = store.beginSubmission(KEY);
    store.record(KEY, submission(), generation);
    store.settle(KEY, generation, 'accepted');
    store.recordAbort(KEY, composerRecoveryTranscriptHead(REFUSED));
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'restore',
      generation,
      restoreReservedInputs: true,
    });
  });

  it('restores an accepted, refused submission before any agent work', () => {
    const { store, generation } = abortedEntry();
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'restore',
      generation,
      restoreReservedInputs: true,
    });
  });

  it('restores an attachment-only submission the same way', () => {
    const { store } = abortedEntry({
      editorValue: [{ text: '' }],
      outboundText: '',
      reservedInputs: { attachments: ['/tmp/a.png'] },
    });
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it.each([
    'editorContent',
    'attachments',
    'selections',
    'revertAttachment',
    'savedDraft',
  ] as const)('skips when the composer already holds %s', (field) => {
    const { store } = abortedEntry();
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live(REFUSED, { occupancy: { ...EMPTY_OCCUPANCY, [field]: true } }),
      ),
    ).toEqual({ kind: 'skip', reason: 'composer-occupied' });
  });

  it('skips after the user edited the cleared composer, even if they deleted it again', () => {
    const { store } = abortedEntry();
    store.noteUserInput(KEY);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'skip',
      reason: 'user-input',
    });
  });

  it('skips when the turn produced assistant output or tool activity', () => {
    const { store } = abortedEntry();
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live([...REFUSED, assistant('tool')]),
      ),
    ).toEqual({ kind: 'skip', reason: 'agent-activity' });
  });

  it.each<{ role: 'assistant' | 'system'; part: PortalChatPart }>([
    {
      role: 'assistant',
      part: {
        kind: 'image',
        data: { alt: 'Generated chart', assetId: 'asset-a1-image-1' },
      },
    },
    {
      role: 'assistant',
      part: {
        kind: 'agent',
        data: { toolUseId: 'agent-call', subagentType: 'Explore' },
      },
    },
    {
      role: 'system',
      part: {
        kind: 'tool_use',
        data: {
          toolUseId: 'codex-call',
          toolName: 'mcp__demo__read',
          input: '{}',
        },
      },
    },
    {
      role: 'system',
      part: {
        kind: 'tool_result',
        data: {
          toolUseId: 'codex-call',
          output: 'Completed work',
          isError: false,
        },
      },
    },
  ])(
    'skips after projected $role $part.kind activity even without assistant text',
    ({ role, part }) => {
      const { store } = abortedEntry();
      const transcript = composerRecoveryPortalTranscript([
        {
          messageId: 'u2',
          chatId: 'chat',
          role: 'user',
          status: 'complete',
          text: 'Fix the bug',
          createdAtMs: 1,
        },
        {
          messageId: 'work',
          chatId: 'chat',
          role,
          status: 'complete',
          text: '',
          parts: [part],
          createdAtMs: 2,
        },
      ]);
      expect(decideComposerRecovery(store.get(KEY), live(transcript))).toEqual({
        kind: 'skip',
        reason: 'agent-activity',
      });
    },
  );

  it('skips when a later identical prompt superseded the refused turn', () => {
    const { store } = abortedEntry();
    expect(
      decideComposerRecovery(store.get(KEY), live([...REFUSED, user('u3')])),
    ).toEqual({ kind: 'skip', reason: 'turn-superseded' });
  });

  it('never substitutes an unrelated message at the same transcript position', () => {
    const { store } = abortedEntry();
    const rekeyed = [user('u1'), assistant('a1'), user('canonical-u2')];
    expect(decideComposerRecovery(store.get(KEY), live(rekeyed))).toEqual({
      kind: 'wait',
      reason: 'transcript-loading',
    });
  });

  it('ignores a refusal of the turn before the submission', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    store.record(KEY, submission({ priorLastUserMessageId: 'u1' }));
    expect(
      store.recordAbort(KEY, { lastUserMessageId: 'u1', userMessageCount: 1 }),
    ).toBe(false);
    expect(store.get(KEY)?.abort).toBeNull();
  });

  it('does not bind a different dispatch just because it is the newest turn', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    store.record(KEY, submission());
    expect(
      store.recordAbort(KEY, {
        lastUserMessageId: 'u3',
        userMessageCount: 3,
      }),
    ).toBe(false);
    expect(store.get(KEY)?.abort).toBeNull();
  });

  it('waits when the abort arrives before its user message is visible', () => {
    const { store } = abortedEntry();
    expect(decideComposerRecovery(store.get(KEY), live([user('u1')]))).toEqual({
      kind: 'wait',
      reason: 'transcript-loading',
    });
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('waits for acceptance cleanup when the refusal arrives first', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const generation = store.record(KEY, submission());
    store.recordAbort(KEY, composerRecoveryTranscriptHead(REFUSED));
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'wait',
      reason: 'dispatch-pending',
    });
    store.settle(KEY, generation, 'accepted');
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('waits for hydration and a loaded transcript without consuming recovery', () => {
    const { store } = abortedEntry();
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live(REFUSED, { composerHydrated: false }),
      ),
    ).toEqual({ kind: 'wait', reason: 'composer-hydrating' });
    expect(decideComposerRecovery(store.get(KEY), live(null))).toEqual({
      kind: 'wait',
      reason: 'transcript-loading',
    });
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('restores only editor content after a rejection already returned reserved inputs', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const generation = store.record(KEY, submission());
    store.settle(KEY, generation, 'reserved-inputs-restored');
    store.recordAbort(KEY, composerRecoveryTranscriptHead(REFUSED));
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live(REFUSED, {
          occupancy: { ...EMPTY_OCCUPANCY, attachments: true },
        }),
      ),
    ).toEqual({ kind: 'restore', generation, restoreReservedInputs: false });
  });

  it('skips in terminal mode and when the send kept a newer draft', () => {
    const { store } = abortedEntry();
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live(REFUSED, { mode: 'terminal' }),
      ),
    ).toEqual({ kind: 'skip', reason: 'composer-mode' });
    const kept = abortedEntry({ composerCleared: false });
    expect(decideComposerRecovery(kept.store.get(KEY), live(REFUSED))).toEqual({
      kind: 'skip',
      reason: 'composer-not-cleared',
    });
  });

  it('releases a submission whose turn did work without a refusal', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const generation = store.record(KEY, submission());
    store.settle(KEY, generation, 'accepted');
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'wait',
      reason: 'no-abort',
    });
    expect(
      decideComposerRecovery(
        store.get(KEY),
        live([...REFUSED, assistant('ok')]),
      ),
    ).toEqual({ kind: 'skip', reason: 'turn-progressed' });
  });
});

describe('createComposerRecoveryStore (CAN-5348)', () => {
  it('keeps dispatch ownership after recovery disposal and prevents older preparation from replacing a newer send', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const older = store.beginSubmission(KEY);
    const newer = store.beginSubmission(KEY);
    store.record(KEY, submission({ userMessageId: 'newer' }), newer);
    store.record(KEY, submission({ userMessageId: 'older' }), older);
    expect(store.get(KEY)?.submission.userMessageId).toBe('newer');
    store.release(KEY, newer);
    expect(store.isCurrentSubmission(KEY, newer)).toBe(true);
    expect(store.isCurrentSubmission(KEY, older)).toBe(false);
    store.forget(KEY);
    expect(store.isCurrentSubmission(KEY, newer)).toBe(false);
  });
  it('keeps an ineligible submission available for rejection rollback until dispatch settles', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const reservedInputs = { attachments: ['submitted.png'] };
    // The mounted composer evaluates every synchronous store notification.
    const unsubscribe = store.subscribe(() => {
      const entry = store.get(KEY);
      if (decideComposerRecovery(entry, live(REFUSED)).kind === 'skip') {
        store.release(KEY, entry?.generation);
      }
    });
    const generation = store.record(
      KEY,
      submission({ composerCleared: false, reservedInputs }),
    );
    expect(store.get(KEY)?.generation).toBe(generation);
    // Rejecting this dispatch must still be able to claim and return its inputs.
    expect(store.claim(KEY, generation)).toBe(true);
    expect(store.get(KEY)?.submission.reservedInputs).toEqual(reservedInputs);
    store.settle(KEY, generation, 'reserved-inputs-restored');
    store.unclaim(KEY, generation);
    expect(store.get(KEY)).toBeUndefined();
    unsubscribe();
  });

  it('keeps one submission per target and scopes transitions by generation', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const older = store.record(KEY, submission());
    const newer = store.record(
      KEY,
      submission({ priorLastUserMessageId: 'u2' }),
    );
    store.settle(KEY, older, 'accepted');
    store.release(KEY, older);
    expect(store.get(KEY)?.generation).toBe(newer);
    expect(store.get(KEY)?.settlement).toBe('pending');
  });

  it('binds a duplicate refusal once', () => {
    const { store } = abortedEntry();
    const before = store.getVersion();
    expect(
      store.recordAbort(KEY, { lastUserMessageId: 'u9', userMessageCount: 9 }),
    ).toBe(false);
    expect(store.get(KEY)?.abort?.userMessageId).toBe('u2');
    expect(store.getVersion()).toBe(before);
  });

  it('lets only one caller claim, and a failed apply return the claim', () => {
    const { store, generation } = abortedEntry();
    expect(store.claim(KEY, generation)).toBe(true);
    expect(store.claim(KEY, generation)).toBe(false);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'wait',
      reason: 'claimed',
    });
    store.unclaim(KEY, generation);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('keeps other targets independent', () => {
    const { store } = abortedEntry();
    store.noteUserInput('project/worktree/other');
    expect(
      store.recordAbort('project/worktree/other', {
        lastUserMessageId: 'x',
        userMessageCount: 1,
      }),
    ).toBe(false);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('retains all inputs after a failed application and retries only when requested', () => {
    const { store, generation } = abortedEntry({
      reservedInputs: { attachments: ['one.png', 'two.png'] },
    });
    store.claim(KEY, generation);
    store.failApplication(KEY, generation);
    expect(store.get(KEY)?.submission.reservedInputs.attachments).toEqual([
      'one.png',
      'two.png',
    ]);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED))).toEqual({
      kind: 'wait',
      reason: 'application-failed',
    });
    store.retryApplication(KEY);
    expect(decideComposerRecovery(store.get(KEY), live(REFUSED)).kind).toBe(
      'restore',
    );
  });

  it('rolls back partial application and retries without duplicated attachments', () => {
    const { store, generation } = abortedEntry({
      reservedInputs: { attachments: ['one.png', 'two.png'] },
    });
    const restored: string[] = [];
    expect(
      applyComposerRecovery(
        store,
        KEY,
        generation,
        () => {
          restored.push('one.png');
          throw new Error('second attachment failed');
        },
        () => {
          restored.length = 0;
        },
      ),
    ).toBe(false);
    expect(restored).toEqual([]);
    expect(store.get(KEY)?.applicationFailed).toBe(true);
    store.retryApplication(KEY);
    expect(
      applyComposerRecovery(
        store,
        KEY,
        generation,
        () => {
          restored.push(
            ...(store.get(KEY)?.submission.reservedInputs.attachments ?? []),
          );
        },
        () => {
          restored.length = 0;
        },
      ),
    ).toBe(true);
    expect(restored).toEqual(['one.png', 'two.png']);
    expect(store.get(KEY)).toBeUndefined();
  });

  it('notifies subscribers on change', () => {
    const store = createComposerRecoveryStore<Value, Inputs>();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    store.record(KEY, submission());
    unsubscribe();
    store.release(KEY);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
