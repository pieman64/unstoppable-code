import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  getCanonicalCanopyToolKey,
  getCanopyInjectedAliases,
  getCanopyInjectedToolNamesForSurface,
  normalizeCanopyInjectedToolName,
  ASK_USER_TIMEOUT_MS,
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
  CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS,
  CODE_GRAPH_INJECTED_TOOL_KEYS,
  ASK_USER_TIMEOUT_MESSAGE,
  ASK_USER_TIMEOUT_ERROR,
  isLedgerInjectedToolKey,
} from '../canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getCanonicalAppAdvisorToolKey,
} from '../app-advisor-tools';
import { BRAND } from '@canopy/brand/current';

describe('ask-user _ui server move', () => {
  const ns = BRAND.tools.namespace;

  it('keeps historical native ScheduleWakeup distinct from the injected watcher tool', () => {
    expect(getCanonicalCanopyToolKey('ScheduleWakeup')).toBeNull();
    expect(
      getCanonicalCanopyToolKey(
        CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.claudeToolName,
      ),
    ).toBe('schedule_wakeup');
    expect(
      getCanonicalCanopyToolKey(
        CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.codexToolName,
      ),
    ).toBe('schedule_wakeup');
  });

  it('builds the AskUserQuestion Claude name under the _ui namespace', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.claudeToolName).toBe(
      `mcp__${ns}_ui__AskUserQuestion`,
    );
  });

  it('canonicalizes both the new _ui name and the legacy name', () => {
    expect(getCanonicalCanopyToolKey(`mcp__${ns}_ui__AskUserQuestion`)).toBe(
      'ask_user_question',
    );
    expect(getCanonicalCanopyToolKey(`mcp__${ns}__AskUserQuestion`)).toBe(
      'ask_user_question',
    );
    expect(
      getCanonicalCanopyToolKey(`mcp__${ns}_app_advisor__AskUserQuestion`),
    ).toBe('ask_user_question');
  });

  it('removes ask_user_question from the native-sdk main surface', () => {
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).not.toContain(
      'ask_user_question',
    );
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui']).toEqual([
      'ask_user_question',
    ]);
    // Cowork surface: directory-scoped action/watcher/auto-archive set,
    // including GitHub watchers, plus the Agent Ledger tools. No
    // git-preference, tracked-plan, hook, or
    // code-graph tooling.
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
    ).toEqual([
      'get_script_output',
      'start_forked_agent',
      'watch_command',
      'schedule_wakeup',
      'delete_watchers',
      'save_memory',
      'search_memory',
      'read_memory',
      'read_pipeline_yaml',
      'show_files',
      'show_capabilities',
      'show_visual',
      'preview_visual',
      'get_file_comments',
      'respond_to_file_comment',
      'search_actions',
      'dispatch_action',
      'search_watchers',
      'setup_watchers',
      'watch_github_items',
      'get_github_pull_request_status',
      'set_auto_archive',
      'search_deferred_tools',
      'load_deferred_tools',
      'add_ledger_entry',
      'search_ledger_entries',
      'update_ledger_entry',
    ]);
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).toContain(
      'get_git_preferences',
    );
  });

  it('allows delegates to discover and load deferred tools', (): void => {
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate']).toEqual(
      expect.arrayContaining(['search_deferred_tools', 'load_deferred_tools']),
    );
  });

  it('exposes the timeout constants and message', () => {
    expect(ASK_USER_TIMEOUT_MS).toBe(3_540_000);
    expect(ASK_USER_HTTP_TIMEOUT_MS).toBe(3_600_000);
    expect(CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS).toBe(600_000);
    expect(CANOPY_MCP_TOOL_TIMEOUT_MS).toBe(660_000);
    expect(ASK_USER_TIMEOUT_ERROR).toBe('ask_user_timeout');
    expect(ASK_USER_TIMEOUT_MESSAGE).toContain('again for this question');
  });
});

describe('WatchGitHubItems tool naming', () => {
  const ns = BRAND.tools.namespace;

  it('advertises the branded worktree live names', () => {
    expect(
      CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items.claudeToolName,
    ).toBe(`mcp__${ns}__WatchGitHubItems`);
    expect(CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items.codexToolName).toBe(
      `${ns}_watch_github_items`,
    );
  });

  it('advertises the branded App Advisor live names', () => {
    expect(APP_ADVISOR_TOOL_REGISTRY.watch_github_items.claudeToolName).toBe(
      `mcp__${ns}_app_advisor__WatchGitHubItems`,
    );
    expect(APP_ADVISOR_TOOL_REGISTRY.watch_github_items.codexToolName).toBe(
      `${ns}_app_advisor_watch_github_items`,
    );
  });

  it('canonicalizes the worktree live names to the shared key', () => {
    expect(getCanonicalCanopyToolKey(`mcp__${ns}__WatchGitHubItems`)).toBe(
      'watch_github_items',
    );
    expect(getCanonicalCanopyToolKey(`${ns}_watch_github_items`)).toBe(
      'watch_github_items',
    );
  });

  it('canonicalizes the App Advisor live names to the shared key', () => {
    expect(
      getCanonicalAppAdvisorToolKey(`mcp__${ns}_app_advisor__WatchGitHubItems`),
    ).toBe('watch_github_items');
    expect(
      getCanonicalAppAdvisorToolKey(`${ns}_app_advisor_watch_github_items`),
    ).toBe('watch_github_items');
    // The legacy App Advisor Codex alias still resolves for transcript display.
    expect(
      getCanonicalAppAdvisorToolKey('app_advisor_watch_github_items'),
    ).toBe('watch_github_items');
  });

  it('normalizes recognized aliases to the canonical display name', () => {
    expect(
      normalizeCanopyInjectedToolName(`mcp__${ns}__WatchGitHubItems`),
    ).toBe('WatchGitHubItems');
    expect(normalizeCanopyInjectedToolName(`${ns}_watch_github_items`)).toBe(
      'WatchGitHubItems',
    );
  });

  it('is exposed on the worktree and Cowork chat surfaces but not UI', () => {
    for (const surface of [
      'native-sdk',
      'claude-code-terminal',
      'cursor-acp',
      'native-sdk-standalone',
      'cursor-acp-standalone',
      'managed-delegate',
    ] as const)
      expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).toContain(
        'watch_github_items',
      );
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui'],
    ).not.toContain('watch_github_items');
  });
});

describe('DeleteWatchers tool naming', () => {
  const ns = BRAND.tools.namespace;

  it('advertises and canonicalizes the branded worktree names', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers.claudeToolName).toBe(
      `mcp__${ns}__DeleteWatchers`,
    );
    expect(CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers.codexToolName).toBe(
      `${ns}_delete_watchers`,
    );
    expect(getCanonicalCanopyToolKey(`mcp__${ns}__DeleteWatchers`)).toBe(
      'delete_watchers',
    );
    expect(getCanonicalCanopyToolKey(`${ns}_delete_watchers`)).toBe(
      'delete_watchers',
    );
  });

  it('does not canonicalize App Advisor names', () => {
    expect(
      getCanonicalAppAdvisorToolKey(`mcp__${ns}_app_advisor__DeleteWatchers`),
    ).toBeNull();
    expect(
      getCanonicalAppAdvisorToolKey(`${ns}_app_advisor_delete_watchers`),
    ).toBeNull();
  });

  it('is exposed on worktree and cowork chat surfaces', () => {
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).toContain(
      'delete_watchers',
    );
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
    ).toContain('delete_watchers');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
    ).toContain('delete_watchers');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui'],
    ).not.toContain('delete_watchers');
  });
});

describe('SetBaseBranch tool naming and scope', () => {
  const ns = BRAND.tools.namespace;

  it('advertises and canonicalizes the branded worktree names', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.set_base_branch.claudeToolName).toBe(
      `mcp__${ns}__SetBaseBranch`,
    );
    expect(CANOPY_INJECTED_TOOL_REGISTRY.set_base_branch.codexToolName).toBe(
      `${ns}_set_base_branch`,
    );
    expect(getCanonicalCanopyToolKey(`mcp__${ns}__SetBaseBranch`)).toBe(
      'set_base_branch',
    );
    expect(getCanonicalCanopyToolKey(`${ns}_set_base_branch`)).toBe(
      'set_base_branch',
    );
  });

  it('is exposed only on worktree-chat surfaces', () => {
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).toContain(
      'set_base_branch',
    );
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
    ).toContain('set_base_branch');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
    ).not.toContain('set_base_branch');
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui'],
    ).not.toContain('set_base_branch');
  });
});

describe('fire-and-forget agent tools', () => {
  it('has an App Advisor-specific fork name without exposing branching', () => {
    const ns = BRAND.tools.namespace;
    expect(
      getCanonicalAppAdvisorToolKey(`mcp__${ns}_app_advisor__StartForkedAgent`),
    ).toBe('start_forked_agent');
    expect(
      getCanonicalAppAdvisorToolKey(`${ns}_app_advisor_start_forked_agent`),
    ).toBe('start_forked_agent');
    expect(
      getCanonicalAppAdvisorToolKey(
        `mcp__${ns}_app_advisor__StartBranchedAgent`,
      ),
    ).toBeNull();
  });

  it.each([
    ['start_forked_agent', 'StartForkedAgent'],
    ['start_branched_agent', 'StartBranchedAgent'],
  ])('exposes %s only to its supported chat scopes', (key, display) => {
    expect(getCanonicalCanopyToolKey(`canopy_${key}`)).toBe(key);
    expect(getCanonicalCanopyToolKey(`mcp__canopy__${display}`)).toBe(key);
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).toContain(
      key,
    );
    if (key === 'start_forked_agent') {
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
      ).toContain(key);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone'],
      ).not.toContain(key);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp'],
      ).not.toContain(key);
    } else {
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp'],
      ).not.toContain(key);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
      ).not.toContain(key);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone'],
      ).not.toContain(key);
    }
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
    ).not.toContain(key);
    expect(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-worker'],
    ).not.toContain(key);
  });
});

describe('cursor-acp surface', () => {
  const ns = BRAND.tools.namespace;

  it('exposes worktree actions, watchers, memory and Ledger without forks, graph or deferred tools', () => {
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp']).toEqual([
      'get_script_output',
      'get_git_preferences',
      'save_memory',
      'search_memory',
      'read_memory',
      'read_pipeline_yaml',
      'show_files',
      'show_capabilities',
      'show_visual',
      'preview_visual',
      'get_file_comments',
      'respond_to_file_comment',
      'search_actions',
      'dispatch_action',
      'search_watchers',
      'setup_watchers',
      'watch_github_items',
      'get_github_pull_request_status',
      'watch_command',
      'schedule_wakeup',
      'delete_watchers',
      'set_auto_archive',
      'set_base_branch',
      'add_ledger_entry',
      'search_ledger_entries',
      'update_ledger_entry',
    ]);
  });

  it('names each tool the way the pinned Cursor CLI titles an MCP call', () => {
    expect(
      CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences.cursorToolName,
    ).toBe(`${ns}: GetGitPreferences`);
    expect(CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.cursorToolName).toBe(
      `${ns}_ui: AskUserQuestion`,
    );
    expect(
      // Advertisement follows registry order, independently of allowlist order.
      [...getCanopyInjectedToolNamesForSurface('cursor-acp', 'cursor')].sort(),
    ).toEqual(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp']
        .map(
          (key) => `${ns}: ${CANOPY_INJECTED_TOOL_REGISTRY[key].displayName}`,
        )
        .sort(),
    );
  });

  it('folds Cursor MCP titles into the canonical key and display name', () => {
    expect(getCanonicalCanopyToolKey(`${ns}: GetGitPreferences`)).toBe(
      'get_git_preferences',
    );
    expect(getCanonicalCanopyToolKey(`${ns}_ui: AskUserQuestion`)).toBe(
      'ask_user_question',
    );
    expect(normalizeCanopyInjectedToolName(`${ns}: SaveMemory`)).toBe(
      'SaveMemory',
    );
    expect(getCanopyInjectedAliases('search_memory')).toContain(
      `${ns}: SearchMemory`,
    );
    expect(getCanonicalCanopyToolKey('linear: SaveMemory')).toBeNull();
    expect(getCanonicalCanopyToolKey(`${ns}: NotATool`)).toBeNull();
  });
});

describe('Agent Ledger tools on the terminal and Cursor surfaces', () => {
  const ns = BRAND.tools.namespace;
  const ledgerKeys = [
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ] as const;

  it('are allowlisted on the managed Claude Code terminal and the Cursor chat', () => {
    for (const surface of ['claude-code-terminal', 'cursor-acp'] as const) {
      expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).toEqual(
        expect.arrayContaining([...ledgerKeys]),
      );
    }
  });

  it('are allowlisted on the shared claude-worker transport for pipeline agents', () => {
    // Phase 08: the worker route carries pipeline agents and background
    // helpers. Only a pipeline agent's route carries Ledger tools, so the
    // route itself decides (`isClaudeWorkerToolExposed`); a helper's route
    // never lists them (T17).
    expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-worker']).toEqual([
      'save_memory',
      'search_memory',
      'read_memory',
      ...ledgerKeys,
    ]);
  });

  it('carry Cursor MCP titles that fold into the canonical key and display name', () => {
    for (const key of ledgerKeys) {
      const { displayName, cursorToolName } =
        CANOPY_INJECTED_TOOL_REGISTRY[key];
      expect(cursorToolName).toBe(`${ns}: ${displayName}`);
      expect(getCanonicalCanopyToolKey(cursorToolName)).toBe(key);
      expect(normalizeCanopyInjectedToolName(cursorToolName)).toBe(displayName);
      expect(getCanopyInjectedAliases(key)).toContain(cursorToolName);
    }
  });
});

describe('cursor-acp-standalone surface', () => {
  it('is the Cowork surface without forks, deferred-tool loaders or Ledger tools', () => {
    const cowork =
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone'];
    // Compare membership independently of allowlist order.
    expect([...cowork].sort()).toEqual(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone']
        .filter(
          (key) =>
            key !== 'search_deferred_tools' &&
            key !== 'load_deferred_tools' &&
            key !== 'start_forked_agent' &&
            !isLedgerInjectedToolKey(key),
        )
        .sort(),
    );
    expect(cowork).toHaveLength(21);
  });

  it('is a strict subset of the worktree Cursor surface', () => {
    const worktree = new Set<string>(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp'],
    );
    const cowork =
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone'];
    for (const key of cowork) expect(worktree.has(key)).toBe(true);
    for (const key of ['set_base_branch', 'get_git_preferences'] as const)
      expect(cowork).not.toContain(key);
  });
});

describe('Copilot deferred capability surfaces', () => {
  it('exposes deferred capabilities alongside host-managed worktree forks', () => {
    const tools = CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['copilot-sdk'];
    expect(tools).toEqual(
      expect.arrayContaining(['search_deferred_tools', 'load_deferred_tools']),
    );
    expect(tools).toContain('start_forked_agent');
    expect(tools).toContain('start_branched_agent');
  });
  it('provides a Cowork route with deferred loading and the existing directory-scoped ceiling', () => {
    const surfaces = Object.fromEntries(
      Object.entries(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS),
    );
    const tools = surfaces['copilot-sdk-standalone'];
    expect(tools).toEqual([
      'start_forked_agent',
      ...CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[
        'cursor-acp-standalone'
      ].filter((key) => key !== 'show_visual' && key !== 'preview_visual'),
      'search_deferred_tools',
      'load_deferred_tools',
    ]);
    expect(tools).not.toContain('set_base_branch');
    expect(tools).not.toContain('get_code_graph_context');
    expect(tools).not.toContain('show_visual');
    expect(tools).not.toContain('preview_visual');
  });
});

it('exposes Copilot host forks without granting branching to directory chats or managed children', () => {
  expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['copilot-sdk']).toEqual(
    expect.arrayContaining(['start_forked_agent', 'start_branched_agent']),
  );
  expect(
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['copilot-sdk-standalone'],
  ).toContain('start_forked_agent');
  expect(
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['copilot-sdk-standalone'],
  ).not.toContain('start_branched_agent');
  expect(
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate'],
  ).not.toContain('start_forked_agent');
  expect(
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate'],
  ).not.toContain('start_branched_agent');
});

test('OpenCode exposes native forks only on their supported scopes', () => {
  // The OpenCode adapter does not provide the Cursor visual host.
  const sharedCursorKeys = CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[
    'cursor-acp'
  ].filter((key) => key !== 'show_visual' && key !== 'preview_visual');
  const keys = CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['opencode-acp'];
  expect(keys).toEqual(expect.arrayContaining(sharedCursorKeys));
  expect(keys).toEqual(expect.arrayContaining(CODE_GRAPH_INJECTED_TOOL_KEYS));
  expect(keys).toEqual(
    expect.arrayContaining(['search_deferred_tools', 'load_deferred_tools']),
  );
  for (const key of ['start_forked_agent', 'start_branched_agent'])
    expect(keys).toContain(key);
  for (const key of ['show_visual', 'preview_visual'])
    expect(keys).not.toContain(key);
  const cowork =
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['opencode-acp-standalone'];
  expect(new Set(cowork)).toEqual(
    new Set([
      ...CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[
        'cursor-acp-standalone'
      ].filter((key) => key !== 'show_visual' && key !== 'preview_visual'),
      'start_forked_agent',
      'search_deferred_tools',
      'load_deferred_tools',
    ]),
  );
});
