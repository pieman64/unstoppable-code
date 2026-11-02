/** @jest-environment jsdom */
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import {
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  type LifecycleJournalInspection,
  type LifecycleJournalQuarantineResult,
  type LifecycleJournalUnreadableEntry,
} from '@canopy/protocol/portal/lifecycle-journal';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID,
  LifecycleJournalQuarantineHost,
} from '../LifecycleJournalQuarantineHost';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const NAME = `${'a'.repeat(64)}.json`;
const ENTRY: LifecycleJournalUnreadableEntry = {
  name: NAME,
  kind: 'file',
  identity: '1:2:3',
  identityVerified: true,
};
const UNREADABLE: LifecycleJournalInspection = {
  status: 'unreadable-entries',
  locationLabel: '/data/w5/destructive-lifecycles',
  quarantineLocationLabel: '/data/w5/quarantined-lifecycles',
  entries: [ENTRY],
};
const CLEAR: LifecycleJournalInspection = {
  status: 'clear',
  locationLabel: '/data/w5/destructive-lifecycles',
};
const MOVED: LifecycleJournalQuarantineResult = {
  status: 'quarantined',
  name: NAME,
  quarantinedName: `20261029T000000000Z-abcdef12-${NAME}`,
  quarantineLocationLabel: '/data/w5/quarantined-lifecycles',
};

interface Fake {
  readonly client: CanopyClient;
  readonly calls: Array<{ name: CommandName; args: unknown }>;
}

function fakeClient(
  inspections: Array<LifecycleJournalInspection | Error>,
  quarantine: () => Promise<LifecycleJournalQuarantineResult> = () =>
    Promise.resolve(MOVED),
  supported = true,
): Fake {
  const calls: Fake['calls'] = [];
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'crud-only',
    routing: 'url',
    overviewNotifications: true,
    ...(supported ? { lifecycleJournalQuarantine: true } : {}),
  };
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName, args: unknown): Promise<unknown> {
    calls.push({ name, args });
    if (name === 'lifecycleJournal.inspect') {
      const next = inspections.shift() ?? CLEAR;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }
    if (name === 'lifecycleJournal.quarantine') return quarantine();
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  const client: CanopyClient = {
    capabilities,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      void args;
      return Promise.reject(new Error(`Unexpected query: ${name}`));
    },
    command,
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  return { client, calls };
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
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}
function dialogText(): string {
  return byTestId(LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID)?.textContent ?? '';
}
async function offer(error: unknown): Promise<boolean> {
  let offered = false;
  await act(async () => {
    offered = offerLifecycleJournalQuarantine(error);
    await Promise.resolve();
  });
  await flush();
  return offered;
}
function confirmButton(): HTMLButtonElement {
  const button = byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-confirm`);
  if (!(button instanceof HTMLButtonElement))
    throw new Error('Missing confirm button');
  return button;
}

it('opens only for the unreadable-journal refusal, with the disclosures, and moves the confirmed entry', async () => {
  const fake = fakeClient([
    {
      ...UNREADABLE,
      entries: [
        {
          ...ENTRY,
          match: {
            kind: 'worktree',
            workspaceId: 'a',
            worktreeId: 'one',
            projectName: 'Original',
            worktreeName: 'old',
          },
        },
      ],
    },
    CLEAR,
  ]);
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );

  expect(await offer(new Error('Something else failed'))).toBe(false);
  expect(byTestId(LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID)).toBeNull();
  expect(fake.calls).toEqual([]);

  // Electron's IPC wrapper and the Portal prefix still carry the refusal.
  expect(
    await offer(
      new Error(
        `Error invoking remote method 'workspace:delete': W5CommitRefusedError: ${LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL}`,
      ),
    ),
  ).toBe(true);
  const text = dialogText();
  expect(text).toContain('Move unreadable record to quarantine?');
  expect(text).toContain('Its owner can’t be determined.');
  expect(text).toContain(
    'It may have been protecting recovery data for a project.',
  );
  expect(text).toContain(
    'Moving it lets deleting, archiving and background cleanup resume for all projects.',
  );
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-name`)?.textContent,
  ).toBe(NAME);
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-location`)?.textContent,
  ).toBe(UNREADABLE.locationLabel);
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-match`)?.textContent,
  ).toBe('Its file name matches the worktree “old” in “Original”.');
  expect(confirmButton().disabled).toBe(false);

  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(fake.calls).toEqual([
    { name: 'lifecycleJournal.inspect', args: {} },
    {
      name: 'lifecycleJournal.quarantine',
      args: { name: NAME, identity: ENTRY.identity },
    },
    { name: 'lifecycleJournal.inspect', args: {} },
  ]);
  expect(dialogText()).toContain('Record moved to quarantine');
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-moved-name`)?.textContent,
  ).toBe(MOVED.quarantinedName);
});

it('names no project for an unmatched entry and refuses an unverifiable one', async () => {
  const fake = fakeClient([
    { ...UNREADABLE, entries: [{ ...ENTRY, identityVerified: false }] },
  ]);
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  expect(byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-match`)).toBeNull();
  expect(dialogText()).not.toContain('matches');
  expect(dialogText()).toContain('Move it manually.');
  expect(confirmButton().disabled).toBe(true);
});

it('keeps the review open with the plain refusal and re-reads the entry when the move fails', async () => {
  const replaced = { ...ENTRY, identity: '1:2:4' };
  const fake = fakeClient(
    [UNREADABLE, { ...UNREADABLE, entries: [replaced] }],
    () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'lifecycle-journal:quarantine': LifecycleJournalQuarantineRefusedError: This record changed after you reviewed it, so it was not moved. Review it again.",
        ),
      ),
  );
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(byTestId('confirm-dialog-error')?.textContent).toBe(
    'This record changed after you reviewed it, so it was not moved. Review it again.',
  );
  expect(dialogText()).toContain('Move unreadable record to quarantine?');

  // A second confirm moves what is there now, not the stale identity.
  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(
    fake.calls
      .filter((call) => call.name === 'lifecycleJournal.quarantine')
      .map((call) => call.args),
  ).toEqual([
    { name: NAME, identity: ENTRY.identity },
    { name: NAME, identity: replaced.identity },
  ]);
});

it('keeps an unconfirmed move visible when the re-read finds nothing left', async () => {
  const unconfirmed =
    "The record was moved, but saving the move couldn't be confirmed. Review it again before you continue.";
  const fake = fakeClient([UNREADABLE, CLEAR], () =>
    Promise.reject(new Error(unconfirmed)),
  );
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(dialogText()).toContain('No unreadable records');
  expect(byTestId('confirm-dialog-error')?.textContent).toBe(unconfirmed);
});

it('a failed move whose re-read also fails offers only a fresh check, never the reviewed identity', async () => {
  // An unconfirmed move may already have renamed the entry.
  const unconfirmed =
    "The record was moved, but saving the move couldn't be confirmed. Review it again before you continue.";
  const fake = fakeClient([UNREADABLE, new Error('Desktop unreachable')], () =>
    Promise.reject(new Error(unconfirmed)),
  );
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(dialogText()).not.toContain('Move unreadable record to quarantine?');
  expect(dialogText()).toContain(unconfirmed);
  expect(confirmButton().textContent).toContain('Try again');

  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(fake.calls.map((call) => call.name)).toEqual([
    'lifecycleJournal.inspect',
    'lifecycleJournal.quarantine',
    'lifecycleJournal.inspect',
    'lifecycleJournal.inspect',
  ]);
  expect(dialogText()).toContain('No unreadable records');
});

it('a successful move whose re-read fails offers only a fresh check, never the moved entry', async () => {
  const fake = fakeClient([UNREADABLE, new Error('Desktop unreachable')]);
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(dialogText()).toContain('Record moved to quarantine');
  expect(dialogText()).not.toContain('Move unreadable record to quarantine?');
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-moved-name`)?.textContent,
  ).toBe(MOVED.quarantinedName);
  expect(confirmButton().textContent).toContain('Check again');

  await act(async () => {
    confirmButton().click();
    await Promise.resolve();
  });
  await flush();
  expect(fake.calls.map((call) => call.name)).toEqual([
    'lifecycleJournal.inspect',
    'lifecycleJournal.quarantine',
    'lifecycleJournal.inspect',
    'lifecycleJournal.inspect',
  ]);
  expect(dialogText()).toContain('No unreadable records');
});

it('reports an unlistable journal folder without offering a move', async () => {
  const fake = fakeClient([
    {
      status: 'directory-unreadable',
      locationLabel: '/data/w5/destructive-lifecycles',
    },
  ]);
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL));
  expect(dialogText()).toContain('Operation records can’t be listed');
  expect(
    byTestId(`${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}-location`)?.textContent,
  ).toBe('/data/w5/destructive-lifecycles');
  expect(confirmButton().textContent).toContain('Check again');
  expect(fake.calls.map((call) => call.name)).toEqual([
    'lifecycleJournal.inspect',
  ]);
});

it('a host without the capability renders nothing and asks nothing', async () => {
  const fake = fakeClient([UNREADABLE], undefined, false);
  act(() =>
    root.render(<LifecycleJournalQuarantineHost client={fake.client} />),
  );
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  expect(byTestId(LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID)).toBeNull();
  expect(fake.calls).toEqual([]);
});
