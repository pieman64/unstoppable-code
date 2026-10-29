import { BRAND } from '@canopy/brand/current';
import { APP_ADVISOR_TOOL_KEYS } from '../app-advisor-tools';
import { CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS } from '../canopy-injected-tools';
import {
  cursorCanopyMcpServerNames,
  isReadOnlyCursorAppTool,
  parseCursorMcpToolCall,
  resolveCursorAppAdvisorToolKey,
  resolveCursorCanopyToolKey,
} from '../cursor-mcp-tool-call';

describe('parseCursorMcpToolCall', () => {
  const ns = BRAND.tools.namespace;

  it('reads the structured rawInput the pinned CLI sends for an MCP tool_call', () => {
    expect(
      parseCursorMcpToolCall({
        title: `${ns}: GetGitPreferences`,
        kind: 'other',
        rawInput: {
          providerIdentifier: ns,
          toolName: 'GetGitPreferences',
          args: { type: 'branch-name' },
        },
      }),
    ).toEqual({
      server: ns,
      tool: 'GetGitPreferences',
      args: { type: 'branch-name' },
    });
  });

  it('falls back to the "<server>: <tool>" title of a permission request', () => {
    expect(
      parseCursorMcpToolCall({ title: 'linear: create_issue', kind: 'other' }),
    ).toEqual({ server: 'linear', tool: 'create_issue' });
    expect(parseCursorMcpToolCall({ title: 'linear: create_issue' })).toEqual({
      server: 'linear',
      tool: 'create_issue',
    });
  });

  it('never treats a native tool title as an MCP call', () => {
    expect(
      parseCursorMcpToolCall({ title: 'Read src/index.ts', kind: 'read' }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({ title: 'Edit `notes: today.md`', kind: 'edit' }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({ title: '`echo a: b`', kind: 'execute' }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({ title: 'Search: "a: b"', kind: 'search' }),
    ).toBeNull();
    expect(parseCursorMcpToolCall({ title: 'Unknown operation' })).toBeNull();
  });

  it('rejects empty, oversized, or inconsistent identities', () => {
    expect(
      parseCursorMcpToolCall({ title: ': tool', kind: 'other' }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({ title: 'server: ', kind: 'other' }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({
        title: `${'a'.repeat(300)}: tool`,
        kind: 'other',
      }),
    ).toBeNull();
    expect(
      parseCursorMcpToolCall({
        title: `${ns}: X`,
        kind: 'other',
        rawInput: { providerIdentifier: 7, toolName: 'X' },
      }),
    ).toEqual({ server: ns, tool: 'X' });
    expect(
      parseCursorMcpToolCall({
        title: `${ns}: X`,
        kind: 'other',
        rawInput: { providerIdentifier: 'other', toolName: 'X' },
      }),
    ).toBeNull();
  });
});

describe('resolveCursorCanopyToolKey', () => {
  const ns = BRAND.tools.namespace;

  it('maps the main and _ui Canopy servers to canonical keys', () => {
    expect(
      resolveCursorCanopyToolKey({ server: ns, tool: 'GetGitPreferences' }),
    ).toBe('get_git_preferences');
    expect(
      resolveCursorCanopyToolKey({
        server: `${ns}_ui`,
        tool: 'AskUserQuestion',
      }),
    ).toBe('ask_user_question');
  });

  it('returns null for other servers, off-surface tools, and unknown tools', () => {
    expect(
      resolveCursorCanopyToolKey({
        server: 'linear',
        tool: 'GetGitPreferences',
      }),
    ).toBeNull();
    expect(
      resolveCursorCanopyToolKey({ server: ns, tool: 'AskUserQuestion' }),
    ).toBeNull();
    expect(
      resolveCursorCanopyToolKey({ server: ns, tool: 'GetCodeGraphContext' }),
    ).toBeNull();
    expect(resolveCursorCanopyToolKey({ server: ns, tool: 'Nope' })).toBeNull();
  });

  it('resolves the Cowork surface against its own allowlist', () => {
    expect(
      resolveCursorCanopyToolKey(
        { server: ns, tool: 'DispatchAction' },
        'cursor-acp-standalone',
      ),
    ).toBe('dispatch_action');
    expect(
      resolveCursorCanopyToolKey(
        { server: ns, tool: 'WatchGitHubItems' },
        'cursor-acp-standalone',
      ),
    ).toBe('watch_github_items');
    expect(
      resolveCursorCanopyToolKey(
        { server: ns, tool: 'GetGitHubPullRequestStatus' },
        'cursor-acp-standalone',
      ),
    ).toBe('get_github_pull_request_status');
    for (const tool of ['SetBaseBranch', 'GetGitPreferences'])
      expect(
        resolveCursorCanopyToolKey(
          { server: ns, tool },
          'cursor-acp-standalone',
        ),
      ).toBeNull();
    expect(
      resolveCursorCanopyToolKey(
        { server: `${ns}_ui`, tool: 'AskUserQuestion' },
        'cursor-acp-standalone',
      ),
    ).toBe('ask_user_question');
    expect(
      resolveCursorCanopyToolKey({ server: ns, tool: 'SetBaseBranch' }),
    ).toBe('set_base_branch');
  });

  it('treats only state-reading app tools (and asking the user) as read-only', () => {
    const readOnly = CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[
      'cursor-acp'
    ].filter((key) => isReadOnlyCursorAppTool(key));
    expect(readOnly).toEqual([
      'get_script_output',
      'get_git_preferences',
      'search_memory',
      'read_memory',
      'read_pipeline_yaml',
      'show_files',
      'show_capabilities',
      'show_visual',
      'preview_visual',
      'get_file_comments',
      'search_actions',
      'search_watchers',
      'get_github_pull_request_status',
    ]);
    expect(isReadOnlyCursorAppTool('ask_user_question')).toBe(true);
    for (const key of [
      'watch_github_items',
      'watch_command',
      'save_memory',
      'dispatch_action',
      'set_base_branch',
    ] as const)
      expect(isReadOnlyCursorAppTool(key)).toBe(false);
  });
});

describe('cursorCanopyMcpServerNames', () => {
  const ns = BRAND.tools.namespace;
  it('names the worktree servers by default', () => {
    expect(cursorCanopyMcpServerNames()).toEqual({ main: ns, ui: `${ns}_ui` });
    expect(cursorCanopyMcpServerNames('default')).toEqual({
      main: ns,
      ui: `${ns}_ui`,
    });
  });
  it('names the App Advisor main server like the proxy announces it', () => {
    expect(cursorCanopyMcpServerNames('app-advisor')).toEqual({
      main: `${ns}_app_advisor`,
      ui: `${ns}_ui`,
    });
  });
});

describe('resolveCursorAppAdvisorToolKey', () => {
  const names = cursorCanopyMcpServerNames('app-advisor');
  it('maps every App Advisor main-server tool by display name', () => {
    for (const key of APP_ADVISOR_TOOL_KEYS) {
      if (key === 'ask_user_question') continue;
      // The proxy advertises the PascalCase of each key; pin that rule. The
      // Agent Ledger keys are the exception: they advertise the Feed's names.
      const tool = key
        .split('_')
        .map((part) => (part[0]?.toUpperCase() ?? '') + part.slice(1))
        .join('')
        .replace('Github', 'GitHub')
        .replace('Ledger', 'Feed');
      expect(resolveCursorAppAdvisorToolKey({ server: names.main, tool })).toBe(
        key,
      );
    }
  });
  it('maps AskUserQuestion only on the ui server', () => {
    expect(
      resolveCursorAppAdvisorToolKey({
        server: names.ui,
        tool: 'AskUserQuestion',
      }),
    ).toBe('ask_user_question');
    expect(
      resolveCursorAppAdvisorToolKey({
        server: names.main,
        tool: 'AskUserQuestion',
      }),
    ).toBeNull();
    expect(
      resolveCursorAppAdvisorToolKey({ server: names.ui, tool: 'ShowFiles' }),
    ).toBeNull();
  });
  it('resolves nothing for worktree tools or foreign servers', () => {
    expect(
      resolveCursorAppAdvisorToolKey({
        server: names.main,
        tool: 'GetGitPreferences',
      }),
    ).toBeNull();
    expect(
      resolveCursorAppAdvisorToolKey({
        server: BRAND.tools.namespace,
        tool: 'SearchActions',
      }),
    ).toBeNull();
    expect(
      resolveCursorAppAdvisorToolKey({
        server: 'linear',
        tool: 'SearchActions',
      }),
    ).toBeNull();
  });
});
