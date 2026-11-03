/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SharedCollectionDocument,
  SharedCollectionComparisonDetail,
} from '@canopy/protocol/collections';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import type {
  CollectionLocalMembers,
  CollectionUpdatePorts,
} from '../collectionUpdateSummary';
import { useCollectionUpdateSummaries } from '../useCollectionUpdateSummaries';

const ENTRY_ID = 'collection:local:local-1';

function entry(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id: ENTRY_ID,
    kind: 'collection',
    origin: 'installed-standalone',
    name: 'Design review',
    description: '',
    categories: [],
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: false, codex: false },
    state: 'installed',
    recommended: false,
    updateAvailable: true,
    sharedSource: {
      remoteId: 's1',
      installedContentHash: 'a',
      latestContentHash: 'b',
      sharedBy: 'Priya Shah',
      latestItemCounts: { skills: 2, plugins: 0 },
    },
    ref: { type: 'local-collection', collectionId: 'local-1' },
    ...overrides,
  };
}

const LOCAL: CollectionLocalMembers = {
  skills: [{ sourceId: 'github:acme:skills', skillName: 'review' }],
  plugins: [],
};

const LIVE: SharedCollectionDocument = {
  version: 1,
  name: 'Design review',
  description: '',
  items: [
    {
      type: 'skill',
      source: { type: 'github', repo: 'acme/skills' },
      skill_name: 'review',
    },
    {
      type: 'skill',
      source: { type: 'github', repo: 'acme/skills' },
      skill_name: 'figma-handoff',
    },
  ],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let latest: ReadonlyMap<string, string> = new Map();

function Probe({
  entries,
  ports,
}: {
  entries: readonly UnifiedPluginEntry[];
  ports: CollectionUpdatePorts | null;
}): JSX.Element | null {
  latest = useCollectionUpdateSummaries(entries, ports);
  return null;
}

function render(
  entries: readonly UnifiedPluginEntry[],
  ports: CollectionUpdatePorts | null,
): void {
  act(() => {
    root.render(<Probe entries={entries} ports={ports} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  latest = new Map();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCollectionUpdateSummaries', () => {
  it('shows a generic fallback first and the named diff once both loads resolve', async () => {
    const local = deferred<CollectionLocalMembers | null>();
    const shared = deferred<SharedCollectionComparisonDetail | null>();
    const ports: CollectionUpdatePorts = {
      loadLocalMembers: jest.fn(() => local.promise),
      loadSharedDocument: jest.fn(() => shared.promise),
    };

    render([entry()], ports);
    expect(latest.get(ENTRY_ID)).toBe('Changed the collection');
    expect(ports.loadLocalMembers).toHaveBeenCalledWith('local-1');
    expect(ports.loadSharedDocument).toHaveBeenCalledWith('s1');

    local.resolve(LOCAL);
    shared.resolve({ id: 's1', contentHash: 'b', collection: LIVE });
    await flush();
    expect(latest.get(ENTRY_ID)).toBe(
      'Priya Shah added the figma-handoff skill',
    );
  });

  it('keeps the fallback when a port rejects', async () => {
    const ports: CollectionUpdatePorts = {
      loadLocalMembers: jest.fn(() => Promise.resolve(LOCAL)),
      loadSharedDocument: jest.fn(() => Promise.reject(new Error('revoked'))),
    };

    render([entry()], ports);
    await flush();
    expect(latest.get(ENTRY_ID)).toBe('Changed the collection');
  });

  it('yields the fallback only without ports', async () => {
    render([entry()], null);
    await flush();
    expect(latest.get(ENTRY_ID)).toBe('Changed the collection');
  });

  it('ignores collections without an update or a share link', () => {
    render(
      [
        entry({ id: 'no-update', updateAvailable: false }),
        entry({ id: 'no-source', sharedSource: undefined }),
        entry({ id: 'skill', kind: 'skill' }),
      ],
      null,
    );
    expect(latest.size).toBe(0);
  });

  it('dedupes in-flight loads and reloads when the latest hash changes', async () => {
    const ports: CollectionUpdatePorts = {
      loadLocalMembers: jest.fn(() => Promise.resolve(LOCAL)),
      loadSharedDocument: jest.fn(() =>
        Promise.resolve({ id: 's1', contentHash: 'b', collection: LIVE }),
      ),
    };
    const entries = [entry()];
    render(entries, ports);
    render([...entries], ports);
    await flush();
    expect(ports.loadSharedDocument).toHaveBeenCalledTimes(1);

    const changed = entry({
      sharedSource: {
        remoteId: 's1',
        installedContentHash: 'new-installed',
        latestContentHash: 'b',
        sharedBy: 'Priya Shah',
        latestItemCounts: { skills: 2, plugins: 0 },
      },
    });
    render([changed], ports);
    await flush();
    expect(ports.loadSharedDocument).toHaveBeenCalledTimes(2);
    expect(latest.get(ENTRY_ID)).toBe(
      'Priya Shah added the figma-handoff skill',
    );
  });

  it('sets no state after unmount', async () => {
    const shared = deferred<SharedCollectionComparisonDetail | null>();
    const ports: CollectionUpdatePorts = {
      loadLocalMembers: jest.fn(() => Promise.resolve(LOCAL)),
      loadSharedDocument: jest.fn(() => shared.promise),
    };
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render([entry()], ports);
      act(() => root.unmount());
      shared.resolve({ id: 's1', contentHash: 'b', collection: LIVE });
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      root = createRoot(container);
    }
  });
  it('ignores obsolete requests across ports withdrawal and context changes', async () => {
    const old = deferred<SharedCollectionComparisonDetail | null>();
    const ports: CollectionUpdatePorts = {
      contextKey: 'a',
      loadLocalMembers: () => Promise.resolve(LOCAL),
      loadSharedDocument: () => old.promise,
    };
    render([entry()], ports);
    render([entry()], null);
    old.resolve({ id: 's1', contentHash: 'b', collection: LIVE });
    await flush();
    expect(latest.get(ENTRY_ID)).toBe('Changed the collection');
    render([entry()], {
      ...ports,
      contextKey: 'b',
      loadSharedDocument: () =>
        Promise.resolve({
          id: 's1',
          contentHash: 'b',
          collection: LIVE,
        }),
    });
    await flush();
    expect(latest.get(ENTRY_ID)).toBe(
      'Priya Shah added the figma-handoff skill',
    );
  });

  it('rejects mismatched live revisions and retries failed loads on explicit refresh', async () => {
    const onRevisionMismatch = jest.fn();
    const ports: CollectionUpdatePorts = {
      contextKey: 'a',
      onRevisionMismatch,
      loadLocalMembers: () => Promise.resolve(LOCAL),
      loadSharedDocument: () =>
        Promise.resolve({
          id: 's1',
          contentHash: 'wrong',
          collection: LIVE,
        }),
    };
    render([entry()], ports);
    await flush();
    expect(latest.get(ENTRY_ID)).toBe('Changed the collection');
    expect(onRevisionMismatch).toHaveBeenCalledTimes(1);
    render([entry()], {
      ...ports,
      refreshKey: 1,
      loadSharedDocument: () =>
        Promise.resolve({
          id: 's1',
          contentHash: 'b',
          collection: LIVE,
        }),
    });
    await flush();
    expect(latest.get(ENTRY_ID)).toBe(
      'Priya Shah added the figma-handoff skill',
    );
  });

  it('deduplicates the live read across local copies and reloads on a local edit', async () => {
    const shared = jest.fn(() =>
      Promise.resolve({
        id: 's1',
        contentHash: 'b',
        collection: LIVE,
      }),
    );
    const local = jest.fn(() => Promise.resolve(LOCAL));
    const ports: CollectionUpdatePorts = {
      loadLocalMembers: local,
      loadSharedDocument: shared,
    };
    render(
      [
        entry(),
        entry({
          id: 'copy',
          ref: { type: 'local-collection', collectionId: 'copy' },
        }),
      ],
      ports,
    );
    await flush();
    expect(shared).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(2);
    render([entry({ collectionRevision: 'changed' })], ports);
    await flush();
    expect(local).toHaveBeenCalledTimes(3);
  });
  it('bounds concurrent and retained comparison work', async () => {
    const pending = deferred<CollectionLocalMembers | null>();
    const loadLocalMembers = jest.fn(() => pending.promise);
    const loadSharedDocument = jest.fn((id: string) =>
      Promise.resolve({ id, contentHash: 'b', collection: LIVE }),
    );
    const entries = Array.from({ length: 105 }, (_, index) =>
      entry({
        id: `copy-${index}`,
        ref: { type: 'local-collection', collectionId: `local-${index}` },
        sharedSource: {
          remoteId: `remote-${index}`,
          installedContentHash: 'a',
          latestContentHash: 'b',
          latestItemCounts: { skills: 2, plugins: 0 },
        },
      }),
    );
    render(entries, { loadLocalMembers, loadSharedDocument });
    expect(loadLocalMembers).toHaveBeenCalledTimes(4);
    pending.resolve(LOCAL);
    await flush();
    expect(loadLocalMembers).toHaveBeenCalledTimes(100);
    expect(latest.size).toBe(105);
    expect(latest.get('copy-104')).toBe('Changed the collection');
  });
});

it('compares an opaque local revision instead of confusing it with a timestamp', async () => {
  render([entry({ collectionRevision: 'opaque:r2' })], {
    loadLocalMembers: () =>
      Promise.resolve({
        ...LOCAL,
        revision: 'opaque:r2',
        updatedAt: '2026-10-26T00:00:00Z',
      }),
    loadSharedDocument: () =>
      Promise.resolve({
        id: 's1',
        contentHash: 'b',
        collection: LIVE,
      }),
  });
  await flush();
  expect(latest.get(ENTRY_ID)).toBe('Priya Shah added the figma-handoff skill');
});
