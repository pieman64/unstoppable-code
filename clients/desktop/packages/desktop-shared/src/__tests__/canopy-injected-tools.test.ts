import {
  CANOPY_INJECTED_TOOL_ENTRIES,
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  getCanonicalCanopyToolKey,
  getCanopyInjectedAliases,
  getCanopyInjectedToolNamesForSurface,
  getCanopyInjectedToolsForSurface,
  getProviderToolName,
  isCanopyAskUserToolName,
  isCanopyGetScriptOutputToolName,
  normalizeCanopyInjectedToolName,
} from '../lib/canopy-injected-tools';
import type * as CanopyInjectedToolsModule from '../lib/canopy-injected-tools';
import {
  AGENT_ACTION_TOOL_DISPLAY_NAMES,
  AGENT_ACTION_TOOL_KEYS,
  agentActionCodexToolName,
  CLOUD_AGENT_ACTION_TOOL_KEYS,
} from '@canopy/agent-actions';
import { BRAND } from '@canopy/brand/current';

const testBrand = {
  schemaVersion: 5,
  id: 'testbrand',
  displayName: 'TestBrand',
  shortName: 'TestBrand',
  internalName: 'testbrand',
  cliName: 'testbrand',
  appId: 'com.testbrand.ui',
  description: 'TestBrand',
  author: 'TestBrand',
  serverDisplayName: 'TestBrand Server',
  storage: {
    dataDirNames: {
      prod: ['.testbrand', '.canopy'],
      rc: ['.testbrand-rc', '.canopy-rc'],
      dev: ['.testbrand-dev', '.canopy-dev'],
    },
    secureDataDirNames: {
      prod: '.testbrand-secure',
      rc: '.testbrand-rc-secure',
      internal: '.testbrand-internal-secure',
      dev: '.testbrand-secure-dev',
    },
    configFileNames: ['testbrand.json', 'canopy.json'],
    projectConfigDirNames: ['.testbrand', '.canopy'],
  },
  environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
  tools: { namespace: 'testbrand' },
  desktopIntegration: {
    routePrefix: '/testbrand',
    tokenHeaderName: 'X-TestBrand-Integration-Token',
    tokenEnvVar: 'TESTBRAND_DESKTOP_INTEGRATION_TOKEN',
  },
  dictation: {
    binaryName: 'testbrand-dictate',
    bundleId: 'com.testbrand.dictate',
    displayName: 'TestBrand Dictate',
  },
  web: {
    hostnames: ['testbrand.localhost'],
    apiNamespace: 'testbrand',
    wellKnownNamespace: 'testbrand',
    title: 'TestBrand',
    description: 'TestBrand',
  },
  release: { enabled: [], artifactPrefix: 'testbrand' },
  assets: {
    logoSvg: '<svg />',
    logoSvgPath: '/tmp/logo.svg',
    appIconPng: '/tmp/app-icon.png',
    macIconIcns: '/tmp/icon.icns',
    windowsIconIco: '/tmp/icon.ico',
    linuxIconDir: '/tmp/icons',
    webIconPng: '/tmp/web-icon.png',
  },
};

afterEach(() => {
  jest.dontMock('@canopy/brand/current');
  jest.resetModules();
});

describe('canopy-injected-tools registry', () => {
  it('exposes the canonical capability keys', () => {
    expect(Object.keys(CANOPY_INJECTED_TOOL_REGISTRY).sort()).toEqual([
      'add_ledger_entry',
      'ask_user_question',
      'build_or_update_code_graph',
      'compare_change_impact',
      'delegate_task',
      'delete_watchers',
      'detect_changed_symbols',
      'dispatch_action',
      'explain_code_symbol',
      'get_code_graph_context',
      'get_delegate_output',
      'get_file_comments',
      'get_git_preferences',
      'get_github_pull_request_status',
      'get_impact_radius',
      'get_review_context',
      'get_script_output',
      'inspect_delegate',
      'list_delegates',
      'load_deferred_tools',
      'manage_delegate_worktree',
      'message_delegate',
      'preview_visual',
      'query_code_graph',
      'read_memory',
      'read_pipeline_yaml',
      'request_steering',
      'respond_to_file_comment',
      'save_memory',
      'schedule_wakeup',
      'search_actions',
      'search_code_graph',
      'search_deferred_tools',
      'search_ledger_entries',
      'search_memory',
      'search_watchers',
      'set_auto_archive',
      'set_base_branch',
      'setup_watchers',
      'show_capabilities',
      'show_files',
      'show_visual',
      'start_branched_agent',
      'start_forked_agent',
      'stop_delegate',
      'update_ledger_entry',
      'watch_command',
      'watch_github_items',
    ]);
    expect(CANOPY_INJECTED_TOOL_ENTRIES).toHaveLength(48);
  });

  it('exposes ShowVisual on only the four native chat proxy surfaces', () => {
    const allowed = new Set([
      'native-sdk',
      'native-sdk-standalone',
      'cursor-acp',
      'cursor-acp-standalone',
    ]);
    for (const [surface, keys] of Object.entries(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
    )) {
      expect(keys.includes('show_visual')).toBe(allowed.has(surface));
    }
    expect(CANOPY_INJECTED_TOOL_REGISTRY.show_visual.claudeToolName).toBe(
      'mcp__canopy__ShowVisual',
    );
    expect(CANOPY_INJECTED_TOOL_REGISTRY.show_visual.codexToolName).toBe(
      'canopy_show_visual',
    );
    expect(CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.codexToolName).toBe(
      'canopy_preview_visual',
    );
    expect(CANOPY_INJECTED_TOOL_REGISTRY.show_visual.legacyToolNames).toEqual(
      [],
    );
    expect(getCanonicalCanopyToolKey('canopy_show_visual')).toBe('show_visual');
    expect(getCanonicalCanopyToolKey('other_show_visual')).toBe('show_visual');
  });

  it('offers PreviewVisual on exactly the ShowVisual surfaces', () => {
    const surfaces = Object.entries(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS);
    expect(
      surfaces
        .filter(([, keys]) => keys.includes('preview_visual'))
        .map(([name]) => name),
    ).toEqual(
      surfaces
        .filter(([, keys]) => keys.includes('show_visual'))
        .map(([name]) => name),
    );
  });

  it('keeps delegation out of every default tool surface', () => {
    for (const surface of Object.values(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
    )) {
      for (const key of [
        'delegate_task',
        'inspect_delegate',
        'list_delegates',
        'stop_delegate',
        'watch_delegates',
        'get_delegate_output',
        'manage_delegate_worktree',
        'message_delegate',
        'request_steering',
      ])
        expect(surface).not.toContain(key);
    }
  });

  it('names the agent action tools exactly as the registry does', () => {
    const brand = {
      displayName: BRAND.displayName,
      toolNamespace: BRAND.tools.namespace,
    };
    for (const key of AGENT_ACTION_TOOL_KEYS) {
      expect(CANOPY_INJECTED_TOOL_REGISTRY[key].displayName).toBe(
        AGENT_ACTION_TOOL_DISPLAY_NAMES[key],
      );
      expect(CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName).toBe(
        agentActionCodexToolName(brand, key),
      );
    }
    for (const key of CLOUD_AGENT_ACTION_TOOL_KEYS) {
      expect(Object.keys(CANOPY_INJECTED_TOOL_REGISTRY)).toContain(key);
      expect(CANOPY_INJECTED_TOOL_REGISTRY[key].displayName).toBe(
        AGENT_ACTION_TOOL_DISPLAY_NAMES[key],
      );
    }
  });

  it('stores the exact provider-accurate raw names for ask-user', () => {
    const askUser = CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question;
    expect(askUser.canonicalKey).toBe('ask_user_question');
    expect(askUser.displayName).toBe('AskUserQuestion');
    expect(askUser.claudeToolName).toBe('mcp__canopy_ui__AskUserQuestion');
    expect(askUser.codexToolName).toBe('canopy_ask_user_question');
    // Legacy names include the historical mcp__canopy__ name and display name.
    expect(askUser.legacyToolNames).toContain('mcp__canopy__AskUserQuestion');
    expect(askUser.legacyToolNames).toContain('AskUserQuestion');
  });

  it('stores the exact provider-accurate raw names for script-output', () => {
    const scriptOut = CANOPY_INJECTED_TOOL_REGISTRY.get_script_output;
    expect(scriptOut.canonicalKey).toBe('get_script_output');
    expect(scriptOut.displayName).toBe('GetScriptOutput');
    expect(scriptOut.claudeToolName).toBe('mcp__canopy__GetScriptOutput');
    expect(scriptOut.codexToolName).toBe('canopy_get_script_output');
    expect(scriptOut.legacyToolNames).toEqual(['GetScriptOutput']);
  });

  it('stores brand-neutral memory display names with bare legacy aliases only', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.save_memory).toEqual({
      canonicalKey: 'save_memory',
      displayName: 'SaveMemory',
      claudeToolName: 'mcp__canopy__SaveMemory',
      codexToolName: 'canopy_save_memory',
      cursorToolName: 'canopy: SaveMemory',
      legacyToolNames: ['SaveMemory'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.search_memory).toEqual({
      canonicalKey: 'search_memory',
      displayName: 'SearchMemory',
      claudeToolName: 'mcp__canopy__SearchMemory',
      codexToolName: 'canopy_search_memory',
      cursorToolName: 'canopy: SearchMemory',
      legacyToolNames: ['SearchMemory'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.read_memory).toEqual({
      canonicalKey: 'read_memory',
      displayName: 'ReadMemory',
      claudeToolName: 'mcp__canopy__ReadMemory',
      codexToolName: 'canopy_read_memory',
      cursorToolName: 'canopy: ReadMemory',
      legacyToolNames: ['ReadMemory'],
    });
  });

  it('stores the exact provider-accurate raw names for action search/dispatch', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences).toEqual({
      canonicalKey: 'get_git_preferences',
      displayName: 'GetGitPreferences',
      claudeToolName: 'mcp__canopy__GetGitPreferences',
      codexToolName: 'canopy_get_git_preferences',
      cursorToolName: 'canopy: GetGitPreferences',
      legacyToolNames: ['GetGitPreferences'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.read_pipeline_yaml).toEqual({
      canonicalKey: 'read_pipeline_yaml',
      displayName: 'ReadPipelineYaml',
      claudeToolName: 'mcp__canopy__ReadPipelineYaml',
      codexToolName: 'canopy_read_pipeline_yaml',
      cursorToolName: 'canopy: ReadPipelineYaml',
      legacyToolNames: ['ReadPipelineYaml'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.search_actions).toEqual({
      canonicalKey: 'search_actions',
      displayName: 'SearchActions',
      claudeToolName: 'mcp__canopy__SearchActions',
      codexToolName: 'canopy_search_actions',
      cursorToolName: 'canopy: SearchActions',
      legacyToolNames: ['SearchActions'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action).toEqual({
      canonicalKey: 'dispatch_action',
      displayName: 'DispatchAction',
      claudeToolName: 'mcp__canopy__DispatchAction',
      codexToolName: 'canopy_dispatch_action',
      cursorToolName: 'canopy: DispatchAction',
      legacyToolNames: ['DispatchAction'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.search_watchers).toEqual({
      canonicalKey: 'search_watchers',
      displayName: 'SearchWatchers',
      claudeToolName: 'mcp__canopy__SearchWatchers',
      codexToolName: 'canopy_search_watchers',
      cursorToolName: 'canopy: SearchWatchers',
      legacyToolNames: ['SearchWatchers'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.setup_watchers).toEqual({
      canonicalKey: 'setup_watchers',
      displayName: 'SetupWatchers',
      claudeToolName: 'mcp__canopy__SetupWatchers',
      codexToolName: 'canopy_setup_watchers',
      cursorToolName: 'canopy: SetupWatchers',
      legacyToolNames: ['SetupWatchers'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.watch_github_items).toEqual({
      canonicalKey: 'watch_github_items',
      displayName: 'WatchGitHubItems',
      claudeToolName: 'mcp__canopy__WatchGitHubItems',
      codexToolName: 'canopy_watch_github_items',
      cursorToolName: 'canopy: WatchGitHubItems',
      legacyToolNames: ['WatchGitHubItems'],
    });
    expect(
      CANOPY_INJECTED_TOOL_REGISTRY.get_github_pull_request_status,
    ).toEqual({
      canonicalKey: 'get_github_pull_request_status',
      displayName: 'GetGitHubPullRequestStatus',
      claudeToolName: 'mcp__canopy__GetGitHubPullRequestStatus',
      codexToolName: 'canopy_get_github_pull_request_status',
      cursorToolName: 'canopy: GetGitHubPullRequestStatus',
      legacyToolNames: ['GetGitHubPullRequestStatus'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.delete_watchers).toEqual({
      canonicalKey: 'delete_watchers',
      displayName: 'DeleteWatchers',
      claudeToolName: 'mcp__canopy__DeleteWatchers',
      codexToolName: 'canopy_delete_watchers',
      cursorToolName: 'canopy: DeleteWatchers',
      legacyToolNames: ['DeleteWatchers'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.set_auto_archive).toEqual({
      canonicalKey: 'set_auto_archive',
      displayName: 'SetAutoArchive',
      claudeToolName: 'mcp__canopy__SetAutoArchive',
      codexToolName: 'canopy_set_auto_archive',
      cursorToolName: 'canopy: SetAutoArchive',
      legacyToolNames: [
        'SetAutoArchive',
        'mcp__canopy__ArchiveChat',
        'canopy_archive_chat',
        'ArchiveChat',
      ],
    });
  });

  it('stores the exact provider-accurate raw names for the six code-graph tools (no legacy names)', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.get_code_graph_context).toEqual({
      canonicalKey: 'get_code_graph_context',
      displayName: 'GetCodeGraphContext',
      claudeToolName: 'mcp__canopy__GetCodeGraphContext',
      codexToolName: 'canopy_get_code_graph_context',
      cursorToolName: 'canopy: GetCodeGraphContext',
      legacyToolNames: ['GetCodeGraphContext'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.build_or_update_code_graph).toEqual({
      canonicalKey: 'build_or_update_code_graph',
      displayName: 'BuildOrUpdateCodeGraph',
      claudeToolName: 'mcp__canopy__BuildOrUpdateCodeGraph',
      codexToolName: 'canopy_build_or_update_code_graph',
      cursorToolName: 'canopy: BuildOrUpdateCodeGraph',
      legacyToolNames: ['BuildOrUpdateCodeGraph'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.query_code_graph).toEqual({
      canonicalKey: 'query_code_graph',
      displayName: 'QueryCodeGraph',
      claudeToolName: 'mcp__canopy__QueryCodeGraph',
      codexToolName: 'canopy_query_code_graph',
      cursorToolName: 'canopy: QueryCodeGraph',
      legacyToolNames: ['QueryCodeGraph'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.search_code_graph).toEqual({
      canonicalKey: 'search_code_graph',
      displayName: 'SearchCodeGraph',
      claudeToolName: 'mcp__canopy__SearchCodeGraph',
      codexToolName: 'canopy_search_code_graph',
      cursorToolName: 'canopy: SearchCodeGraph',
      legacyToolNames: ['SearchCodeGraph'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.explain_code_symbol).toEqual({
      canonicalKey: 'explain_code_symbol',
      displayName: 'ExplainCodeSymbol',
      claudeToolName: 'mcp__canopy__ExplainCodeSymbol',
      codexToolName: 'canopy_explain_code_symbol',
      cursorToolName: 'canopy: ExplainCodeSymbol',
      legacyToolNames: ['ExplainCodeSymbol'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.get_impact_radius).toEqual({
      canonicalKey: 'get_impact_radius',
      displayName: 'GetImpactRadius',
      claudeToolName: 'mcp__canopy__GetImpactRadius',
      codexToolName: 'canopy_get_impact_radius',
      cursorToolName: 'canopy: GetImpactRadius',
      legacyToolNames: ['GetImpactRadius'],
    });
  });

  it('stores the exact provider-accurate raw names for the three change-impact tools (no legacy names)', () => {
    expect(CANOPY_INJECTED_TOOL_REGISTRY.detect_changed_symbols).toEqual({
      canonicalKey: 'detect_changed_symbols',
      displayName: 'DetectChangedSymbols',
      claudeToolName: 'mcp__canopy__DetectChangedSymbols',
      codexToolName: 'canopy_detect_changed_symbols',
      cursorToolName: 'canopy: DetectChangedSymbols',
      legacyToolNames: ['DetectChangedSymbols'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.compare_change_impact).toEqual({
      canonicalKey: 'compare_change_impact',
      displayName: 'CompareChangeImpact',
      claudeToolName: 'mcp__canopy__CompareChangeImpact',
      codexToolName: 'canopy_compare_change_impact',
      cursorToolName: 'canopy: CompareChangeImpact',
      legacyToolNames: ['CompareChangeImpact'],
    });
    expect(CANOPY_INJECTED_TOOL_REGISTRY.get_review_context).toEqual({
      canonicalKey: 'get_review_context',
      displayName: 'GetReviewContext',
      claudeToolName: 'mcp__canopy__GetReviewContext',
      codexToolName: 'canopy_get_review_context',
      cursorToolName: 'canopy: GetReviewContext',
      legacyToolNames: ['GetReviewContext'],
    });
  });

  describe('getProviderToolName', () => {
    it('returns Claude MCP names for claude provider', () => {
      expect(getProviderToolName('ask_user_question', 'claude')).toBe(
        'mcp__canopy_ui__AskUserQuestion',
      );
      expect(getProviderToolName('get_script_output', 'claude')).toBe(
        'mcp__canopy__GetScriptOutput',
      );
      expect(getProviderToolName('get_git_preferences', 'claude')).toBe(
        'mcp__canopy__GetGitPreferences',
      );
      expect(getProviderToolName('read_pipeline_yaml', 'claude')).toBe(
        'mcp__canopy__ReadPipelineYaml',
      );
      expect(getProviderToolName('search_actions', 'claude')).toBe(
        'mcp__canopy__SearchActions',
      );
      expect(getProviderToolName('dispatch_action', 'claude')).toBe(
        'mcp__canopy__DispatchAction',
      );
      expect(getProviderToolName('search_watchers', 'claude')).toBe(
        'mcp__canopy__SearchWatchers',
      );
      expect(getProviderToolName('setup_watchers', 'claude')).toBe(
        'mcp__canopy__SetupWatchers',
      );
      expect(getProviderToolName('set_auto_archive', 'claude')).toBe(
        'mcp__canopy__SetAutoArchive',
      );
    });

    it('returns Codex dynamic tool names for codex provider', () => {
      expect(getProviderToolName('ask_user_question', 'codex')).toBe(
        'canopy_ask_user_question',
      );
      expect(getProviderToolName('get_script_output', 'codex')).toBe(
        'canopy_get_script_output',
      );
      expect(getProviderToolName('get_git_preferences', 'codex')).toBe(
        'canopy_get_git_preferences',
      );
      expect(getProviderToolName('read_pipeline_yaml', 'codex')).toBe(
        'canopy_read_pipeline_yaml',
      );
      expect(getProviderToolName('search_actions', 'codex')).toBe(
        'canopy_search_actions',
      );
      expect(getProviderToolName('dispatch_action', 'codex')).toBe(
        'canopy_dispatch_action',
      );
      expect(getProviderToolName('search_watchers', 'codex')).toBe(
        'canopy_search_watchers',
      );
      expect(getProviderToolName('setup_watchers', 'codex')).toBe(
        'canopy_setup_watchers',
      );
      expect(getProviderToolName('set_auto_archive', 'codex')).toBe(
        'canopy_set_auto_archive',
      );
    });
  });

  describe('getCanonicalCanopyToolKey', () => {
    const askUserAliases = [
      'mcp__canopy__AskUserQuestion',
      'mcp__canopy_app_advisor__AskUserQuestion',
      'canopy_ask_user_question',
      'AskUserQuestion',
    ];
    const scriptOutputAliases = [
      'mcp__canopy__GetScriptOutput',
      'canopy_get_script_output',
      'GetScriptOutput',
    ];
    const gitPreferenceAliases = [
      'mcp__canopy__GetGitPreferences',
      'canopy_get_git_preferences',
      'GetGitPreferences',
    ];
    const searchWatcherAliases = [
      'mcp__canopy__SearchWatchers',
      'canopy_search_watchers',
      'SearchWatchers',
    ];
    const readPipelineYamlAliases = [
      'mcp__canopy__ReadPipelineYaml',
      'canopy_read_pipeline_yaml',
      'ReadPipelineYaml',
    ];
    const readMemoryAliases = [
      'mcp__canopy__ReadMemory',
      'canopy_read_memory',
      'ReadMemory',
    ];
    const setupWatcherAliases = [
      'mcp__canopy__SetupWatchers',
      'canopy_setup_watchers',
      'SetupWatchers',
    ];
    const setAutoArchiveAliases = [
      'mcp__canopy__SetAutoArchive',
      'canopy_set_auto_archive',
      'SetAutoArchive',
      'mcp__canopy__ArchiveChat',
      'canopy_archive_chat',
      'ArchiveChat',
    ];
    const getCodeGraphContextAliases = [
      'mcp__canopy__GetCodeGraphContext',
      'canopy_get_code_graph_context',
      'GetCodeGraphContext',
    ];
    const buildOrUpdateCodeGraphAliases = [
      'mcp__canopy__BuildOrUpdateCodeGraph',
      'canopy_build_or_update_code_graph',
      'BuildOrUpdateCodeGraph',
    ];
    const queryCodeGraphAliases = [
      'mcp__canopy__QueryCodeGraph',
      'canopy_query_code_graph',
      'QueryCodeGraph',
    ];
    const searchCodeGraphAliases = [
      'mcp__canopy__SearchCodeGraph',
      'canopy_search_code_graph',
      'SearchCodeGraph',
    ];
    const explainCodeSymbolAliases = [
      'mcp__canopy__ExplainCodeSymbol',
      'canopy_explain_code_symbol',
      'ExplainCodeSymbol',
    ];
    const getImpactRadiusAliases = [
      'mcp__canopy__GetImpactRadius',
      'canopy_get_impact_radius',
      'GetImpactRadius',
    ];
    const detectChangedSymbolsAliases = [
      'mcp__canopy__DetectChangedSymbols',
      'canopy_detect_changed_symbols',
      'DetectChangedSymbols',
    ];
    const compareChangeImpactAliases = [
      'mcp__canopy__CompareChangeImpact',
      'canopy_compare_change_impact',
      'CompareChangeImpact',
    ];
    const getReviewContextAliases = [
      'mcp__canopy__GetReviewContext',
      'canopy_get_review_context',
      'GetReviewContext',
    ];

    it.each(askUserAliases)('resolves %s to ask_user_question', (alias) => {
      expect(getCanonicalCanopyToolKey(alias)).toBe('ask_user_question');
    });

    it.each(scriptOutputAliases)(
      'resolves %s to get_script_output',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('get_script_output');
      },
    );
    it.each(gitPreferenceAliases)(
      'resolves %s to get_git_preferences',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('get_git_preferences');
      },
    );
    it.each(searchWatcherAliases)('resolves %s to search_watchers', (alias) => {
      expect(getCanonicalCanopyToolKey(alias)).toBe('search_watchers');
    });
    it.each(readPipelineYamlAliases)(
      'resolves %s to read_pipeline_yaml',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('read_pipeline_yaml');
      },
    );
    it.each(readMemoryAliases)('resolves %s to read_memory', (alias) => {
      expect(getCanonicalCanopyToolKey(alias)).toBe('read_memory');
    });
    it.each(setupWatcherAliases)('resolves %s to setup_watchers', (alias) => {
      expect(getCanonicalCanopyToolKey(alias)).toBe('setup_watchers');
    });
    it.each(setAutoArchiveAliases)(
      'resolves %s to set_auto_archive',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('set_auto_archive');
      },
    );
    it.each(getCodeGraphContextAliases)(
      'resolves %s to get_code_graph_context',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('get_code_graph_context');
      },
    );
    it.each(buildOrUpdateCodeGraphAliases)(
      'resolves %s to build_or_update_code_graph',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe(
          'build_or_update_code_graph',
        );
      },
    );
    it.each(queryCodeGraphAliases)(
      'resolves %s to query_code_graph',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('query_code_graph');
      },
    );
    it.each(searchCodeGraphAliases)(
      'resolves %s to search_code_graph',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('search_code_graph');
      },
    );
    it.each(explainCodeSymbolAliases)(
      'resolves %s to explain_code_symbol',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('explain_code_symbol');
      },
    );
    it.each(getImpactRadiusAliases)(
      'resolves %s to get_impact_radius',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('get_impact_radius');
      },
    );
    it.each(detectChangedSymbolsAliases)(
      'resolves %s to detect_changed_symbols',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('detect_changed_symbols');
      },
    );
    it.each(compareChangeImpactAliases)(
      'resolves %s to compare_change_impact',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('compare_change_impact');
      },
    );
    it.each(getReviewContextAliases)(
      'resolves %s to get_review_context',
      (alias) => {
        expect(getCanonicalCanopyToolKey(alias)).toBe('get_review_context');
      },
    );

    it('returns null for non-Canopy tool names', () => {
      expect(getCanonicalCanopyToolKey('Bash')).toBeNull();
      expect(getCanonicalCanopyToolKey('request_user_input')).toBeNull();
      expect(getCanonicalCanopyToolKey('mcp__other__Tool')).toBeNull();
      expect(getCanonicalCanopyToolKey('')).toBeNull();
      expect(getCanonicalCanopyToolKey(null)).toBeNull();
      expect(getCanonicalCanopyToolKey(undefined)).toBeNull();
    });
  });

  describe('normalizeCanopyInjectedToolName', () => {
    it('collapses every ask-user alias to AskUserQuestion', () => {
      for (const alias of [
        'mcp__canopy__AskUserQuestion',
        'mcp__canopy_app_advisor__AskUserQuestion',
        'canopy_ask_user_question',
        'AskUserQuestion',
      ]) {
        expect(normalizeCanopyInjectedToolName(alias)).toBe('AskUserQuestion');
      }
    });

    it('collapses every script-output alias to GetScriptOutput', () => {
      for (const alias of [
        'mcp__canopy__GetScriptOutput',
        'canopy_get_script_output',
        'GetScriptOutput',
      ]) {
        expect(normalizeCanopyInjectedToolName(alias)).toBe('GetScriptOutput');
      }
    });

    it('returns the input unchanged for unrecognised tool names', () => {
      expect(normalizeCanopyInjectedToolName('Bash')).toBe('Bash');
      expect(normalizeCanopyInjectedToolName('request_user_input')).toBe(
        'request_user_input',
      );
    });
  });

  describe('isCanopyAskUserToolName / isCanopyGetScriptOutputToolName', () => {
    it('identifies ask-user aliases only', () => {
      expect(isCanopyAskUserToolName('mcp__canopy__AskUserQuestion')).toBe(
        true,
      );
      expect(isCanopyAskUserToolName('canopy_ask_user_question')).toBe(true);
      expect(isCanopyAskUserToolName('AskUserQuestion')).toBe(true);
      expect(isCanopyAskUserToolName('request_user_input')).toBe(false);
      expect(isCanopyAskUserToolName('mcp__canopy__GetScriptOutput')).toBe(
        false,
      );
      expect(isCanopyAskUserToolName(null)).toBe(false);
    });

    it('identifies script-output aliases only', () => {
      expect(
        isCanopyGetScriptOutputToolName('mcp__canopy__GetScriptOutput'),
      ).toBe(true);
      expect(isCanopyGetScriptOutputToolName('canopy_get_script_output')).toBe(
        true,
      );
      expect(isCanopyGetScriptOutputToolName('GetScriptOutput')).toBe(true);
      expect(
        isCanopyGetScriptOutputToolName('mcp__canopy__AskUserQuestion'),
      ).toBe(false);
      expect(isCanopyGetScriptOutputToolName(undefined)).toBe(false);
    });
  });

  describe('surface allowlists', () => {
    it('exposes the non-ask-user tools plus the code-graph and change-impact tools to native-sdk (ask-user moved to native-sdk-ui)', () => {
      expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk']).toEqual([
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
        'start_forked_agent',
        'start_branched_agent',
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
        'search_deferred_tools',
        'load_deferred_tools',
        'add_ledger_entry',
        'search_ledger_entries',
        'update_ledger_entry',
      ]);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk'],
      ).not.toContain('ask_user_question');
      expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui']).toEqual([
        'ask_user_question',
      ]);
    });

    it('does NOT expose the code-graph or change-impact tools to native-sdk-standalone or native-sdk-ui', () => {
      const codeGraphKeys = [
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
      ];
      for (const key of codeGraphKeys) {
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-standalone'],
        ).not.toContain(key);
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui'],
        ).not.toContain(key);
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-worker'],
        ).not.toContain(key);
      }
    });

    it('exposes terminal-safe worktree tools plus the code-graph, change-impact and Ledger tools to claude-code-terminal', () => {
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
      ).toEqual([
        'watch_command',
        'schedule_wakeup',
        'get_script_output',
        'get_git_preferences',
        'save_memory',
        'search_memory',
        'read_memory',
        'read_pipeline_yaml',
        'show_files',
        'show_capabilities',
        'get_file_comments',
        'respond_to_file_comment',
        'search_actions',
        'dispatch_action',
        'search_watchers',
        'setup_watchers',
        'watch_github_items',
        'get_github_pull_request_status',
        'delete_watchers',
        'set_auto_archive',
        'set_base_branch',
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
        'search_deferred_tools',
        'load_deferred_tools',
        'add_ledger_entry',
        'search_ledger_entries',
        'update_ledger_entry',
      ]);
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
      ).not.toContain('ask_user_question');
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
      ).not.toContain('start_forked_agent');
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-code-terminal'],
      ).not.toContain('start_branched_agent');
    });

    it('exposes managed-delegate tools', (): void => {
      expect(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate'],
      ).toEqual([
        'get_script_output',
        'get_git_preferences',
        'save_memory',
        'search_memory',
        'read_memory',
        'read_pipeline_yaml',
        'get_file_comments',
        'search_actions',
        'dispatch_action',
        'search_watchers',
        'setup_watchers',
        'watch_github_items',
        'get_github_pull_request_status',
        'watch_command',
        'schedule_wakeup',
        'delete_watchers',
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
        'search_deferred_tools',
        'load_deferred_tools',
      ]);
      // Watchers and wakeups notify the delegate that created them. Tools that
      // prompt the user, change the user's UI, or split the chat stay with the
      // parent.
      for (const key of [
        'ask_user_question',
        'show_files',
        'show_capabilities',
        'respond_to_file_comment',
        'set_auto_archive',
        'set_base_branch',
        'start_forked_agent',
        'start_branched_agent',
      ] as const)
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate'],
        ).not.toContain(key);
    });

    it('exposes ReadMemory on every surface that exposes SearchMemory', () => {
      for (const surface of [
        'native-sdk',
        'native-sdk-standalone',
        'native-sdk-ui',
        'claude-code-terminal',
        'claude-worker',
        'managed-delegate',
      ] as const) {
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(
            'read_memory',
          ),
        ).toBe(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(
            'search_memory',
          ),
        );
      }
    });

    it('preserves the canonical entry order on each surface', () => {
      const nativeKeys = getCanopyInjectedToolsForSurface('native-sdk').map(
        (entry) => entry.canonicalKey,
      );
      expect(nativeKeys).toEqual([
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
        'start_forked_agent',
        'start_branched_agent',
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
        'search_deferred_tools',
        'load_deferred_tools',
        'add_ledger_entry',
        'search_ledger_entries',
        'update_ledger_entry',
      ]);

      const terminalKeys = getCanopyInjectedToolsForSurface(
        'claude-code-terminal',
      ).map((entry) => entry.canonicalKey);
      expect(terminalKeys).toEqual([
        'get_script_output',
        'get_git_preferences',
        'save_memory',
        'search_memory',
        'read_memory',
        'read_pipeline_yaml',
        'show_files',
        'show_capabilities',
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
        'get_code_graph_context',
        'build_or_update_code_graph',
        'query_code_graph',
        'search_code_graph',
        'explain_code_symbol',
        'get_impact_radius',
        'detect_changed_symbols',
        'compare_change_impact',
        'get_review_context',
        'search_deferred_tools',
        'load_deferred_tools',
        'add_ledger_entry',
        'search_ledger_entries',
        'update_ledger_entry',
      ]);
    });

    it('emits provider-accurate names per surface', () => {
      expect(
        getCanopyInjectedToolNamesForSurface('claude-code-terminal', 'claude'),
      ).toEqual([
        'mcp__canopy__GetScriptOutput',
        'mcp__canopy__GetGitPreferences',
        'mcp__canopy__SaveMemory',
        'mcp__canopy__SearchMemory',
        'mcp__canopy__ReadMemory',
        'mcp__canopy__ReadPipelineYaml',
        'mcp__canopy__ShowFiles',
        'mcp__canopy__ShowCapabilities',
        'mcp__canopy__GetFileComments',
        'mcp__canopy__RespondToFileComment',
        'mcp__canopy__SearchActions',
        'mcp__canopy__DispatchAction',
        'mcp__canopy__SearchWatchers',
        'mcp__canopy__SetupWatchers',
        'mcp__canopy__WatchGitHubItems',
        'mcp__canopy__GetGitHubPullRequestStatus',
        'mcp__canopy__WatchCommand',
        'mcp__canopy__ScheduleWakeup',
        'mcp__canopy__DeleteWatchers',
        'mcp__canopy__SetAutoArchive',
        'mcp__canopy__SetBaseBranch',
        'mcp__canopy__GetCodeGraphContext',
        'mcp__canopy__BuildOrUpdateCodeGraph',
        'mcp__canopy__QueryCodeGraph',
        'mcp__canopy__SearchCodeGraph',
        'mcp__canopy__ExplainCodeSymbol',
        'mcp__canopy__GetImpactRadius',
        'mcp__canopy__DetectChangedSymbols',
        'mcp__canopy__CompareChangeImpact',
        'mcp__canopy__GetReviewContext',
        'mcp__canopy__SearchDeferredTools',
        'mcp__canopy__LoadDeferredTools',
        'mcp__canopy__AddFeedEntry',
        'mcp__canopy__SearchFeedEntries',
        'mcp__canopy__UpdateFeedEntry',
      ]);
      // native-sdk no longer includes ask_user_question (moved to native-sdk-ui).
      expect(
        getCanopyInjectedToolNamesForSurface('native-sdk', 'codex'),
      ).toEqual([
        'canopy_get_script_output',
        'canopy_get_git_preferences',
        'canopy_save_memory',
        'canopy_search_memory',
        'canopy_read_memory',
        'canopy_read_pipeline_yaml',
        'canopy_show_files',
        'canopy_show_capabilities',
        'canopy_show_visual',
        'canopy_preview_visual',
        'canopy_get_file_comments',
        'canopy_respond_to_file_comment',
        'canopy_search_actions',
        'canopy_dispatch_action',
        'canopy_search_watchers',
        'canopy_setup_watchers',
        'canopy_watch_github_items',
        'canopy_get_github_pull_request_status',
        'canopy_watch_command',
        'canopy_schedule_wakeup',
        'canopy_delete_watchers',
        'canopy_set_auto_archive',
        'canopy_set_base_branch',
        'canopy_start_forked_agent',
        'canopy_start_branched_agent',
        'canopy_get_code_graph_context',
        'canopy_build_or_update_code_graph',
        'canopy_query_code_graph',
        'canopy_search_code_graph',
        'canopy_explain_code_symbol',
        'canopy_get_impact_radius',
        'canopy_detect_changed_symbols',
        'canopy_compare_change_impact',
        'canopy_get_review_context',
        'canopy_search_deferred_tools',
        'canopy_load_deferred_tools',
        'canopy_add_feed_entry',
        'canopy_search_feed_entries',
        'canopy_update_feed_entry',
      ]);
      // native-sdk-ui hosts ask_user_question on the dedicated _ui MCP server.
      expect(
        getCanopyInjectedToolNamesForSurface('native-sdk-ui', 'claude'),
      ).toEqual(['mcp__canopy_ui__AskUserQuestion']);
    });
  });

  describe('deferred-tools (SearchDeferredTools / LoadDeferredTools)', () => {
    it('stores the exact provider-accurate raw names (no legacy names)', () => {
      expect(CANOPY_INJECTED_TOOL_REGISTRY.search_deferred_tools).toEqual({
        canonicalKey: 'search_deferred_tools',
        displayName: 'SearchDeferredTools',
        claudeToolName: 'mcp__canopy__SearchDeferredTools',
        codexToolName: 'canopy_search_deferred_tools',
        cursorToolName: 'canopy: SearchDeferredTools',
        legacyToolNames: ['SearchDeferredTools'],
      });
      expect(CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools).toEqual({
        canonicalKey: 'load_deferred_tools',
        displayName: 'LoadDeferredTools',
        claudeToolName: 'mcp__canopy__LoadDeferredTools',
        codexToolName: 'canopy_load_deferred_tools',
        cursorToolName: 'canopy: LoadDeferredTools',
        legacyToolNames: ['LoadDeferredTools'],
      });
    });

    it('resolves branded, legacy display, and app-advisor / pipeline-editor sibling names to the canonical key', () => {
      for (const alias of [
        'mcp__canopy__SearchDeferredTools',
        'canopy_search_deferred_tools',
        'SearchDeferredTools',
      ]) {
        expect(getCanonicalCanopyToolKey(alias)).toBe('search_deferred_tools');
      }
      for (const alias of [
        'mcp__canopy__LoadDeferredTools',
        'canopy_load_deferred_tools',
        'LoadDeferredTools',
      ]) {
        expect(getCanonicalCanopyToolKey(alias)).toBe('load_deferred_tools');
      }
    });

    it('exposes both keys on native-sdk, native-sdk-standalone, and claude-code-terminal but NOT native-sdk-ui or claude-worker', () => {
      for (const surface of [
        'native-sdk',
        'native-sdk-standalone',
        'claude-code-terminal',
      ] as const) {
        expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).toContain(
          'search_deferred_tools',
        );
        expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).toContain(
          'load_deferred_tools',
        );
      }
      for (const surface of ['native-sdk-ui', 'claude-worker'] as const) {
        expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).not.toContain(
          'search_deferred_tools',
        );
        expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).not.toContain(
          'load_deferred_tools',
        );
      }
    });

    it('has Claude/Codex surface parity for both keys', () => {
      expect(getProviderToolName('search_deferred_tools', 'claude')).toBe(
        'mcp__canopy__SearchDeferredTools',
      );
      expect(getProviderToolName('search_deferred_tools', 'codex')).toBe(
        'canopy_search_deferred_tools',
      );
      expect(getProviderToolName('load_deferred_tools', 'claude')).toBe(
        'mcp__canopy__LoadDeferredTools',
      );
      expect(getProviderToolName('load_deferred_tools', 'codex')).toBe(
        'canopy_load_deferred_tools',
      );
    });
  });

  describe('ledger tools (AddFeedEntry / SearchFeedEntries / UpdateFeedEntry)', () => {
    const ledgerKeys = [
      'add_ledger_entry',
      'search_ledger_entries',
      'update_ledger_entry',
    ] as const;

    it('exposes all three keys on the interactive chat surfaces', () => {
      for (const surface of [
        'native-sdk',
        'native-sdk-standalone',
        'claude-code-terminal',
        'cursor-acp',
      ] as const) {
        for (const key of ledgerKeys) {
          expect(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface]).toContain(
            key,
          );
        }
      }
    });

    it('never exposes them on the UI server', () => {
      for (const key of ledgerKeys) {
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['native-sdk-ui'],
        ).not.toContain(key);
      }
    });

    it('allowlists them on the shared claude-worker transport for pipeline agents', () => {
      // Phase 08: the worker transport carries pipeline agents and background
      // helpers. Only a pipeline agent's route carries a Ledger runtime, so
      // the route decides (`isClaudeWorkerToolExposed`); a helper's route
      // still lists none (T17, covered by the MCP proxy's worker-route tests).
      for (const key of ledgerKeys) {
        expect(
          CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['claude-worker'],
        ).toContain(key);
      }
      expect(
        getCanopyInjectedToolNamesForSurface('claude-worker', 'claude').filter(
          (name) => name.includes('FeedEntr'),
        ),
      ).toEqual([
        'mcp__canopy__AddFeedEntry',
        'mcp__canopy__SearchFeedEntries',
        'mcp__canopy__UpdateFeedEntry',
      ]);
    });

    it('titles each tool the way the pinned Cursor CLI titles an MCP call', () => {
      expect(getProviderToolName('add_ledger_entry', 'cursor')).toBe(
        'canopy: AddFeedEntry',
      );
      expect(getProviderToolName('search_ledger_entries', 'cursor')).toBe(
        'canopy: SearchFeedEntries',
      );
      expect(getProviderToolName('update_ledger_entry', 'cursor')).toBe(
        'canopy: UpdateFeedEntry',
      );
      expect(
        getCanopyInjectedToolNamesForSurface('cursor-acp', 'cursor'),
      ).toEqual(
        expect.arrayContaining([
          'canopy: AddFeedEntry',
          'canopy: SearchFeedEntries',
          'canopy: UpdateFeedEntry',
        ]),
      );
    });

    it('has Claude/Codex surface parity for all three keys', () => {
      expect(getProviderToolName('add_ledger_entry', 'claude')).toBe(
        'mcp__canopy__AddFeedEntry',
      );
      expect(getProviderToolName('add_ledger_entry', 'codex')).toBe(
        'canopy_add_feed_entry',
      );
      expect(getProviderToolName('search_ledger_entries', 'claude')).toBe(
        'mcp__canopy__SearchFeedEntries',
      );
      expect(getProviderToolName('search_ledger_entries', 'codex')).toBe(
        'canopy_search_feed_entries',
      );
      expect(getProviderToolName('update_ledger_entry', 'claude')).toBe(
        'mcp__canopy__UpdateFeedEntry',
      );
      expect(getProviderToolName('update_ledger_entry', 'codex')).toBe(
        'canopy_update_feed_entry',
      );
    });

    it('resolves every raw name back to its canonical key', () => {
      for (const [key, claudeName, codexName, cursorName] of [
        [
          'add_ledger_entry',
          'mcp__canopy__AddFeedEntry',
          'canopy_add_feed_entry',
          'canopy: AddFeedEntry',
        ],
        [
          'search_ledger_entries',
          'mcp__canopy__SearchFeedEntries',
          'canopy_search_feed_entries',
          'canopy: SearchFeedEntries',
        ],
        [
          'update_ledger_entry',
          'mcp__canopy__UpdateFeedEntry',
          'canopy_update_feed_entry',
          'canopy: UpdateFeedEntry',
        ],
      ] as const) {
        expect(getCanonicalCanopyToolKey(claudeName)).toBe(key);
        expect(getCanonicalCanopyToolKey(codexName)).toBe(key);
        expect(getCanonicalCanopyToolKey(cursorName)).toBe(key);
      }
    });

    it('resolves the pre-Feed Ledger names for persisted transcripts only', () => {
      const advertised = new Set([
        ...getCanopyInjectedToolNamesForSurface('native-sdk', 'claude'),
        ...getCanopyInjectedToolNamesForSurface('native-sdk', 'codex'),
        ...getCanopyInjectedToolNamesForSurface('cursor-acp', 'cursor'),
      ]);
      for (const [key, displayName, legacyNames] of [
        [
          'add_ledger_entry',
          'AddFeedEntry',
          [
            'mcp__canopy__AddLedgerEntry',
            'canopy_add_ledger_entry',
            'canopy: AddLedgerEntry',
            'AddLedgerEntry',
          ],
        ],
        [
          'search_ledger_entries',
          'SearchFeedEntries',
          [
            'mcp__canopy__SearchLedgerEntries',
            'canopy_search_ledger_entries',
            'canopy: SearchLedgerEntries',
            'SearchLedgerEntries',
          ],
        ],
        [
          'update_ledger_entry',
          'UpdateFeedEntry',
          [
            'mcp__canopy__UpdateLedgerEntry',
            'canopy_update_ledger_entry',
            'canopy: UpdateLedgerEntry',
            'UpdateLedgerEntry',
          ],
        ],
      ] as const) {
        for (const legacyName of legacyNames) {
          expect(getCanonicalCanopyToolKey(legacyName)).toBe(key);
          expect(normalizeCanopyInjectedToolName(legacyName)).toBe(displayName);
          expect(getCanopyInjectedAliases(key)).toContain(legacyName);
          expect(advertised.has(legacyName)).toBe(false);
        }
      }
    });
  });

  describe('getCanopyInjectedAliases', () => {
    it('returns Claude + Codex + legacy aliases (no provider built-ins)', () => {
      // ask_user_question: live Claude name is now mcp__canopy_ui__AskUserQuestion;
      // the historical mcp__canopy__AskUserQuestion name is preserved as a legacy alias.
      const askUserAliases = getCanopyInjectedAliases('ask_user_question');
      expect(askUserAliases).toContain('mcp__canopy_ui__AskUserQuestion');
      expect(askUserAliases).toContain('canopy_ask_user_question');
      expect(askUserAliases).toContain('AskUserQuestion');
      expect(askUserAliases).toContain('mcp__canopy__AskUserQuestion');
      expect(askUserAliases).toContain(
        'mcp__canopy_app_advisor__AskUserQuestion',
      );
      expect(getCanopyInjectedAliases('get_script_output')).toEqual([
        'mcp__canopy__GetScriptOutput',
        'canopy_get_script_output',
        'canopy: GetScriptOutput',
        'GetScriptOutput',
      ]);
      expect(getCanopyInjectedAliases('read_pipeline_yaml')).toEqual([
        'mcp__canopy__ReadPipelineYaml',
        'canopy_read_pipeline_yaml',
        'canopy: ReadPipelineYaml',
        'ReadPipelineYaml',
      ]);
      expect(getCanopyInjectedAliases('get_git_preferences')).toEqual([
        'mcp__canopy__GetGitPreferences',
        'canopy_get_git_preferences',
        'canopy: GetGitPreferences',
        'GetGitPreferences',
      ]);
      expect(getCanopyInjectedAliases('save_memory')).toEqual([
        'mcp__canopy__SaveMemory',
        'canopy_save_memory',
        'canopy: SaveMemory',
        'SaveMemory',
      ]);
      expect(getCanopyInjectedAliases('search_memory')).toEqual([
        'mcp__canopy__SearchMemory',
        'canopy_search_memory',
        'canopy: SearchMemory',
        'SearchMemory',
      ]);
      expect(getCanopyInjectedAliases('read_memory')).toEqual([
        'mcp__canopy__ReadMemory',
        'canopy_read_memory',
        'canopy: ReadMemory',
        'ReadMemory',
      ]);
      expect(getCanopyInjectedAliases('search_watchers')).toEqual([
        'mcp__canopy__SearchWatchers',
        'canopy_search_watchers',
        'canopy: SearchWatchers',
        'SearchWatchers',
      ]);
    });

    it('does NOT include the Codex built-in request_user_input', () => {
      expect(getCanopyInjectedAliases('ask_user_question')).not.toContain(
        'request_user_input',
      );
    });

    it('returns exactly the claude + codex + display name for the new code-graph tools (no other legacy names)', () => {
      expect(getCanopyInjectedAliases('get_code_graph_context')).toEqual([
        'mcp__canopy__GetCodeGraphContext',
        'canopy_get_code_graph_context',
        'canopy: GetCodeGraphContext',
        'GetCodeGraphContext',
      ]);
      expect(getCanopyInjectedAliases('get_impact_radius')).toEqual([
        'mcp__canopy__GetImpactRadius',
        'canopy_get_impact_radius',
        'canopy: GetImpactRadius',
        'GetImpactRadius',
      ]);
    });

    it('returns exactly the claude + codex + display name for the three change-impact tools (no other legacy names)', () => {
      expect(getCanopyInjectedAliases('detect_changed_symbols')).toEqual([
        'mcp__canopy__DetectChangedSymbols',
        'canopy_detect_changed_symbols',
        'canopy: DetectChangedSymbols',
        'DetectChangedSymbols',
      ]);
      expect(getCanopyInjectedAliases('compare_change_impact')).toEqual([
        'mcp__canopy__CompareChangeImpact',
        'canopy_compare_change_impact',
        'canopy: CompareChangeImpact',
        'CompareChangeImpact',
      ]);
      expect(getCanopyInjectedAliases('get_review_context')).toEqual([
        'mcp__canopy__GetReviewContext',
        'canopy_get_review_context',
        'canopy: GetReviewContext',
        'GetReviewContext',
      ]);
    });
  });

  describe('non-Canopy runtime names', () => {
    it('advertises only branded live tool names while preserving legacy transcript aliases', () => {
      jest.doMock('@canopy/brand/current', () => ({
        BRAND: testBrand,
        default: testBrand,
      }));

      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const branded =
          require('../lib/canopy-injected-tools') as typeof CanopyInjectedToolsModule;
        /* eslint-enable @typescript-eslint/no-require-imports */

        // native-sdk no longer includes ask_user_question (moved to native-sdk-ui).
        expect(
          branded.getCanopyInjectedToolNamesForSurface('native-sdk', 'claude'),
        ).toEqual([
          'mcp__testbrand__GetScriptOutput',
          'mcp__testbrand__GetGitPreferences',
          'mcp__testbrand__SaveMemory',
          'mcp__testbrand__SearchMemory',
          'mcp__testbrand__ReadMemory',
          'mcp__testbrand__ReadPipelineYaml',
          'mcp__testbrand__ShowFiles',
          'mcp__testbrand__ShowCapabilities',
          'mcp__testbrand__ShowVisual',
          'mcp__testbrand__PreviewVisual',
          'mcp__testbrand__GetFileComments',
          'mcp__testbrand__RespondToFileComment',
          'mcp__testbrand__SearchActions',
          'mcp__testbrand__DispatchAction',
          'mcp__testbrand__SearchWatchers',
          'mcp__testbrand__SetupWatchers',
          'mcp__testbrand__WatchGitHubItems',
          'mcp__testbrand__GetGitHubPullRequestStatus',
          'mcp__testbrand__WatchCommand',
          'mcp__testbrand__ScheduleWakeup',
          'mcp__testbrand__DeleteWatchers',
          'mcp__testbrand__SetAutoArchive',
          'mcp__testbrand__SetBaseBranch',
          'mcp__testbrand__StartForkedAgent',
          'mcp__testbrand__StartBranchedAgent',
          'mcp__testbrand__GetCodeGraphContext',
          'mcp__testbrand__BuildOrUpdateCodeGraph',
          'mcp__testbrand__QueryCodeGraph',
          'mcp__testbrand__SearchCodeGraph',
          'mcp__testbrand__ExplainCodeSymbol',
          'mcp__testbrand__GetImpactRadius',
          'mcp__testbrand__DetectChangedSymbols',
          'mcp__testbrand__CompareChangeImpact',
          'mcp__testbrand__GetReviewContext',
          'mcp__testbrand__SearchDeferredTools',
          'mcp__testbrand__LoadDeferredTools',
          'mcp__testbrand__AddFeedEntry',
          'mcp__testbrand__SearchFeedEntries',
          'mcp__testbrand__UpdateFeedEntry',
        ]);
        expect(
          branded.getCanopyInjectedToolNamesForSurface(
            'native-sdk-ui',
            'claude',
          ),
        ).toEqual(['mcp__testbrand_ui__AskUserQuestion']);
        // native-sdk also excludes ask_user_question for Codex (moved to native-sdk-ui).
        expect(
          branded.getCanopyInjectedToolNamesForSurface('native-sdk', 'codex'),
        ).toEqual([
          'testbrand_get_script_output',
          'testbrand_get_git_preferences',
          'testbrand_save_memory',
          'testbrand_search_memory',
          'testbrand_read_memory',
          'testbrand_read_pipeline_yaml',
          'testbrand_show_files',
          'testbrand_show_capabilities',
          'testbrand_show_visual',
          'testbrand_preview_visual',
          'testbrand_get_file_comments',
          'testbrand_respond_to_file_comment',
          'testbrand_search_actions',
          'testbrand_dispatch_action',
          'testbrand_search_watchers',
          'testbrand_setup_watchers',
          'testbrand_watch_github_items',
          'testbrand_get_github_pull_request_status',
          'testbrand_watch_command',
          'testbrand_schedule_wakeup',
          'testbrand_delete_watchers',
          'testbrand_set_auto_archive',
          'testbrand_set_base_branch',
          'testbrand_start_forked_agent',
          'testbrand_start_branched_agent',
          'testbrand_get_code_graph_context',
          'testbrand_build_or_update_code_graph',
          'testbrand_query_code_graph',
          'testbrand_search_code_graph',
          'testbrand_explain_code_symbol',
          'testbrand_get_impact_radius',
          'testbrand_detect_changed_symbols',
          'testbrand_compare_change_impact',
          'testbrand_get_review_context',
          'testbrand_search_deferred_tools',
          'testbrand_load_deferred_tools',
          'testbrand_add_feed_entry',
          'testbrand_search_feed_entries',
          'testbrand_update_feed_entry',
        ]);
        // Live name is now mcp__testbrand_ui__; historical mcp__testbrand__ and
        // mcp__canopy__ names are preserved as legacy aliases.
        const tbAskUserAliases =
          branded.getCanopyInjectedAliases('ask_user_question');
        expect(tbAskUserAliases).toContain(
          'mcp__testbrand_ui__AskUserQuestion',
        );
        expect(tbAskUserAliases).toContain('testbrand_ask_user_question');
        expect(tbAskUserAliases).toContain('AskUserQuestion');
        expect(tbAskUserAliases).toContain('mcp__canopy__AskUserQuestion');
        expect(tbAskUserAliases).toContain(
          'mcp__testbrand_app_advisor__AskUserQuestion',
        );
        expect(tbAskUserAliases).toContain('canopy_ask_user_question');
        expect(
          branded.normalizeCanopyInjectedToolName(
            'mcp__canopy__AskUserQuestion',
          ),
        ).toBe('AskUserQuestion');
        expect(
          branded.normalizeCanopyInjectedToolName(
            'mcp__testbrand__AskUserQuestion',
          ),
        ).toBe('AskUserQuestion');
        expect(
          branded.getCanonicalCanopyToolKey(
            'mcp__testbrand_app_advisor__AskUserQuestion',
          ),
        ).toBe('ask_user_question');
      });
    });
  });
});
