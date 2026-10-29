/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
} from '@canopy/desktop-shared/types';
import {
  useComposerInventoryCommands,
  type ComposerInventoryCommandOptions,
} from '../useComposerInventoryCommands';

type HookResult = ReturnType<typeof useComposerInventoryCommands>;
type CommitMock = jest.Mock<
  void,
  [ChatTabPluginSelections | null, string, ((text: string) => void)?]
>;
const commitMock = (): CommitMock =>
  jest.fn<
    void,
    [ChatTabPluginSelections | null, string, ((text: string) => void)?]
  >();

interface HookProbe {
  current: HookResult | null;
}

function HookHarness({
  probe,
  options,
}: {
  probe: HookProbe;
  options: ComposerInventoryCommandOptions;
}): null {
  probe.current = useComposerInventoryCommands(options);
  return null;
}

function makeEntry(
  overrides: Partial<InvocableInventoryEntry> & { name: string },
): InvocableInventoryEntry {
  const { name } = overrides;
  return {
    id: overrides.id ?? `id:${name}`,
    provider: overrides.provider ?? 'cursor',
    kind: overrides.kind ?? 'skill',
    name,
    displayName: overrides.displayName ?? `/${name}`,
    description: overrides.description ?? `${name} description`,
    insertText: overrides.insertText ?? `/${name} `,
    invocationKey: overrides.invocationKey ?? `/${name}`,
    enableRef:
      overrides.enableRef ??
      ({ kind: 'skill', sourceId: 'src-1', skillName: name } as const),
    ...overrides,
  };
}

describe('useComposerInventoryCommands', () => {
  let container: HTMLDivElement;
  let root: Root;
  let list: jest.Mock;
  let resolveSelection: jest.Mock;

  beforeEach(() => {
    list = jest.fn(() =>
      Promise.resolve({
        success: true,
        data: { entries: [], stale: false, rebuilding: false },
      }),
    );
    resolveSelection = jest.fn();
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list,
        refresh: jest.fn(),
        resolveSelection,
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: { prepareCodexCompatibilityPlugin: jest.fn() },
    });
    Object.defineProperty(window, 'collections', {
      configurable: true,
      value: { loadCollection: jest.fn(() => Promise.resolve(null)) },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderWith(
    entry: InvocableInventoryEntry,
    commit: CommitMock,
  ): Promise<HookProbe> {
    list.mockResolvedValue({
      success: true,
      data: { entries: [entry], stale: false, rebuilding: false },
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(
        <HookHarness
          probe={probe}
          options={{
            providerType: 'cursor',
            discoveredCommands: [],
            discoveryLoading: false,
            includeInventory: true,
            isCurrent: () => true,
            commit,
            onError: jest.fn(),
          }}
        />,
      );
      await Promise.resolve();
    });
    return probe;
  }

  it('commits an inherited row with no selection to write, so a consumer without onInserted still inserts the text', async () => {
    // The configuration composer inserts text and clears its pending flag
    // only inside `commit`; an inherited row enables nothing, so it must
    // still reach `commit`, with `null` where the selections would be.
    const entry = makeEntry({
      id: 'cursor:inherited_skill:claude:review',
      name: 'review',
      kind: 'inherited_skill',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    resolveSelection.mockResolvedValue({
      success: true,
      data: { insertText: '/review-1 ', invocationKey: '/review-1' },
    });
    const commit = commitMock();
    const probe = await renderWith(entry, commit);

    let status: unknown;
    await act(async () => {
      status = await probe.current?.runInventoryCommand(entry);
    });

    expect(status).toBe('inserted');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(null, '/review-1 ', undefined);
  });

  it('commits the merged selections for a row that enables something', async () => {
    const entry = makeEntry({ name: 'review' });
    resolveSelection.mockResolvedValue({
      success: true,
      data: { insertText: '/review ', invocationKey: '/review' },
    });
    const commit = commitMock();
    const probe = await renderWith(entry, commit);

    await act(async () => {
      await probe.current?.runInventoryCommand(entry);
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toMatchObject({
      skillRefs: [{ sourceId: 'src-1', skillName: 'review' }],
    });
    expect(commit.mock.calls[0][1]).toBe('/review ');
  });
});
