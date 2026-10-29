import {
  buildCanopyHooksClaudeTerminalRoute,
  buildCanopyMcpProxyRoute,
  buildCanopyMcpWorktreeSessionRoute,
  buildLegacyMcpProxyRoute,
  CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
  CANOPY_MCP_PROXY_PATH,
  CANOPY_MCP_WORKTREE_SESSION_PATH,
  CLAUDE_TERMINAL_HOOK_EVENT_NAMES,
  CLAUDE_TERMINAL_MCP_TOOL_KEYS,
  DESKTOP_INTEGRATION_ALT_TOKEN_HEADER,
  DESKTOP_INTEGRATION_BEARER_HEADER,
  DESKTOP_INTEGRATION_BEARER_PREFIX,
  DESKTOP_INTEGRATION_SERVER_HOST,
  DESKTOP_INTEGRATION_TOKEN_ENV_VAR,
  extractDesktopIntegrationToken,
  isClaudeTerminalHookCallbackBody,
  isClaudeTerminalHookEventName,
  LEGACY_MCP_PROXY_PATH,
} from '../desktop-integration-transport';
import { CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS } from '../canopy-injected-tools';
import type * as DesktopIntegrationTransportModule from '../desktop-integration-transport';

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

describe('desktop-integration-transport', () => {
  it('locks down the canopy-namespaced route paths', () => {
    expect(CANOPY_MCP_WORKTREE_SESSION_PATH).toBe(
      '/canopy/mcp/worktree-session',
    );
    expect(CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH).toBe(
      '/canopy/hooks/claude-terminal/worktree-session',
    );
    expect(CANOPY_MCP_PROXY_PATH).toBe('/canopy/mcp/proxy');
    expect(LEGACY_MCP_PROXY_PATH).toBe('/mcp');
  });

  it('binds the integration server to localhost only', () => {
    expect(DESKTOP_INTEGRATION_SERVER_HOST).toBe('127.0.0.1');
  });

  it('builds session-keyed routes with url-encoded path segments', () => {
    expect(buildCanopyMcpWorktreeSessionRoute('abc')).toBe(
      '/canopy/mcp/worktree-session/abc',
    );
    expect(buildCanopyHooksClaudeTerminalRoute('abc')).toBe(
      '/canopy/hooks/claude-terminal/worktree-session/abc',
    );
    expect(buildCanopyMcpProxyRoute('plugin-1')).toBe(
      '/canopy/mcp/proxy/plugin-1',
    );
    expect(buildLegacyMcpProxyRoute('plugin-1')).toBe('/mcp/plugin-1');

    // Session keys that include URL-reserved characters must be safely
    // encoded — otherwise the proxy would mis-route.
    expect(buildCanopyMcpWorktreeSessionRoute('a/b c')).toBe(
      '/canopy/mcp/worktree-session/a%2Fb%20c',
    );
  });

  it('exposes both bearer and alternate auth header names', () => {
    expect(DESKTOP_INTEGRATION_BEARER_HEADER).toBe('Authorization');
    expect(DESKTOP_INTEGRATION_BEARER_PREFIX).toBe('Bearer ');
    expect(DESKTOP_INTEGRATION_ALT_TOKEN_HEADER).toBe(
      'X-Canopy-Integration-Token',
    );
    expect(DESKTOP_INTEGRATION_TOKEN_ENV_VAR).toBe(
      'CANOPY_DESKTOP_INTEGRATION_TOKEN',
    );
  });

  it('derives non-Canopy routes and auth names without legacy /canopy routes', () => {
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: testBrand,
      default: testBrand,
    }));

    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const branded =
        require('../desktop-integration-transport') as typeof DesktopIntegrationTransportModule;
      /* eslint-enable @typescript-eslint/no-require-imports */

      expect(branded.CANOPY_MCP_WORKTREE_SESSION_PATH).toBe(
        '/testbrand/mcp/worktree-session',
      );
      expect(branded.CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH).toBe(
        '/testbrand/hooks/claude-terminal/worktree-session',
      );
      expect(branded.CANOPY_MCP_PROXY_PATH).toBe('/testbrand/mcp/proxy');
      expect(branded.buildCanopyMcpProxyRoute('plugin-1')).toBe(
        '/testbrand/mcp/proxy/plugin-1',
      );
      expect(branded.DESKTOP_INTEGRATION_ALT_TOKEN_HEADER).toBe(
        'X-TestBrand-Integration-Token',
      );
      expect(branded.DESKTOP_INTEGRATION_TOKEN_ENV_VAR).toBe(
        'TESTBRAND_DESKTOP_INTEGRATION_TOKEN',
      );
      expect(branded.DESKTOP_INTEGRATION_HOOK_SCRIPT_FILENAME).toBe(
        'testbrand-hook-callback.js',
      );

      const brandedRoutes = [
        branded.CANOPY_MCP_WORKTREE_SESSION_PATH,
        branded.CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
        branded.CANOPY_MCP_PROXY_PATH,
      ];
      for (const route of brandedRoutes) {
        expect(route).not.toContain('/canopy');
      }
    });
  });

  describe('extractDesktopIntegrationToken', () => {
    it('reads the bearer header when present', () => {
      const headers: Record<string, string> = {
        Authorization: 'Bearer  my-token',
      };
      const token = extractDesktopIntegrationToken(
        (name) => headers[name] ?? null,
      );
      expect(token).toBe('my-token');
    });

    it('falls back to the alternate header', () => {
      const headers: Record<string, string> = {
        'X-Canopy-Integration-Token': '  other-token  ',
      };
      const token = extractDesktopIntegrationToken(
        (name) => headers[name] ?? null,
      );
      expect(token).toBe('other-token');
    });

    it('prefers the bearer header when both are set', () => {
      const headers: Record<string, string> = {
        Authorization: 'Bearer primary',
        'X-Canopy-Integration-Token': 'secondary',
      };
      const token = extractDesktopIntegrationToken(
        (name) => headers[name] ?? null,
      );
      expect(token).toBe('primary');
    });

    it('returns null when nothing recognisable is present', () => {
      expect(extractDesktopIntegrationToken(() => null)).toBeNull();
      expect(extractDesktopIntegrationToken(() => '')).toBeNull();
      expect(
        extractDesktopIntegrationToken((name) =>
          name === 'Authorization' ? 'Basic abc' : null,
        ),
      ).toBeNull();
    });
  });

  describe('hook callback body validation', () => {
    it('recognises every documented hook event name', () => {
      expect(CLAUDE_TERMINAL_HOOK_EVENT_NAMES).toContain('SubagentStart');
      for (const name of CLAUDE_TERMINAL_HOOK_EVENT_NAMES) {
        expect(isClaudeTerminalHookEventName(name)).toBe(true);
      }
      expect(isClaudeTerminalHookEventName('NotAnEvent')).toBe(false);
      expect(isClaudeTerminalHookEventName(123)).toBe(false);
    });

    it('accepts well-formed hook callback bodies', () => {
      expect(
        isClaudeTerminalHookCallbackBody({
          hookEventName: 'SessionStart',
          hookPayload: { session_id: 'x' },
        }),
      ).toBe(true);
      expect(
        isClaudeTerminalHookCallbackBody({
          hookEventName: 'PostCompact',
          hookPayload: null,
        }),
      ).toBe(true);
    });

    it('rejects bodies with unknown event names or missing payload', () => {
      expect(
        isClaudeTerminalHookCallbackBody({
          hookEventName: 'UnknownEvent',
          hookPayload: {},
        }),
      ).toBe(false);
      expect(
        isClaudeTerminalHookCallbackBody({ hookEventName: 'SessionStart' }),
      ).toBe(false);
      expect(isClaudeTerminalHookCallbackBody(null)).toBe(false);
      expect(isClaudeTerminalHookCallbackBody('SessionStart')).toBe(false);
    });
  });

  it('locks the claude-code-terminal MCP surface to terminal-safe worktree and Ledger tools', () => {
    expect(CLAUDE_TERMINAL_MCP_TOOL_KEYS).toEqual([
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
});
