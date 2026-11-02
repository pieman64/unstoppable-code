import type {
  LedgerActorRef,
  LedgerEntrySearchItem,
  LedgerMutation,
  LedgerOrigin,
} from '@canopy/protocol/canopy-core';
import {
  LEDGER_CLOSING_STATUS_OPTIONS,
  LEDGER_OPEN_STATUS_OPTIONS,
  LEDGER_STATUS_LABELS,
  countLedgerCodePoints,
  describeLedgerMutation,
  ledgerMutationSentenceParts,
  formatLedgerTime,
  formatLedgerFullDateTime,
  formatLedgerRelativeTime,
  indexLedgerActorLabels,
  isLedgerEntryClosed,
  ledgerActorName,
  ledgerClosedEntryExplanation,
  ledgerEntryShowsOwner,
  ledgerEntryShowsStatus,
  ledgerExcerpt,
  ledgerOwnerCandidateDescription,
  ledgerOwnerCandidateTitle,
  ledgerSearchItemSourceAction,
  ledgerSourceAction,
  ledgerSourceDescription,
  ledgerStatusTone,
} from '../ledger-display';

const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};
const CHAT_ORIGIN: LedgerOrigin = {
  kind: 'chat',
  ledgerId: LEDGER_ID,
  chatId: 'chat-1',
};

const PIPELINE: LedgerActorRef = {
  ...CHAT,
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'pipeline_agent',
};
const USER: LedgerActorRef = {
  ...CHAT,
  actorId: '00000000-0000-4000-8000-0000000000a3',
  kind: 'user',
};
const OTHER_OWNER: LedgerActorRef = {
  ...CHAT,
  actorId: '00000000-0000-4000-8000-0000000000a4',
  kind: 'user',
};

function displaySearchItem(
  overrides: Partial<LedgerEntrySearchItem> = {},
): LedgerEntrySearchItem {
  return {
    entryId: '00000000-0000-4000-8000-0000000000101',
    revision: 1,
    type: 'TASK',
    title: 'Update parser recovery',
    content: 'Preserve incomplete events after reconnection.',
    highlights: [],
    referenceFiles: [],
    status: 'IN_PROGRESS',
    owner: CHAT,
    author: CHAT,
    attributionKind: 'self_reported',
    createdAt: '2026-10-05T17:00:00.000Z',
    updatedAt: '2026-10-05T17:00:00.000Z',
    sourceAvailability: 'available',
    ...overrides,
  };
}

function mutation(overrides: Partial<LedgerMutation> = {}): LedgerMutation {
  return {
    mutationId: '00000000-0000-4000-8000-0000000000102',
    entryId: '00000000-0000-4000-8000-0000000000103',
    kind: 'update',
    revision: 2,
    previousRevision: 1,
    occurredAt: '2026-10-05T17:00:00.000Z',
    attribution: {
      kind: 'self_reported',
      effectiveActor: CHAT,
      recordedBy: CHAT,
      executorDetails: {
        harness: null,
        model: null,
        thinkingEffort: null,
        mode: null,
        pipelineExecutionId: null,
        settingsRevision: null,
        unavailableReason: null,
      },
    },
    invocationOrigin: CHAT_ORIGIN,
    ...overrides,
  };
}

describe('Ledger status display', () => {
  it('reads every status as text, with an ink that matches its meaning', () => {
    expect(LEDGER_STATUS_LABELS).toEqual({
      TODO: 'To do',
      IN_PROGRESS: 'In progress',
      COMPLETED: 'Completed',
      FAILED: 'Failed',
      BLOCKED: 'Blocked',
      NEEDS_REVIEW: 'Needs review',
      INFO: 'Info',
    });
    expect(ledgerStatusTone('IN_PROGRESS')).toBe('active');
    expect(ledgerStatusTone('COMPLETED')).toBe('success');
    expect(ledgerStatusTone('FAILED')).toBe('failed');
    expect(ledgerStatusTone('BLOCKED')).toBe('paused');
    expect(ledgerStatusTone('NEEDS_REVIEW')).toBe('attention');
    expect(ledgerStatusTone('INFO')).toBe('quiet');
  });

  it('treats completed, failed and info entries as closed', () => {
    expect(
      (['COMPLETED', 'FAILED', 'INFO'] as const).map(isLedgerEntryClosed),
    ).toEqual([true, true, true]);
    expect(
      (['TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW'] as const).map(
        isLedgerEntryClosed,
      ),
    ).toEqual([false, false, false, false]);
  });
});

describe('ledgerActorName', () => {
  it('uses the registered name, or the kind when the read gave none', () => {
    const labels = indexLedgerActorLabels([
      { actorId: CHAT.actorId, kind: 'chat', displayName: 'Parser fixes' },
    ]);
    expect(ledgerActorName(CHAT, labels)).toBe('Parser fixes');
    expect(
      ledgerActorName(
        { ...CHAT, actorId: '00000000-0000-4000-8000-0000000000a2' },
        labels,
      ),
    ).toBe('Chat');
    expect(ledgerActorName({ ...CHAT, kind: 'pipeline_agent' }, {})).toBe(
      'Workflow agent',
    );
  });
});

describe('formatLedgerTime', () => {
  it('shows the time of day, or nothing for a time it cannot read', () => {
    expect(formatLedgerTime('not a time')).toBe('');
    expect(formatLedgerTime(new Date(2026, 8, 30, 10, 42).toISOString())).toBe(
      new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(2026, 8, 30, 10, 42)),
    );
  });
});

describe('formatLedgerFullDateTime', () => {
  it('shows the full local date and time, or preserves an unreadable input', () => {
    const iso = '2026-10-05T17:00:00.000Z';
    expect(formatLedgerFullDateTime(iso)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(new Date(iso)),
    );
    expect(formatLedgerFullDateTime('not a time')).toBe('not a time');
  });
});

describe('ledgerExcerpt', () => {
  it('keeps content on one line and cuts it by code point', () => {
    expect(ledgerExcerpt('First line\n\n  second   line')).toBe(
      'First line second line',
    );
    const long = '😀'.repeat(200);
    const excerpt = ledgerExcerpt(long, 10);
    expect(Array.from(excerpt)).toHaveLength(10);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('Ledger source copy', () => {
  it('names what opening a source does', () => {
    expect(
      ledgerSourceAction({
        availability: 'available',
        target: {
          kind: 'chat',
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          archived: false,
        },
      }),
    ).toEqual({ label: 'Open chat', glyph: 'chat', tooltip: null });
    expect(
      ledgerSourceAction({
        availability: 'archived',
        target: {
          kind: 'chat',
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          archived: true,
        },
      }),
    ).toEqual({
      label: 'Open archived chat',
      glyph: 'archived',
      tooltip: 'This chat is archived. It opens read-only.',
    });
    expect(
      ledgerSourceAction({
        availability: 'available',
        target: {
          kind: 'pipeline',
          projectId: 'p',
          worktreeId: 'w',
          executionId: 'e',
        },
      }),
    ).toEqual({ label: 'Open run', glyph: 'run', tooltip: null });
    expect(
      ledgerSourceAction({ availability: 'deleted', target: null }),
    ).toBeNull();
  });

  it("opens a delegate's own chat, or the archived chat that started it", () => {
    const delegateChat = {
      kind: 'chat',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      delegationId: 'd',
    } as const;
    expect(
      ledgerSourceAction({
        availability: 'available',
        target: { ...delegateChat, archived: false },
      }),
    ).toEqual({ label: 'Open chat', glyph: 'chat', tooltip: null });
    expect(
      ledgerSourceAction({
        availability: 'archived',
        target: { ...delegateChat, archived: true },
      }),
    ).toEqual({
      label: 'Open archived chat',
      glyph: 'archived',
      tooltip:
        'The chat that started this delegate is archived. It opens read-only.',
    });
  });

  it('says honestly where the source is, and when it cannot be checked', () => {
    expect(
      ledgerSourceDescription(
        { kind: 'user', ledgerId: LEDGER_ID, userActorId: CHAT.actorId },
        null,
      ),
    ).toBe('Added in the Feed.');
    expect(ledgerSourceDescription(CHAT_ORIGIN, null)).toBe(
      "The source can't be checked right now.",
    );
    expect(
      ledgerSourceDescription(CHAT_ORIGIN, {
        availability: 'deleted',
        target: null,
      }),
    ).toBe('The chat that recorded this entry was deleted.');
    expect(
      ledgerSourceDescription(
        {
          kind: 'summary',
          ledgerId: LEDGER_ID,
          snapshotId: 's',
          generationId: 'g',
          helperActorId: CHAT.actorId,
        },
        { availability: 'expired', target: null },
      ),
    ).toBe('The summary that recorded this entry is no longer kept.');
    expect(
      ledgerSourceDescription(CHAT_ORIGIN, {
        availability: 'available',
        target: null,
      }),
    ).toBe('Recorded in a chat.');
  });
});

describe('Ledger writing display', () => {
  it('counts code points, as the Ledger limits text', () => {
    expect(countLedgerCodePoints('abc')).toBe(3);
    expect(countLedgerCodePoints('😀😀')).toBe(2);
  });

  it('offers every status once, open ones first, and explains a closed entry', () => {
    expect(
      [...LEDGER_OPEN_STATUS_OPTIONS, ...LEDGER_CLOSING_STATUS_OPTIONS].sort(),
    ).toEqual(Object.keys(LEDGER_STATUS_LABELS).sort());
    expect(
      LEDGER_CLOSING_STATUS_OPTIONS.every((status) =>
        isLedgerEntryClosed(status),
      ),
    ).toBe(true);
    expect(ledgerClosedEntryExplanation('COMPLETED')).toBe(
      "Completed entries can't change. Add a correction to record something new.",
    );
  });

  it('tells owner candidates apart, a paused pipeline agent by its exact pause', () => {
    const you = {
      actor: { ...CHAT, kind: 'user' as const },
      displayName: 'You',
      eligibilityToken: 'token-you',
      isSelf: true,
    };
    expect(ledgerOwnerCandidateDescription(you)).toBe('');
    expect(
      ledgerOwnerCandidateDescription({
        actor: CHAT,
        displayName: 'Parser fixes',
        eligibilityToken: 'token-chat',
        isSelf: false,
      }),
    ).toBe('Chat');
    const agent = {
      actor: { ...CHAT, kind: 'pipeline_agent' as const },
      displayName: 'Review changes · Release checks',
      eligibilityToken: 'token-agent',
      isSelf: false,
      pipelineAgent: {
        executionId: 'abcdef12-3456-4789-8abc-def012345678',
        jobId: 'review',
        stepId: 'agent',
        attempt: 2,
        checkpointId: 'checkpoint-7',
        pausedAt: '2026-09-30T10:42:00.000Z',
      },
    };
    expect(ledgerOwnerCandidateDescription(agent)).toBe(
      `Workflow run abcdef12, job review, step agent, paused ${formatLedgerTime('2026-09-30T10:42:00.000Z')}`,
    );
    expect(ledgerOwnerCandidateTitle(agent).split('\n')).toEqual([
      'Review changes · Release checks',
      'Run abcdef12-3456-4789-8abc-def012345678',
      'Job review, step agent, attempt 2',
      'Checkpoint checkpoint-7',
    ]);
  });
});

describe('formatLedgerRelativeTime', () => {
  const now = new Date(2026, 9, 5, 17, 0);

  it('calls times under a minute and times ahead of now Just now', () => {
    expect(
      formatLedgerRelativeTime(
        new Date(now.getTime() - 59_000).toISOString(),
        now,
      ),
    ).toBe('Just now');
    expect(
      formatLedgerRelativeTime(
        new Date(now.getTime() + 30_000).toISOString(),
        now,
      ),
    ).toBe('Just now');
  });

  it('shows whole minutes for times under an hour', () => {
    expect(
      formatLedgerRelativeTime(
        new Date(now.getTime() - 59 * 60_000).toISOString(),
        now,
      ),
    ).toBe('59 min ago');
  });

  it('shows whole hours for times under a day', () => {
    expect(
      formatLedgerRelativeTime(
        new Date(now.getTime() - 60 * 60_000).toISOString(),
        now,
      ),
    ).toBe('1 h ago');
    expect(
      formatLedgerRelativeTime(
        new Date(now.getTime() - 23 * 60 * 60_000).toISOString(),
        now,
      ),
    ).toBe('23 h ago');
  });

  it('shows the local date with a year only for a different year', () => {
    const sameYear = new Date(2026, 9, 3, 17, 0);
    const otherYear = new Date(2025, 9, 3, 17, 0);

    expect(formatLedgerRelativeTime(sameYear.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(sameYear),
    );
    expect(formatLedgerRelativeTime(otherYear.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(otherYear),
    );
  });

  it('returns an empty string for an invalid timestamp', () => {
    expect(formatLedgerRelativeTime('not a time', now)).toBe('');
  });
});

describe('ledgerSearchItemSourceAction', () => {
  const DELEGATE: LedgerActorRef = { ...CHAT, kind: 'managed_delegation' };

  it('offers chat actions only for available or archived chats', () => {
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({ author: CHAT, sourceAvailability: 'available' }),
      ),
    ).toEqual({ label: 'Open chat', glyph: 'chat', tooltip: null });
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({ author: CHAT, sourceAvailability: 'archived' }),
      ),
    ).toEqual({
      label: 'Open archived chat',
      glyph: 'archived',
      tooltip: 'This chat is archived. It opens read-only.',
    });

    const otherAvailability = [
      'not_on_this_device',
      'access_denied',
      'deleted',
      'expired',
      'anchor_missing',
    ] as const;
    for (const sourceAvailability of otherAvailability) {
      expect(
        ledgerSearchItemSourceAction(
          displaySearchItem({ author: CHAT, sourceAvailability }),
        ),
      ).toBeNull();
    }
  });

  it('offers a run action only for an available pipeline agent', () => {
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: PIPELINE,
          sourceAvailability: 'available',
        }),
      ),
    ).toEqual({ label: 'Open run', glyph: 'run', tooltip: null });
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({ author: PIPELINE, sourceAvailability: 'expired' }),
      ),
    ).toBeNull();
  });

  it("offers a delegate's chat from list data, and says when the chat that started it is archived", () => {
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: DELEGATE,
          sourceKind: 'chat',
          sourceAvailability: 'available',
        }),
      ),
    ).toEqual({ label: 'Open chat', glyph: 'chat', tooltip: null });
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: DELEGATE,
          sourceKind: 'chat',
          sourceAvailability: 'archived',
        }),
      ),
    ).toEqual({
      label: 'Open archived chat',
      glyph: 'archived',
      tooltip:
        'The chat that started this delegate is archived. It opens read-only.',
    });
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: DELEGATE,
          sourceKind: 'chat',
          sourceAvailability: 'deleted',
        }),
      ),
    ).toBeNull();
  });

  it('offers the run that started a delegate, and nothing when its source kind is unknown', () => {
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: DELEGATE,
          sourceKind: 'pipeline',
          sourceAvailability: 'available',
        }),
      ),
    ).toEqual({ label: 'Open run', glyph: 'run', tooltip: null });
    expect(
      ledgerSearchItemSourceAction(
        displaySearchItem({
          author: DELEGATE,
          sourceKind: 'pipeline',
          sourceAvailability: 'expired',
        }),
      ),
    ).toBeNull();
    expect(
      ledgerSearchItemSourceAction(displaySearchItem({ author: DELEGATE })),
    ).toBeNull();
  });

  it('does not offer source actions for other author kinds', () => {
    const otherAuthorKinds = ['user', 'background', 'ledger_sidecar'] as const;
    for (const kind of otherAuthorKinds) {
      expect(
        ledgerSearchItemSourceAction(
          displaySearchItem({ author: { ...CHAT, kind } }),
        ),
      ).toBeNull();
    }
  });
});

describe('ledgerEntryShowsStatus', () => {
  it('always shows task and action statuses, including Info', () => {
    for (const type of ['TASK', 'ACTION'] as const) {
      expect(
        ledgerEntryShowsStatus(displaySearchItem({ type, status: 'INFO' })),
      ).toBe(true);
    }
  });

  it('hides Info for decisions, observations, and summaries', () => {
    for (const type of ['DECISION', 'OBSERVATION', 'SUMMARY'] as const) {
      expect(
        ledgerEntryShowsStatus(displaySearchItem({ type, status: 'INFO' })),
      ).toBe(false);
    }
  });

  it('shows a meaningful status for a non-task entry', () => {
    expect(
      ledgerEntryShowsStatus(
        displaySearchItem({ type: 'DECISION', status: 'COMPLETED' }),
      ),
    ).toBe(true);
  });
});

describe('ledgerEntryShowsOwner', () => {
  it('shows a different owner for every open status', () => {
    for (const status of [
      'TODO',
      'IN_PROGRESS',
      'BLOCKED',
      'NEEDS_REVIEW',
    ] as const) {
      expect(
        ledgerEntryShowsOwner(
          displaySearchItem({ status, owner: OTHER_OWNER, author: CHAT }),
        ),
      ).toBe(true);
    }
  });

  it('hides an owner for closed statuses or when the author owns the entry', () => {
    for (const status of ['COMPLETED', 'FAILED', 'INFO'] as const) {
      expect(
        ledgerEntryShowsOwner(
          displaySearchItem({ status, owner: OTHER_OWNER, author: CHAT }),
        ),
      ).toBe(false);
    }
    expect(
      ledgerEntryShowsOwner(
        displaySearchItem({ status: 'TODO', owner: CHAT, author: CHAT }),
      ),
    ).toBe(false);
  });
});

describe('describeLedgerMutation', () => {
  const nameOf = (actor: LedgerActorRef): string =>
    actor.actorId === CHAT.actorId ? 'Theme support' : 'Ada Lovelace';

  it('describes creates with and without a status', () => {
    expect(
      describeLedgerMutation(
        mutation({ kind: 'create', revision: 1, previousRevision: null }),
        nameOf,
      ),
    ).toBe('Theme support added this entry');
    expect(
      describeLedgerMutation(
        mutation({
          kind: 'create',
          revision: 1,
          previousRevision: null,
          status: { from: null, to: 'TODO' },
        }),
        nameOf,
      ),
    ).toBe('Theme support added this entry as To do');
  });

  it('describes a status set from null and a status change', () => {
    expect(
      describeLedgerMutation(
        mutation({ status: { from: null, to: 'IN_PROGRESS' } }),
        nameOf,
      ),
    ).toBe('Theme support set the status to In progress');
    expect(
      describeLedgerMutation(
        mutation({ status: { from: 'BLOCKED', to: 'IN_PROGRESS' } }),
        nameOf,
      ),
    ).toBe('Theme support changed the status from Blocked to In progress');
  });

  it('describes an owner change', () => {
    expect(
      describeLedgerMutation(
        mutation({ owner: { from: CHAT, to: USER } }),
        nameOf,
      ),
    ).toBe('Theme support made Ada Lovelace the owner');
  });

  it('joins status and owner changes with and', () => {
    expect(
      describeLedgerMutation(
        mutation({
          status: { from: 'BLOCKED', to: 'IN_PROGRESS' },
          owner: { from: CHAT, to: USER },
        }),
        nameOf,
      ),
    ).toBe(
      'Theme support changed the status from Blocked to In progress and made Ada Lovelace the owner',
    );
  });

  it('names the actors as separate parts, so a view can block a person', () => {
    const parts = ledgerMutationSentenceParts(
      mutation({
        status: { from: 'BLOCKED', to: 'IN_PROGRESS' },
        owner: { from: CHAT, to: USER },
      }),
      nameOf,
    );
    expect(parts).toEqual([
      { actor: CHAT, name: 'Theme support' },
      ' changed the status from Blocked to In progress and made ',
      { actor: USER, name: 'Ada Lovelace' },
      ' the owner',
    ]);
  });

  it('describes an update with no status or owner change', () => {
    expect(describeLedgerMutation(mutation(), nameOf)).toBe(
      'Theme support updated this entry',
    );
  });
});
