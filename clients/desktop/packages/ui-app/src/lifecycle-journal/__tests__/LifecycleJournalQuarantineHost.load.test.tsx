/** @jest-environment jsdom */
import type {
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import {
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  type LifecycleJournalInspection,
} from '@canopy/protocol/portal/lifecycle-journal';
import type * as ReviewStoreModule from '@canopy/app-state/lifecycle-journal/quarantine-review-store';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID,
  LifecycleJournalQuarantineHost,
} from '../LifecycleJournalQuarantineHost';
import type * as ReviewModule from '../LifecycleJournalQuarantineReview';

// A static import of either module fails this suite at import time: the
// factories then run before these mocks exist.
const mockReviewLoad = jest.fn<void, []>();
const mockStoreLoad = jest.fn<void, []>();
jest.mock('../LifecycleJournalQuarantineReview', () => {
  mockReviewLoad();
  return jest.requireActual<typeof ReviewModule>(
    '../LifecycleJournalQuarantineReview',
  );
});
// The store module itself, however it is reached.
jest.mock('@canopy/app-state/lifecycle-journal/quarantine-review-store', () => {
  mockStoreLoad();
  return jest.requireActual<typeof ReviewStoreModule>(
    '@canopy/app-state/lifecycle-journal/quarantine-review-store',
  );
});

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const UNREADABLE: LifecycleJournalInspection = {
  status: 'unreadable-entries',
  locationLabel: '/data/w5/destructive-lifecycles',
  quarantineLocationLabel: '/data/w5/quarantined-lifecycles',
  entries: [
    {
      name: `${'a'.repeat(64)}.json`,
      kind: 'file',
      identity: '1:2:3',
      identityVerified: true,
    },
  ],
};

function fakeClient(): CanopyClient {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(name: CommandName): Promise<unknown> {
    return name === 'lifecycleJournal.inspect'
      ? Promise.resolve(UNREADABLE)
      : Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  return {
    capabilities: {
      localExecution: true,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'crud-only',
      routing: 'url',
      overviewNotifications: true,
      lifecycleJournalQuarantine: true,
    },
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

async function offer(error: unknown): Promise<void> {
  await act(async () => {
    offerLifecycleJournalQuarantine(error);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
function dialog(): HTMLElement | null {
  return document.querySelector(
    `[data-testid="${LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID}"]`,
  );
}

it('loads the review and its store only once a refusal opens it, and retries a failed load', async () => {
  const client = fakeClient();
  act(() => root.render(<LifecycleJournalQuarantineHost client={client} />));
  await offer(new Error('Something else failed'));
  expect(mockReviewLoad).not.toHaveBeenCalled();
  expect(mockStoreLoad).not.toHaveBeenCalled();

  // A failed chunk load leaves no dialog and lets the next refusal retry.
  mockReviewLoad.mockImplementationOnce(() => {
    throw new Error('ChunkLoadError');
  });
  await offer(new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL));
  expect(mockReviewLoad).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();

  // A host remounted while the review loads still opens it for that refusal.
  act(() => {
    offerLifecycleJournalQuarantine(
      new Error(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL),
    );
  });
  act(() =>
    root.render(
      <LifecycleJournalQuarantineHost key="remounted" client={client} />,
    ),
  );
  await offer(new Error('Something else failed'));
  expect(mockReviewLoad).toHaveBeenCalledTimes(2);
  expect(mockStoreLoad).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain(
    'Move unreadable record to quarantine?',
  );
});
