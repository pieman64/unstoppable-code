// Static source-level coverage follows the renderer component test pattern for
// large chat surfaces whose full store graph is expensive to mount.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
  ResolveInvocableSelectionResponse,
} from '@canopy/desktop-shared/types';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import {
  runInventorySelection,
  type RunInventorySelectionDeps,
} from '@/lib/slashInvocableInventory';

const CHAT_INPUT_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatInput.tsx'),
  'utf8',
);

/**
 * Exercises the enable-and-insert flow that `ChatInput.handleSelectCommand`
 * runs for an "available to enable" typeahead row. The orchestration lives in
 * `runInventorySelection`; these tests assert ordering and the abort-before-
 * mutate guarantees the plan requires.
 */

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

function skillEntry(
  overrides: Partial<InvocableInventoryEntry> = {},
): InvocableInventoryEntry {
  return {
    id: 'id:alpha',
    provider: 'claude',
    kind: 'skill',
    name: 'alpha',
    displayName: '/alpha',
    description: 'Alpha skill',
    insertText: '/alpha ',
    invocationKey: 'claude:alpha',
    enableRef: { kind: 'skill', sourceId: 'src-1', skillName: 'alpha' },
    ...overrides,
  };
}

function codexCompatEntry(): InvocableInventoryEntry {
  return {
    id: 'id:compat',
    provider: 'codex',
    kind: 'plugin_command',
    name: 'compat-cmd',
    displayName: '$pl:compat-cmd',
    description: 'Compat command',
    insertText: '$pl:compat-cmd ',
    invocationKey: 'codex:compat',
    enableRef: { kind: 'plugin', marketplaceId: 'mkt', pluginName: 'pl' },
    sourceName: 'compat-cmd',
    requiresCodexCompatPrepare: true,
  };
}

interface Harness {
  deps: RunInventorySelectionDeps;
  calls: string[];
  applied: ChatTabPluginSelections | null;
  inserted: string | null;
}

function makeHarness(
  options: {
    resolve?: IPCResult<ResolveInvocableSelectionResponse>;
    resolveThrows?: boolean;
    prepare?: IPCResult<PluginInfo>;
    prepareThrows?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const harness: Harness = {
    calls,
    applied: null,
    inserted: null,
    deps: {
      prepareCodexCompatibilityPlugin: (): Promise<IPCResult<PluginInfo>> => {
        calls.push('prepare');
        if (options.prepareThrows) {
          return Promise.reject(new Error('prepare boom'));
        }
        return Promise.resolve(options.prepare ?? { success: true });
      },
      resolveSelection: (): Promise<
        IPCResult<ResolveInvocableSelectionResponse>
      > => {
        calls.push('resolve');
        if (options.resolveThrows) {
          return Promise.reject(new Error('resolve boom'));
        }
        return Promise.resolve(
          options.resolve ?? {
            success: true,
            data: { insertText: '/alpha ', invocationKey: 'claude:alpha' },
          },
        );
      },
      applySelections: (next): void => {
        calls.push('apply');
        harness.applied = next;
      },
      insertResolvedText: (text): void => {
        calls.push('insert');
        harness.inserted = text;
      },
      onError: (): void => {
        calls.push('error');
      },
      refreshInventory: (): void => {
        calls.push('refresh');
      },
    },
  };
  return harness;
}

describe('runInventorySelection', () => {
  it('resolves, then enables, then inserts (in order) for a plain skill', async () => {
    const harness = makeHarness({
      resolve: {
        success: true,
        data: { insertText: '/alpha ', invocationKey: 'claude:alpha' },
      },
    });

    const status = await runInventorySelection({
      entry: skillEntry(),
      providerType: 'claude',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(status).toBe('inserted');
    expect(harness.calls).toEqual(['resolve', 'apply', 'insert']);
    expect(harness.applied?.skillRefs).toEqual([
      { sourceId: 'src-1', skillName: 'alpha' },
    ]);
  });

  it('inserts the RESOLVED invocation text, not the cached entry.insertText', async () => {
    const harness = makeHarness({
      resolve: {
        success: true,
        data: {
          insertText: '$builtin-app-plugin:alpha-2 ',
          invocationKey: 'codex:alpha',
        },
      },
    });

    await runInventorySelection({
      // Cached value is provisional and intentionally different.
      entry: skillEntry({
        provider: 'codex',
        insertText: '$builtin-app-plugin:alpha ',
      }),
      providerType: 'codex',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(harness.inserted).toBe('$builtin-app-plugin:alpha-2 ');
  });

  it('runs Codex-compat prepare before resolving when required', async () => {
    const harness = makeHarness({
      resolve: {
        success: true,
        data: { insertText: '$pl:compat-cmd ', invocationKey: 'codex:compat' },
      },
    });

    const status = await runInventorySelection({
      entry: codexCompatEntry(),
      providerType: 'codex',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(status).toBe('inserted');
    expect(harness.calls).toEqual(['prepare', 'resolve', 'apply', 'insert']);
    expect(harness.applied?.pluginRefs).toEqual([
      { marketplaceId: 'mkt', pluginName: 'pl' },
    ]);
  });

  it('aborts without enabling/inserting when resolveSelection reports success:false', async () => {
    const harness = makeHarness({
      resolve: { success: false, error: 'removed' },
    });

    const status = await runInventorySelection({
      entry: skillEntry(),
      providerType: 'claude',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(status).toBe('resolve-failed');
    expect(harness.calls).toContain('resolve');
    expect(harness.calls).not.toContain('apply');
    expect(harness.calls).not.toContain('insert');
    // The stale row triggers an inventory refresh.
    expect(harness.calls).toContain('refresh');
    expect(harness.calls).toContain('error');
  });

  it('does not insert when Codex-compat prepare fails', async () => {
    const harness = makeHarness({
      prepare: { success: false, error: 'prepare failed' },
    });

    const status = await runInventorySelection({
      entry: codexCompatEntry(),
      providerType: 'codex',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(status).toBe('prepare-failed');
    expect(harness.calls).toEqual(['prepare', 'error']);
    // Never reaches resolve / enable / insert.
    expect(harness.calls).not.toContain('resolve');
    expect(harness.calls).not.toContain('apply');
    expect(harness.calls).not.toContain('insert');
  });

  it('treats a thrown resolveSelection as a failure (no enable/insert)', async () => {
    const harness = makeHarness({ resolveThrows: true });

    const status = await runInventorySelection({
      entry: skillEntry(),
      providerType: 'claude',
      currentSelections: emptySelections(),
      deps: harness.deps,
    });

    expect(status).toBe('resolve-failed');
    expect(harness.calls).not.toContain('apply');
    expect(harness.calls).not.toContain('insert');
    expect(harness.calls).toContain('error');
  });
});

describe('ChatInput inventory command surfaces', () => {
  it('uses the targetOverride-aware chat target for slash inventory commands', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      'const slashCommandTarget = useMemo(() => {',
    );
    expect(CHAT_INPUT_SOURCE).toMatch(
      /if\s*\(\s*!slashCommandTarget\s*\|\|\s*isAccountHarness\s*\)\s*return\s*\{\s*allCommands:\s*\[\],\s*isRefreshing:\s*false\s*\};/,
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'const wtKey = `${slashCommandTarget.projectId}/${slashCommandTarget.worktreeId}`;',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'if (!slashCommandTarget || !tab) return;',
    );

    const handleSelectIndex = CHAT_INPUT_SOURCE.indexOf(
      'const handleSelectCommand = useCallback',
    );
    const handleSelectBlock = CHAT_INPUT_SOURCE.slice(
      handleSelectIndex,
      CHAT_INPUT_SOURCE.indexOf('const handleCheckStatus', handleSelectIndex),
    );
    expect(handleSelectBlock).toMatch(
      /if\s*\(\s*!entry\s*\|\|\s*!slashCommandTarget\s*\|\|\s*!tab\s*\|\|\s*!inventoryProviderType\s*\)\s*\{/,
    );
    expect(handleSelectBlock).not.toContain('!selectedWorktree');
  });

  it('strips Agent-only selections before persisting inventory enables', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      'currentSelections: effectivePluginSelections ?? createEmptySelections()',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'stripAgentOnlyChatPluginSelections(\n                next,\n                agentPluginSelections,\n                pluginSelections,',
    );
  });

  it('refreshes discovery for all worktree tabs when Agent selections change', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      'const agentPluginSelections = useModelCatalogStore(\n    useShallow((state) =>',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'state.snapshot?.agents?.find(\n            (entry) => entry.id === getAgentModelSelectionId(model),\n          )?.pluginSelections',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      '[agentPluginSelections, displayedPluginSelections]',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'previousAgentPluginSelectionsRef.current = agentPluginSelections;',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'if (previousAgentPluginSelections === agentPluginSelections) return;',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'refreshWorktreeTabDiscoveries(\n      slashCommandTarget.projectId,\n      slashCommandTarget.worktreeId,',
    );
  });
});
