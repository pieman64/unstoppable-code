/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LedgerActorLabel,
  LedgerActorRef,
  LedgerEntry,
  LedgerEntrySearchItem,
  LedgerFileRef,
  LedgerMutation,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewEntry } from '@canopy/protocol/ledger-view';
import {
  formatLedgerFullDateTime,
  type LedgerSourceAction,
} from '../../../lib/ledger-display';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  LedgerActivityLine,
  LedgerEntryDetails,
  LedgerEntryOpenArea,
  LedgerHistoryMore,
  ledgerActivityItems,
  ledgerOpenEntryActors,
} from '../LedgerEntryDetails';
import {
  LedgerEntryActions,
  LedgerEntryBody,
  LedgerEntryHeader,
  type LedgerEntryHeaderProps,
  LedgerEntryTitle,
} from '../LedgerEntryParts';
import type { LedgerEntryRowAttribution } from '../ledger-entry-attribution';
import type { LedgerOpenEntry } from '../ledger-entry-slots';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const OPEN_CHAT: LedgerSourceAction = {
  label: 'Open chat',
  glyph: 'chat',
  tooltip: null,
};
const OPEN_RUN: LedgerSourceAction = {
  label: 'Open run',
  glyph: 'run',
  tooltip: null,
};

const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};
const USER: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'user',
  authorityId: 'authority-1',
};
const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';
const TEAMMATE: LedgerEntryRowAttribution = {
  kind: 'teammate',
  name: 'Ada Lovelace',
  organization: 'Acme',
};
const ACTORS: Readonly<Record<string, LedgerActorLabel>> = {
  [CHAT.actorId]: {
    actorId: CHAT.actorId,
    kind: 'chat',
    displayName: 'Parser fixes',
  },
  [USER.actorId]: {
    actorId: USER.actorId,
    kind: 'user',
    displayName: 'You',
  },
};
const NOW = new Date('2026-10-06T13:00:00.000Z');

function searchItem(
  overrides: Partial<LedgerEntrySearchItem> = {},
): LedgerEntrySearchItem {
  return {
    entryId: ENTRY_ID,
    revision: 2,
    type: 'TASK',
    title: 'Update parser recovery',
    content: 'Preserve incomplete events after reconnection.',
    highlights: [],
    referenceFiles: [],
    status: 'IN_PROGRESS',
    owner: USER,
    author: CHAT,
    attributionKind: 'self_reported',
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:30:00.000Z',
    sourceAvailability: 'available',
    ...overrides,
  };
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const details = {
    harness: 'claude',
    model: 'claude-sonnet',
    thinkingEffort: 'medium',
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  };
  return {
    schemaVersion: 1,
    entryId: ENTRY_ID,
    scope: {
      ledgerId: LEDGER_ID,
      authorityId: 'authority-1',
      container: {
        kind: 'code_worktree',
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
      },
    },
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:30:00.000Z',
    revision: 2,
    author: CHAT,
    authorDetails: details,
    owner: USER,
    type: 'TASK',
    title: 'Update parser recovery',
    content: 'Preserve incomplete events after reconnection.',
    highlights: ['Keeps partial events'],
    referenceFiles: [],
    status: 'IN_PROGRESS',
    origin: { kind: 'chat', ledgerId: LEDGER_ID, chatId: 'chat-1' },
    attribution: {
      kind: 'self_reported',
      effectiveActor: CHAT,
      recordedBy: CHAT,
      executorDetails: details,
    },
    ...overrides,
  };
}

function view(overrides: Partial<LedgerViewEntry> = {}): LedgerViewEntry {
  const value = entry();
  return {
    entry: {
      entry: value,
      sourceAvailability: 'available',
      history: {
        mutations: [
          {
            mutationId: '00000000-0000-4000-8000-000000000201',
            entryId: value.entryId,
            kind: 'create',
            revision: 1,
            previousRevision: null,
            occurredAt: value.createdAt,
            status: { from: null, to: 'TODO' },
            attribution: value.attribution,
            invocationOrigin: value.origin,
          },
          {
            mutationId: '00000000-0000-4000-8000-000000000202',
            entryId: value.entryId,
            kind: 'update',
            revision: 2,
            previousRevision: 1,
            occurredAt: value.updatedAt,
            status: { from: 'TODO', to: 'IN_PROGRESS' },
            owner: { from: CHAT, to: USER },
            attribution: value.attribution,
            invocationOrigin: value.origin,
          },
        ],
        nextCursor: null,
      },
    },
    source: {
      availability: 'available',
      target: {
        kind: 'chat',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        archived: false,
      },
    },
    ...overrides,
  };
}

function withReadEntry(
  value: LedgerViewEntry,
  updates: Partial<LedgerEntry>,
): LedgerViewEntry {
  return {
    ...value,
    entry: {
      ...value.entry,
      entry: { ...value.entry.entry, ...updates },
    },
  };
}

function withReadResult(
  value: LedgerViewEntry,
  updates: Partial<LedgerViewEntry['entry']>,
): LedgerViewEntry {
  return { ...value, entry: { ...value.entry, ...updates } };
}

function withHistory(
  value: LedgerViewEntry,
  mutations: LedgerMutation[],
  nextCursor: string | null,
): LedgerViewEntry {
  const history = value.entry.history;
  if (history === null) throw new Error('Expected entry history');
  return withReadResult(value, {
    history: { ...history, mutations, nextCursor },
  });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return element;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${testId}`);
  }
  return element;
}

describe('LedgerEntryHeader: who, where and when', () => {
  it('keeps a block owner control outside phrasing-only containers', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem()}
        actors={ACTORS}
        density="page"
        now={NOW}
        timeField="createdAt"
        ownerControl={<div data-testid="owner-control">Owner picker</div>}
      />,
    );
    expect(byTestId('owner-control').closest('span')).toBeNull();
  });

  it('names the author, context, and relative time', () => {
    const item = searchItem({ createdAt: '2026-10-06T12:00:00.000Z' });
    render(
      <LedgerEntryHeader
        entry={item}
        actors={ACTORS}
        density="page"
        now={NOW}
        timeField="createdAt"
        details={{ context: 'Canopy · Parser task' }}
      />,
    );
    expect(byTestId('ledger-entry-row-author').textContent).toBe(
      'Parser fixes',
    );
    expect(byTestId('ledger-entry-row-context').textContent).toBe(
      'Canopy · Parser task',
    );
    expect(container.querySelector('time')?.dateTime).toBe(item.createdAt);
    expect(container.querySelector('time')?.textContent).toBe('1 h ago');
  });

  it('shows a full local date and time in the hovered time tooltip', () => {
    const iso = '2026-10-06T12:00:00.000Z';
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date(iso));
    render(
      <LedgerEntryHeader
        entry={searchItem({ createdAt: iso })}
        actors={ACTORS}
        density="page"
        now={NOW}
        timeField="createdAt"
      />,
    );
    const time = container.querySelector('time');
    expect(time?.dateTime).toBe(iso);
    expect(time?.textContent).toBe('1 h ago');

    jest.useFakeTimers();
    try {
      act(() => {
        time?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      act(() => jest.advanceTimersByTime(500));
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        expected,
      );
      expect(formatLedgerFullDateTime(iso)).toBe(expected);
    } finally {
      jest.useRealTimers();
    }
  });

  it('spaces its separators with the line gap, since flex items drop edge spaces', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ syncState: 'repair_needed' })}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
        details={{ context: 'Canopy · Parser task' }}
      />,
    );
    const line = container.querySelector('time')?.parentElement?.parentElement;
    expect(line?.classList.contains('gap-x-1')).toBe(true);
    const separators = Array.from(
      line?.querySelectorAll(':scope > [aria-hidden="true"]') ?? [],
    );
    // Author, context, time and sync state: three separators between four.
    expect(separators.map((separator) => separator.textContent)).toEqual([
      '·',
      '·',
      '·',
    ]);
  });

  it('uses teammate and device origins without repeating a teammate own name', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ author: USER })}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="updatedAt"
        details={{ attribution: TEAMMATE }}
      />,
    );
    expect(container.textContent).toContain('Ada Lovelace');
    expect(byTestId('ledger-entry-row-teammate').textContent).toBe('Acme');
    expect(container.textContent).toContain('Teammate:');
    expect(container.textContent?.match(/Ada Lovelace/g)).toHaveLength(1);

    render(
      <LedgerEntryHeader
        entry={searchItem()}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
        details={{ attribution: TEAMMATE }}
      />,
    );
    expect(byTestId('ledger-entry-row-teammate').textContent).toBe(
      'Ada Lovelace, Acme',
    );

    render(
      <LedgerEntryHeader
        entry={searchItem()}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
        details={{ attribution: { kind: 'device', label: 'Studio Mac' } }}
      />,
    );
    expect(byTestId('ledger-entry-row-device').textContent).toBe('Studio Mac');
    expect(container.textContent).toContain('Device:');
  });

  it('shows non-mirrored sync state and highlights repair', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ syncState: 'repair_needed' })}
        actors={ACTORS}
        density="page"
        now={NOW}
        timeField="createdAt"
      />,
    );
    const sync = byTestId('ledger-entry-row-sync');
    expect(sync.textContent).toBe('Needs repair');
    expect(sync.getAttribute('data-sync-state')).toBe('repair_needed');
    expect(sync.classList.contains('fg-attention')).toBe(true);

    render(
      <LedgerEntryHeader
        entry={searchItem({ syncState: 'mirrored' })}
        actors={ACTORS}
        density="page"
        now={NOW}
        timeField="createdAt"
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-row-sync"]'),
    ).toBeNull();
  });
});

describe('ledger person names in session replay', () => {
  /** The innermost element in the container whose whole text is `text`. */
  function textElement(text: string): Element {
    const match = Array.from(container.querySelectorAll('*'))
      .reverse()
      .find((element) => element.textContent === text);
    if (match === undefined) throw new Error(`Missing ${text}`);
    return match;
  }

  function replayBlocked(element: Element): boolean {
    return element.closest(`.${REPLAY_BLOCK_CLASS}`) !== null;
  }

  it('blocks a teammate whose display name is You', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ author: USER })}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
        details={{ attribution: { ...TEAMMATE, name: 'You' } }}
      />,
    );
    expect(replayBlocked(textElement('You'))).toBe(true);

    render(
      <Header
        entry={searchItem()}
        details={{ attribution: { ...TEAMMATE, name: 'You' } }}
      />,
    );
    expect(replayBlocked(textElement('You'))).toBe(true);
  });

  it("blocks a teammate's name in the byline and keeps the organization", () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ author: USER })}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="updatedAt"
        details={{ attribution: TEAMMATE }}
      />,
    );
    expect(replayBlocked(textElement('Ada Lovelace'))).toBe(true);
    expect(replayBlocked(byTestId('ledger-entry-row-teammate'))).toBe(false);
    expect(replayBlocked(textElement('Teammate: '))).toBe(false);
  });

  it("blocks only the teammate's name in an agent row's origin", () => {
    render(
      <LedgerEntryHeader
        entry={searchItem()}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
        details={{ attribution: TEAMMATE }}
      />,
    );
    const origin = byTestId('ledger-entry-row-teammate');
    expect(origin.textContent).toBe('Ada Lovelace, Acme');
    expect(replayBlocked(origin)).toBe(false);
    expect(replayBlocked(textElement('Ada Lovelace'))).toBe(true);
    // The agent that wrote it is not a person.
    expect(replayBlocked(textElement('Parser fixes'))).toBe(false);
  });

  it('records You and agent names', () => {
    render(
      <LedgerEntryHeader
        entry={searchItem({ author: USER })}
        actors={ACTORS}
        density="panel"
        now={NOW}
        timeField="createdAt"
      />,
    );
    expect(textElement('You')).toBeDefined();
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();

    render(<Header entry={searchItem()} />);
    expect(byTestId('ledger-entry-row-owner').textContent).toBe('Owner: You');
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it("blocks a teammate owner's name, not the Owner label", () => {
    render(<Header entry={searchItem()} details={{ attribution: TEAMMATE }} />);
    const owner = byTestId('ledger-entry-row-owner');
    expect(owner.textContent).toBe('Owner: Ada Lovelace');
    expect(replayBlocked(owner)).toBe(false);
    expect(owner.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
      'Ada Lovelace',
    );
  });

  it("blocks a teammate's name in Added by and Owner, not the labels", () => {
    render(
      <LedgerEntryDetails
        entry={searchItem({ author: USER, owner: USER })}
        view={null}
        actors={ACTORS}
        attribution={TEAMMATE}
      />,
    );
    const names = Array.from(
      byTestId('ledger-entry-details').querySelectorAll('dd'),
    ).filter((dd) => dd.textContent === 'Ada Lovelace');
    expect(names).toHaveLength(2);
    for (const dd of names) {
      expect(replayBlocked(dd)).toBe(false);
      expect(dd.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
        'Ada Lovelace',
      );
    }
    expect(replayBlocked(textElement('Added by'))).toBe(false);
    expect(replayBlocked(textElement('Owner'))).toBe(false);
  });
});

/** The header with the fixed inputs these tests do not vary. */
function Header(
  props: Pick<
    LedgerEntryHeaderProps,
    'entry' | 'statusControl' | 'ownerControl' | 'details'
  >,
): JSX.Element {
  return (
    <LedgerEntryHeader
      actors={ACTORS}
      density="panel"
      now={NOW}
      timeField="createdAt"
      {...props}
    />
  );
}

describe('LedgerEntryHeader: type, owner and status', () => {
  it('shows task and action status, hides info status, and shows an actionable owner', () => {
    render(<Header entry={searchItem()} />);
    expect(byTestId('ledger-entry-row-status').textContent).toBe('In progress');
    expect(byTestId('ledger-entry-row-owner').textContent).toBe('Owner: You');

    render(<Header entry={searchItem({ type: 'ACTION' })} />);
    expect(byTestId('ledger-entry-row-status').textContent).toBe('In progress');

    render(
      <Header
        entry={searchItem({ type: 'OBSERVATION', status: 'NEEDS_REVIEW' })}
      />,
    );
    expect(byTestId('ledger-entry-row-status').textContent).toBe(
      'Needs review',
    );

    render(<Header entry={searchItem({ type: 'DECISION', status: 'INFO' })} />);
    expect(
      container.querySelector('[data-testid="ledger-entry-row-status"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-row-owner"]'),
    ).toBeNull();

    render(<Header entry={searchItem({ owner: CHAT })} />);
    expect(
      container.querySelector('[data-testid="ledger-entry-row-owner"]'),
    ).toBeNull();
  });

  it('puts the glyph of what recorded the entry beside its name, a person for an entry a person added', () => {
    const glyphOf = (author: LedgerActorRef): string => {
      render(<Header entry={searchItem({ author, owner: author })} />);
      const icon = byTestId('ledger-entry-row-author-icon');
      expect(icon.getAttribute('data-actor-kind')).toBe(author.kind);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      // The glyph leads the name on the same line.
      expect(icon.nextElementSibling).toBe(byTestId('ledger-entry-row-author'));
      return icon.querySelector('svg')?.innerHTML ?? '';
    };
    const glyphs = [
      glyphOf(USER),
      glyphOf(CHAT),
      glyphOf({ ...CHAT, kind: 'pipeline_agent' }),
      glyphOf({ ...CHAT, kind: 'managed_delegation' }),
    ];
    expect(glyphs.every((glyph) => glyph !== '')).toBe(true);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    // The name is unchanged by the glyph beside it.
    render(<Header entry={searchItem({ author: USER })} />);
    expect(byTestId('ledger-entry-row-author').textContent).toBe('You');
  });

  it('lets supplied controls replace the plain status and owner', () => {
    render(
      <Header
        entry={searchItem()}
        statusControl={<button type="button">Status picker</button>}
        ownerControl={<button type="button">Owner picker</button>}
      />,
    );
    expect(container.textContent).toContain('Status picker');
    expect(container.textContent).toContain('Owner picker');
    expect(
      container.querySelector('[data-testid="ledger-entry-row-status"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-row-owner"]'),
    ).toBeNull();
  });

  it('leads with the type, and puts the status pill at the trailing edge with its glyph', () => {
    render(<Header entry={searchItem({ status: 'COMPLETED' })} />);
    const type = byTestId('ledger-entry-type');
    const status = byTestId('ledger-entry-row-status');
    expect(type.textContent).toBe('Task');
    // The row's avatar carries the type's glyph, so the name stands alone.
    expect(type.querySelector('svg')).toBeNull();
    // One line holds both: the type first, the status last.
    const line = status.parentElement;
    expect(line?.contains(type)).toBe(true);
    expect(line?.lastElementChild).toBe(status);
    expect(status.getAttribute('data-status')).toBe('COMPLETED');
    expect(
      status
        .querySelector('[data-testid="ledger-status-glyph"]')
        ?.getAttribute('data-status'),
    ).toBe('COMPLETED');
    // Who recorded it follows on the line below the type.
    expect(
      type.compareDocumentPosition(byTestId('ledger-entry-row-author')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});

describe('LedgerEntryTitle and LedgerEntryBody', () => {
  it('renders entry titles as text at their density size, not as a toggle', () => {
    render(<LedgerEntryTitle title="Update parser recovery" density="page" />);
    const title = byTestId('ledger-entry-row-title');
    expect(title.tagName).toBe('H3');
    expect(title.closest('button')).toBeNull();
    expect(title.getAttribute('aria-expanded')).toBeNull();
    expect(title.classList.contains('font-bold')).toBe(true);
    expect(title.classList.contains('font-medium')).toBe(false);
    expect(title.classList.contains('text-m')).toBe(true);
    expect(title.classList.contains('fg-primary')).toBe(true);

    render(<LedgerEntryTitle title="Reply" density="panel" />);
    expect(
      byTestId('ledger-entry-row-title').classList.contains('text-s'),
    ).toBe(true);
  });

  it("blocks an entry's text from session replay, but not its file buttons", () => {
    render(
      <LedgerEntryBody
        entry={searchItem({
          highlights: ['Keeps partial events'],
          referenceFiles: [{ rootId: 'repo-1', path: 'src/parser.ts' }],
        })}
        density="page"
        onOpenFile={jest.fn()}
      />,
    );

    expect(
      byTestId('ledger-entry-row-title').classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    expect(
      byTestId('ledger-entry-row-content').closest(`.${REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
    expect(
      container.querySelector('ul')?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    // rrweb drops clicks inside a block, so the file buttons stay recorded.
    expect(
      byTestId('ledger-entry-file-ref').closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('renders Markdown safely, shows duplicate highlights, and opens reference files', () => {
    const file: LedgerFileRef = {
      rootId: 'repo-1',
      path: 'src/parser.ts',
      startLine: 12,
    };
    const onOpenFile = jest.fn();
    render(
      <LedgerEntryBody
        entry={searchItem({
          content:
            '**bold** ![diagram](https://example.com/diagram.png)\n\n<div>raw markup</div>',
          highlights: ['Keeps partial events', 'Keeps partial events'],
          referenceFiles: [file],
        })}
        density="page"
        onOpenFile={onOpenFile}
      />,
    );
    expect(
      byTestId('ledger-entry-row-content').querySelector('strong')?.textContent,
    ).toBe('bold');
    expect(
      byTestId('ledger-entry-row-content').querySelector('img'),
    ).toBeNull();
    expect(byTestId('ledger-entry-row-content').textContent).toContain(
      'diagram',
    );
    expect(byTestId('ledger-entry-row-content').textContent).toContain(
      '<div>raw markup</div>',
    );
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    const fileButton = byTestId('ledger-entry-file-ref');
    expect(fileButton.getAttribute('aria-label')).toBe('Open src/parser.ts:12');
    expect(fileButton.textContent).toContain('src/parser.ts:12');
    act(() => fileButton.click());
    expect(onOpenFile).toHaveBeenCalledWith(file);
  });

  it('omits only a pending default title and keeps provided title overrides', () => {
    render(
      <LedgerEntryBody
        entry={searchItem({ titlePending: true })}
        density="page"
        onOpenFile={jest.fn()}
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-row-title"]'),
    ).toBeNull();
    expect(byTestId('ledger-entry-row-content').textContent).toContain(
      'Preserve incomplete events',
    );

    render(
      <LedgerEntryBody
        entry={searchItem()}
        density="page"
        onOpenFile={jest.fn()}
      />,
    );
    expect(byTestId('ledger-entry-row-title').textContent).toBe(
      'Update parser recovery',
    );

    render(
      <LedgerEntryBody
        entry={searchItem({ titlePending: true })}
        density="page"
        onOpenFile={jest.fn()}
        title={<span data-testid="custom-ledger-title">Custom title</span>}
      />,
    );
    expect(byTestId('custom-ledger-title').textContent).toBe('Custom title');

    render(
      <LedgerEntryBody
        entry={searchItem()}
        density="page"
        onOpenFile={jest.fn()}
        title={null}
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-row-title"]'),
    ).toBeNull();
  });
});

describe('LedgerEntryActions', () => {
  it('shows source actions only with a label and handler, then details and correction actions', () => {
    const onOpenSource = jest.fn();
    const onToggleDetails = jest.fn();
    render(
      <LedgerEntryActions
        slots={{ sourceAction: OPEN_CHAT, onOpenSource }}
        detailsOpen={false}
        onToggleDetails={onToggleDetails}
      />,
    );
    const source = byTestId('ledger-entry-source-open');
    expect(source.textContent).toContain('Open chat');
    expect(source.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    act(() => source.click());
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    const toggle = buttonByTestId('ledger-entry-details-toggle');
    expect(toggle.textContent).toBe('Show details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(onToggleDetails).toHaveBeenCalledTimes(1);

    render(
      <LedgerEntryActions
        slots={{ sourceAction: OPEN_CHAT }}
        detailsOpen
        onToggleDetails={onToggleDetails}
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-source-open"]'),
    ).toBeNull();
    expect(buttonByTestId('ledger-entry-details-toggle').textContent).toBe(
      'Hide details',
    );
    expect(
      buttonByTestId('ledger-entry-details-toggle').getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');

    render(
      <LedgerEntryActions
        slots={{ sourceAction: OPEN_RUN, onOpenSource }}
        detailsOpen={false}
        onToggleDetails={onToggleDetails}
      />,
    );
    expect(
      byTestId('ledger-entry-source-open').querySelector('svg')?.outerHTML,
    ).not.toBe(source.querySelector('svg')?.outerHTML);
  });

  it('gives an archived chat the archive glyph and says whose chat it is on hover', () => {
    const tooltip =
      'The chat that started this delegate is archived. It opens read-only.';
    render(
      <LedgerEntryActions
        slots={{ sourceAction: OPEN_CHAT, onOpenSource: jest.fn() }}
        detailsOpen={false}
        onToggleDetails={jest.fn()}
      />,
    );
    const live = byTestId('ledger-entry-source-open');
    expect(live.hasAttribute('data-source-archived')).toBe(false);
    const liveGlyph = live.querySelector('svg')?.outerHTML;

    render(
      <LedgerEntryActions
        slots={{
          sourceAction: {
            label: 'Open archived chat',
            glyph: 'archived',
            tooltip,
          },
          onOpenSource: jest.fn(),
        }}
        detailsOpen={false}
        onToggleDetails={jest.fn()}
      />,
    );
    const archived = byTestId('ledger-entry-source-open');
    expect(archived.textContent).toBe('Open archived chat');
    expect(archived.getAttribute('data-source-archived')).toBe('true');
    expect(archived.querySelector('svg')?.outerHTML).not.toBe(liveGlyph);

    jest.useFakeTimers();
    try {
      act(() => {
        archived.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      act(() => jest.advanceTimersByTime(500));
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        tooltip,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('always shows the details toggle in the action row, even with no other actions', () => {
    render(
      <LedgerEntryActions
        slots={{}}
        detailsOpen={false}
        onToggleDetails={jest.fn()}
      />,
    );
    expect(container.firstElementChild?.className).toContain(
      '-ml-2.5 flex min-w-0 flex-wrap items-center gap-1',
    );
    expect(buttonByTestId('ledger-entry-details-toggle').textContent).toBe(
      'Show details',
    );
  });

  it('orders source, details and correction actions in one row', () => {
    render(
      <LedgerEntryActions
        slots={{
          sourceAction: OPEN_CHAT,
          onOpenSource: jest.fn(),
          onAddCorrection: jest.fn(),
        }}
        detailsOpen={false}
        onToggleDetails={jest.fn()}
      />,
    );
    const ids = Array.from(
      container.querySelectorAll('[data-testid^="ledger-entry-"]'),
    )
      .map((element) => element.getAttribute('data-testid'))
      .filter(
        (testId) =>
          testId === 'ledger-entry-source-open' ||
          testId === 'ledger-entry-details-toggle' ||
          testId === 'ledger-entry-add-correction',
      );
    expect(ids).toEqual([
      'ledger-entry-source-open',
      'ledger-entry-details-toggle',
      'ledger-entry-add-correction',
    ]);
  });

  it('disables a correction with its reason and keeps the details toggle', () => {
    render(
      <LedgerEntryActions
        slots={{
          onAddCorrection: jest.fn(),
          addCorrectionLabel: 'Continue correction draft',
          addCorrectionDisabledReason: 'Save or discard your draft first.',
        }}
        detailsOpen={false}
        onToggleDetails={jest.fn()}
      />,
    );
    const correction = buttonByTestId('ledger-entry-add-correction');
    expect(correction.textContent).toContain('Continue correction draft');
    expect(correction.disabled).toBe(true);
    expect(correction.getAttribute('aria-description')).toBe(
      'Save or discard your draft first.',
    );
    // A disabled button takes no pointer events: its wrapper shows the reason.
    act(() => {
      correction.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Save or discard your draft first.',
    );

    expect(byTestId('ledger-entry-details-toggle').textContent).toBe(
      'Show details',
    );

    render(
      <LedgerEntryActions
        slots={{
          sourceAction: OPEN_CHAT,
          onOpenSource: jest.fn(),
          onAddCorrection: jest.fn(),
          readOnlyNote: 'Ada recorded this entry. Only they can change it.',
        }}
        detailsOpen
        onToggleDetails={jest.fn()}
      />,
    );
    expect(byTestId('ledger-entry-read-only').textContent).toContain(
      'Only they can change it.',
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-source-open"]'),
    ).not.toBeNull();
    expect(byTestId('ledger-entry-details-toggle').textContent).toBe(
      'Hide details',
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).toBeNull();
  });
});

describe('ledger entry details and activity', () => {
  it('keeps Added by and Owner in closed details and attributes a teammate by name', () => {
    const closed = searchItem({
      author: USER,
      owner: USER,
      status: 'COMPLETED',
      type: 'DECISION',
    });
    render(
      <LedgerEntryDetails
        entry={closed}
        view={null}
        actors={ACTORS}
        attribution={TEAMMATE}
      />,
    );
    expect(byTestId('ledger-entry-details').textContent).toContain(
      'Added byAda Lovelace',
    );
    expect(byTestId('ledger-entry-detail-owner').textContent).toBe(
      'Ada Lovelace',
    );
    expect(byTestId('ledger-entry-details').textContent).toContain('Revision2');
    expect(byTestId('ledger-entry-details').textContent).toContain(ENTRY_ID);
  });

  it('shows the source sentence, author settings, sync, and only a changed Updated time', () => {
    const read = withReadResult(view(), { syncState: 'repair_needed' });
    render(
      <LedgerEntryDetails
        entry={searchItem({ syncState: 'pending' })}
        view={read}
        actors={ACTORS}
      />,
    );
    const details = byTestId('ledger-entry-details');
    expect(details.textContent).toContain('Recorded in a chat.');
    expect(details.textContent).toContain('Harnessclaude');
    expect(details.textContent).toContain('Modelclaude-sonnet');
    expect(details.textContent).toContain('Thinkingmedium');
    expect(
      Array.from(details.querySelectorAll('dt'), (label) => label.textContent),
    ).not.toContain('Mode');
    expect(details.textContent).toContain('Updated');
    const sync = byTestId('ledger-entry-detail-sync');
    expect(sync.textContent).toBe('Needs repair');
    expect(sync.classList.contains('fg-attention')).toBe(true);

    const synced = withReadResult(read, { syncState: 'mirrored' });
    render(
      <LedgerEntryDetails entry={searchItem()} view={synced} actors={ACTORS} />,
    );
    expect(byTestId('ledger-entry-detail-sync').textContent).toBe('Synced');

    const unmodified = withReadEntry(synced, {
      updatedAt: '2026-10-06T12:00:00.000Z',
    });
    render(
      <LedgerEntryDetails
        entry={searchItem()}
        view={unmodified}
        actors={ACTORS}
      />,
    );
    expect(byTestId('ledger-entry-details').textContent).not.toContain(
      'Updated',
    );
  });

  it('shows a recorded Summary snapshot and only offers a correction link with a handler', () => {
    const base = view();
    const summaryEntry = entry({
      origin: {
        kind: 'summary',
        ledgerId: LEDGER_ID,
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        helperActorId: CHAT.actorId,
      },
    });
    const summaryView: LedgerViewEntry = {
      ...withReadResult(base, {
        entry: summaryEntry,
      }),
      source: {
        availability: 'available',
        target: {
          kind: 'summary',
          snapshot: {
            title: 'Recorded title',
            description: 'Recorded description',
            highlights: ['Recorded highlight'],
            generatedAt: '2026-10-06T11:00:00.000Z',
          },
        },
      },
    };
    const corrected = searchItem({
      supersedesEntryId: '00000000-0000-4000-8000-000000000099',
    });
    render(
      <LedgerEntryDetails
        entry={corrected}
        view={summaryView}
        actors={ACTORS}
      />,
    );
    expect(byTestId('ledger-entry-details').textContent).toContain(
      'Recorded from the Summary panel.',
    );
    expect(byTestId('ledger-entry-summary-snapshot').textContent).toContain(
      'Show recorded summary',
    );
    expect(byTestId('ledger-entry-summary-snapshot').textContent).toContain(
      'Recorded title',
    );
    expect(byTestId('ledger-entry-summary-snapshot').textContent).toContain(
      'Recorded highlight',
    );

    render(
      <LedgerEntryDetails entry={corrected} view={null} actors={ACTORS} />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-supersedes"]'),
    ).toBeNull();

    const onShowCorrectedEntry = jest.fn();
    render(
      <LedgerEntryDetails
        entry={corrected}
        view={null}
        actors={ACTORS}
        onShowCorrectedEntry={onShowCorrectedEntry}
      />,
    );
    const supersedes = byTestId('ledger-entry-supersedes');
    expect(supersedes.textContent).toBe('Show the entry this corrects');
    act(() => supersedes.click());
    expect(onShowCorrectedEntry).toHaveBeenCalledTimes(1);
  });

  it('merges view actors without changing the actor map when nothing is added', () => {
    expect(ledgerOpenEntryActors(ACTORS, null)).toBe(ACTORS);
    const sameLabels = withReadResult(view(), {
      actors: [ACTORS[CHAT.actorId], ACTORS[USER.actorId]].filter(
        (actor): actor is LedgerActorLabel => actor !== undefined,
      ),
    });
    expect(ledgerOpenEntryActors(ACTORS, sameLabels)).toBe(ACTORS);

    const readLabel: LedgerActorLabel = {
      actorId: '00000000-0000-4000-8000-0000000000a3',
      kind: 'pipeline_agent',
      displayName: 'Contrast audit',
    };
    const withNewActor = withReadResult(view(), { actors: [readLabel] });
    expect(
      ledgerOpenEntryActors(ACTORS, withNewActor)[readLabel.actorId],
    ).toEqual(readLabel);

    const updatedChatLabel: LedgerActorLabel = {
      actorId: CHAT.actorId,
      kind: 'chat',
      displayName: 'Parser recovery',
    };
    const withUpdatedActor = withReadResult(view(), {
      actors: [updatedChatLabel],
    });
    expect(
      ledgerOpenEntryActors(ACTORS, withUpdatedActor)[CHAT.actorId],
    ).toEqual(updatedChatLabel);
  });

  it('excludes creates, sorts changes oldest first, and uses the shared sentences', () => {
    const base = view();
    const history = base.entry.history;
    if (history === null) throw new Error('Expected entry history');
    const create = history.mutations.find(
      (mutation) => mutation.kind === 'create',
    );
    const update = history.mutations.find(
      (mutation) => mutation.kind === 'update',
    );
    if (create === undefined || update === undefined) {
      throw new Error('Expected a create and update mutation');
    }
    const later = {
      ...update,
      mutationId: 'later',
      occurredAt: '2026-10-06T12:30:00.000Z',
    };
    const earlier = {
      ...update,
      mutationId: 'earlier',
      occurredAt: '2026-10-06T12:10:00.000Z',
      attribution: { ...update.attribution, effectiveActor: USER },
    };
    const activity = ledgerActivityItems(
      withHistory(base, [later, create, earlier], null),
      ACTORS,
      TEAMMATE,
    );
    expect(ledgerActivityItems(null, ACTORS)).toEqual([]);
    expect(activity.map((item) => item.key)).toEqual(['earlier', 'later']);
    expect(activity[0]?.text).toBe(
      'Ada Lovelace changed the status from To do to In progress and made Ada Lovelace the owner',
    );
    expect(activity[1]?.text).toBe(
      'Parser fixes changed the status from To do to In progress and made Ada Lovelace the owner',
    );
  });

  it("blocks a teammate's name in an activity line, not the sentence or agent names", () => {
    const base = view();
    const history = base.entry.history;
    if (history === null) throw new Error('Expected entry history');
    const update = history.mutations.find(
      (mutation) => mutation.kind === 'update',
    );
    if (update === undefined) throw new Error('Expected an update mutation');
    const [item] = ledgerActivityItems(
      withHistory(base, [update], null),
      ACTORS,
      TEAMMATE,
    );
    if (item === undefined) throw new Error('Expected an activity item');
    render(
      <ul>
        <LedgerActivityLine item={item} now={NOW} />
      </ul>,
    );
    const line = byTestId('ledger-entry-activity');
    expect(line.textContent).toContain(
      'Parser fixes changed the status from To do to In progress and made Ada Lovelace the owner',
    );
    expect(line.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      Array.from(
        line.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`),
        (block) => block.textContent,
      ),
    ).toEqual(['Ada Lovelace']);
  });

  it('renders a wrapping activity line with its relative time', () => {
    render(
      <ul>
        <LedgerActivityLine
          item={{
            key: 'mutation-1',
            text: 'Changed the status from Blocked to In progress',
            occurredAt: '2026-10-06T12:30:00.000Z',
          }}
          now={NOW}
        />
      </ul>,
    );
    const activity = byTestId('ledger-entry-activity');
    expect(activity.textContent).toContain(
      'Changed the status from Blocked to In progress · 30 min ago',
    );
    expect(activity.querySelector('.min-w-0.break-words')).not.toBeNull();
  });
});

describe('LedgerEntryOpenArea and history', () => {
  function openEntry(
    read: LedgerViewEntry | null,
    overrides: Partial<LedgerOpenEntry> = {},
  ): LedgerOpenEntry {
    return { entryId: ENTRY_ID, view: read, ...overrides };
  }

  it('shows open states, activity and details in order with an alert for source errors', () => {
    render(
      <LedgerEntryOpenArea
        entry={searchItem()}
        open={openEntry(view(), {
          notice: <span>Change notice</span>,
          closedExplanation: <span>Closed explanation</span>,
          openError: 'Could not open this file.',
          readState: <span>Read state</span>,
        })}
        actors={ACTORS}
        now={NOW}
        showActivity
      />,
    );
    const alert = byTestId('ledger-entry-open-error');
    expect(alert.querySelector('[role="alert"]')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text.indexOf('Change notice')).toBeLessThan(
      text.indexOf('Closed explanation'),
    );
    expect(text.indexOf('Closed explanation')).toBeLessThan(
      text.indexOf('Could not open this file.'),
    );
    expect(text.indexOf('Could not open this file.')).toBeLessThan(
      text.indexOf('Read state'),
    );
    expect(text.indexOf('Read state')).toBeLessThan(
      text.indexOf('Parser fixes changed the status'),
    );
    expect(text.indexOf('Parser fixes changed the status')).toBeLessThan(
      text.indexOf('Added by'),
    );
  });

  it('shows history paging only with a next cursor and handler, and disables it while loading', () => {
    const read = view();
    const history = read.entry.history;
    if (history === null) throw new Error('Expected entry history');
    const withCursor = withHistory(read, history.mutations, 'next-page');
    const onLoadMoreHistory = jest.fn();
    render(
      <LedgerEntryOpenArea
        entry={searchItem()}
        open={openEntry(withCursor, {
          onLoadMoreHistory,
          loadingMoreHistory: true,
        })}
        actors={ACTORS}
        now={NOW}
        showActivity
      />,
    );
    const more = byTestId('ledger-entry-history-more');
    expect(more.textContent).toBe('Loading…');
    expect(buttonByTestId('ledger-entry-history-more').disabled).toBe(true);

    render(
      <LedgerEntryOpenArea
        entry={searchItem()}
        open={openEntry(withCursor)}
        actors={ACTORS}
        now={NOW}
        showActivity
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-history-more"]'),
    ).toBeNull();

    render(
      <LedgerEntryOpenArea
        entry={searchItem()}
        open={openEntry(read, { onLoadMoreHistory })}
        actors={ACTORS}
        now={NOW}
        showActivity
      />,
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-history-more"]'),
    ).toBeNull();
  });

  it('loads more history through its stand-alone control', () => {
    const onLoadMore = jest.fn();
    render(<LedgerHistoryMore onLoadMore={onLoadMore} loading={false} />);
    const more = byTestId('ledger-entry-history-more');
    expect(more.textContent).toBe('Show more changes');
    act(() => more.click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
