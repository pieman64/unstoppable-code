/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InvocableInventoryEntry,
  InvocableInventoryProvider,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  resetInvocableInventoryCacheForTests,
  useInvocableInventory,
} from '../useInvocableInventory';

interface HookProbe {
  current: ReturnType<typeof useInvocableInventory> | null;
}

type InvocableInventoryListResult = Awaited<
  ReturnType<NonNullable<Window['invocableInventory']>['list']>
>;

function HookHarness({
  probe,
  provider,
}: {
  probe: HookProbe;
  provider: InvocableInventoryProvider | null | undefined;
}): null {
  probe.current = useInvocableInventory(provider);
  return null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value): void => resolvePromise?.(value),
  };
}

function makeEntry(
  provider: InvocableInventoryProvider,
  name: string,
): InvocableInventoryEntry {
  const prefix = provider === 'codex' ? '$builtin-app-plugin:' : '/';
  const invocationKey = `${prefix}${name}`;
  return {
    id: `${provider}:skill:source:${name}`,
    provider,
    kind: 'skill',
    name,
    displayName: invocationKey,
    description: `${name} description`,
    insertText: `${invocationKey} `,
    invocationKey,
    enableRef: { kind: 'skill', sourceId: 'source', skillName: name },
  };
}

function inventoryListResult(
  entries: InvocableInventoryEntry[],
  options: { stale?: boolean; rebuilding?: boolean } = {},
): InvocableInventoryListResult {
  return {
    success: true,
    data: {
      entries,
      stale: options.stale ?? false,
      rebuilding: options.rebuilding ?? false,
    },
  };
}

describe('useInvocableInventory', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalInvocableInventory: Window['invocableInventory'] | undefined;
  let originalFeatureFlagSnapshot = useFeatureFlagsStore.getState().snapshot;
  let originalWorkspaceGeneration =
    useWorkspaceContextStore.getState().appliedGeneration;

  beforeEach(() => {
    originalInvocableInventory = window.invocableInventory;
    originalFeatureFlagSnapshot = useFeatureFlagsStore.getState().snapshot;
    originalWorkspaceGeneration =
      useWorkspaceContextStore.getState().appliedGeneration;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetInvocableInventoryCacheForTests();
    useFeatureFlagsStore.setState({ snapshot: originalFeatureFlagSnapshot });
    useWorkspaceContextStore.setState({
      appliedGeneration: originalWorkspaceGeneration,
    });
    container.remove();
    if (originalInvocableInventory === undefined) {
      Reflect.deleteProperty(window, 'invocableInventory');
    } else {
      Object.defineProperty(window, 'invocableInventory', {
        configurable: true,
        value: originalInvocableInventory,
      });
    }
  });

  it('clears previous-provider rows when the next provider is rebuilding with no rows', async () => {
    const claudeEntry = makeEntry('claude', 'claude-skill');
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: { entries: [claudeEntry], stale: false, rebuilding: false },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { entries: [], stale: true, rebuilding: true },
      });
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="claude" />);
      await Promise.resolve();
    });
    expect(probe.current?.entries).toEqual([claudeEntry]);

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="codex" />);
      await Promise.resolve();
    });

    expect(list).toHaveBeenLastCalledWith({ providerType: 'codex' });
    expect(probe.current?.entries).toEqual([]);
    expect(probe.current?.stale).toBe(true);
  });

  it('shares one list response and entries array between instances for the same provider', async () => {
    const entry = makeEntry('claude', 'shared-skill');
    const list = jest.fn().mockResolvedValue({
      success: true,
      data: { entries: [entry], stale: false, rebuilding: false },
    });
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const firstProbe: HookProbe = { current: null };
    const secondProbe: HookProbe = { current: null };

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={firstProbe} provider="claude" />
          <HookHarness probe={secondProbe} provider="claude" />
        </>,
      );
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(firstProbe.current?.entries).toBe(secondProbe.current?.entries);
    expect(firstProbe.current?.entries).toEqual([entry]);
  });

  it('reload lists the cache again so the backend can re-check folders Canopy never writes', async () => {
    const entry = makeEntry('cursor', 'home-skill');
    const later = makeEntry('cursor', 'plugin-skill');
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: { entries: [entry], stale: false, rebuilding: false },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { entries: [entry, later], stale: false, rebuilding: false },
      });
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="cursor" />);
      await Promise.resolve();
    });
    expect(probe.current?.entries).toEqual([entry]);

    // The composer menu opened: ask for the cache again without forcing a
    // rebuild (that is `refresh`).
    await act(async () => {
      await probe.current?.reload();
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ providerType: 'cursor' });
    expect(probe.current?.entries).toEqual([entry, later]);
  });

  it('keeps a stable entries reference when an inventory-changed reload returns identical content', async () => {
    const entry = makeEntry('claude', 'claude-skill');
    // Distinct object identities with identical content on each list() call, so
    // only content-based deduping (not reference equality) can keep the array
    // stable.
    const list = jest.fn().mockImplementation(() =>
      Promise.resolve({
        success: true,
        data: {
          entries: [{ ...entry }],
          stale: false,
          rebuilding: false,
        },
      }),
    );
    let changedCallback: (() => void) | undefined;
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((cb: () => void): (() => void) => {
          changedCallback = cb;
          return () => undefined;
        }),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="claude" />);
      await Promise.resolve();
    });
    const firstEntries = probe.current?.entries;
    expect(firstEntries).toEqual([entry]);

    // Simulate the backend broadcasting an inventory-changed event after a
    // background rebuild that produced identical content.
    await act(async () => {
      changedCallback?.();
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(2);
    // Same reference => derived mention index stays stable => no chat re-render.
    expect(probe.current?.entries).toBe(firstEntries);
  });

  it('publishes changed broadcast rows to every instance for that provider', async () => {
    const firstEntry = makeEntry('claude', 'first-skill');
    const changedEntry = makeEntry('claude', 'changed-skill');
    const list = jest
      .fn()
      .mockResolvedValueOnce(inventoryListResult([firstEntry]))
      .mockResolvedValueOnce(inventoryListResult([changedEntry]));
    let changedCallback: (() => void) | undefined;
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((callback: () => void): (() => void) => {
          changedCallback = callback;
          return () => undefined;
        }),
      },
    });
    const firstProbe: HookProbe = { current: null };
    const secondProbe: HookProbe = { current: null };

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={firstProbe} provider="claude" />
          <HookHarness probe={secondProbe} provider="claude" />
        </>,
      );
      await Promise.resolve();
    });
    const initialEntries = firstProbe.current?.entries;
    expect(initialEntries).toEqual([firstEntry]);

    await act(async () => {
      changedCallback?.();
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(firstProbe.current?.entries).not.toBe(initialEntries);
    expect(firstProbe.current?.entries).toBe(secondProbe.current?.entries);
    expect(firstProbe.current?.entries).toEqual([changedEntry]);
  });

  it('keeps the visible rows while a rebuilding placeholder has no entries', async () => {
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    const flagKey = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: { ...snapshot.values, [flagKey]: false },
      },
    });
    const entry = makeEntry('cursor', 'home-skill');
    const list = jest
      .fn()
      .mockResolvedValueOnce(inventoryListResult([entry]))
      .mockResolvedValueOnce(
        inventoryListResult([], { stale: true, rebuilding: true }),
      );
    let changedCallback: (() => void) | undefined;
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((callback: () => void): (() => void) => {
          changedCallback = callback;
          return () => undefined;
        }),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="cursor" />);
      await Promise.resolve();
    });
    const visibleEntries = probe.current?.entries;
    expect(visibleEntries).toEqual([entry]);

    await act(async () => {
      changedCallback?.();
      await Promise.resolve();
    });

    expect(probe.current?.entries).toBe(visibleEntries);
    expect(probe.current?.stale).toBe(true);
  });

  it('keeps another provider cache intact when one instance switches providers', async () => {
    const claudeEntry = makeEntry('claude', 'claude-skill');
    const codexEntry = makeEntry('codex', 'codex-skill');
    const cursorEntry = makeEntry('cursor', 'cursor-skill');
    const entriesByProvider = new Map<
      InvocableInventoryProvider,
      InvocableInventoryEntry[]
    >([
      ['claude', [claudeEntry]],
      ['codex', [codexEntry]],
      ['cursor', [cursorEntry]],
    ]);
    const list = jest.fn(
      ({ providerType }: { providerType: InvocableInventoryProvider | null }) =>
        Promise.resolve(
          inventoryListResult(
            providerType === null
              ? []
              : (entriesByProvider.get(providerType) ?? []),
          ),
        ),
    );
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const switchingProbe: HookProbe = { current: null };
    const steadyProbe: HookProbe = { current: null };

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={switchingProbe} provider="claude" />
          <HookHarness probe={steadyProbe} provider="codex" />
        </>,
      );
      await Promise.resolve();
    });
    const codexEntries = steadyProbe.current?.entries;
    expect(switchingProbe.current?.entries).toEqual([claudeEntry]);
    expect(codexEntries).toEqual([codexEntry]);

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={switchingProbe} provider="cursor" />
          <HookHarness probe={steadyProbe} provider="codex" />
        </>,
      );
      await Promise.resolve();
    });

    expect(switchingProbe.current?.entries).toEqual([cursorEntry]);
    expect(steadyProbe.current?.entries).toBe(codexEntries);
    expect(list).toHaveBeenCalledWith({ providerType: 'cursor' });
  });

  it('loads the null provider filter independently from a provider-specific filter', async () => {
    const claudeEntry = makeEntry('claude', 'claude-skill');
    const codexEntry = makeEntry('codex', 'codex-skill');
    const list = jest.fn(
      ({ providerType }: { providerType: InvocableInventoryProvider | null }) =>
        Promise.resolve(
          inventoryListResult(
            providerType === null ? [claudeEntry, codexEntry] : [claudeEntry],
          ),
        ),
    );
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const allProbe: HookProbe = { current: null };
    const claudeProbe: HookProbe = { current: null };

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={allProbe} provider={null} />
          <HookHarness probe={claudeProbe} provider="claude" />
        </>,
      );
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith({ providerType: null });
    expect(list).toHaveBeenCalledWith({ providerType: 'claude' });
    expect(allProbe.current?.entries).toEqual([claudeEntry, codexEntry]);
    expect(claudeProbe.current?.entries).toEqual([claudeEntry]);
  });

  it('does not list when the provider filter is undefined', async () => {
    const list = jest.fn();
    const refresh = jest.fn();
    const onChanged = jest.fn();
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: { list, refresh, onChanged },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider={undefined} />);
      await Promise.resolve();
    });
    await act(async () => {
      await probe.current?.reload();
      await probe.current?.refresh();
    });

    expect(probe.current).toMatchObject({
      entries: [],
      loading: false,
      stale: false,
    });
    expect(list).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('unsubscribes from inventory changes when the last instance unmounts', async () => {
    const list = jest.fn().mockResolvedValue(inventoryListResult([]));
    const unsubscribe = jest.fn();
    const onChanged = jest.fn(() => unsubscribe);
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: { list, refresh: jest.fn(), onChanged },
    });
    const firstProbe: HookProbe = { current: null };
    const secondProbe: HookProbe = { current: null };

    await act(async () => {
      root.render(
        <>
          <HookHarness probe={firstProbe} provider="claude" />
          <HookHarness probe={secondProbe} provider="codex" />
        </>,
      );
      await Promise.resolve();
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    act(() => {
      root.render(null);
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores a list response from an earlier workspace-context generation', async () => {
    const previousSnapshot = useFeatureFlagsStore.getState().snapshot;
    const initialGeneration =
      useWorkspaceContextStore.getState().appliedGeneration;
    const flagKey = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...previousSnapshot,
        values: { ...previousSnapshot.values, [flagKey]: true },
      },
    });
    useWorkspaceContextStore.setState({ appliedGeneration: initialGeneration });

    const firstList = deferred<InvocableInventoryListResult>();
    const secondList = deferred<InvocableInventoryListResult>();
    const staleEntry = makeEntry('claude', 'stale-context-skill');
    const currentEntry = makeEntry('claude', 'current-context-skill');
    const list = jest
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise);
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="claude" />);
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(1);

    act(() => {
      useWorkspaceContextStore.setState({
        appliedGeneration: initialGeneration + 1,
      });
    });

    await act(async () => {
      firstList.resolve(inventoryListResult([staleEntry]));
      await firstList.promise;
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.current?.entries).toEqual([]);

    await act(async () => {
      secondList.resolve(inventoryListResult([currentEntry]));
      await secondList.promise;
      await Promise.resolve();
    });
    expect(probe.current?.entries).toEqual([currentEntry]);
  });

  it('drops the previous workspace context rows as soon as the context changes', async () => {
    const previousSnapshot = useFeatureFlagsStore.getState().snapshot;
    const initialGeneration =
      useWorkspaceContextStore.getState().appliedGeneration;
    const flagKey = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...previousSnapshot,
        values: { ...previousSnapshot.values, [flagKey]: true },
      },
    });
    useWorkspaceContextStore.setState({ appliedGeneration: initialGeneration });

    const previousEntry = makeEntry('claude', 'previous-context-skill');
    const currentEntry = makeEntry('claude', 'current-context-skill');
    const secondList = deferred<InvocableInventoryListResult>();
    const list = jest
      .fn()
      .mockResolvedValueOnce(inventoryListResult([previousEntry]))
      .mockReturnValueOnce(secondList.promise);
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    const probe: HookProbe = { current: null };

    await act(async () => {
      root.render(<HookHarness probe={probe} provider="claude" />);
      await Promise.resolve();
    });
    expect(probe.current?.entries).toEqual([previousEntry]);

    await act(async () => {
      useWorkspaceContextStore.setState({
        appliedGeneration: initialGeneration + 1,
      });
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.current?.entries).toEqual([]);

    await act(async () => {
      secondList.resolve(inventoryListResult([currentEntry]));
      await secondList.promise;
      await Promise.resolve();
    });
    expect(probe.current?.entries).toEqual([currentEntry]);
  });
});
