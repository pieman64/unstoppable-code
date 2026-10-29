/**
 * Tests the closed-union tool-family dispatch helpers. Ensures every
 * `PortalChatToolFamily` value maps to a real icon component + a non-empty
 * label, and that `undefined` falls back to the generic wrench affordance.
 */
import { renderToString } from 'react-dom/server';
import {
  getToolFamilyIcon,
  getToolFamilyLabel,
  renderToolFamilyIcon,
  type PortalChatToolFamily,
} from '../tool-display-info';
import {
  getToolDisplayInfo,
  getSendMessageDisplayInfo,
  getToolFamilyFromName,
  isSetAutoArchiveToolName,
  getToolRowInput,
} from '../tool-display';
import {
  AgentIcon,
  AppAdvisorIcon,
  ArchiveIcon,
  ClaudeLogo,
  CodeBracketsIcon,
  WrenchIcon,
} from '../../../icons';
import { PickIcon } from '../../../icons/AppIcons';

describe('project/bot chat wrapper rendering compatibility', () => {
  it('keeps generic App, App Advisor and Watcher family labels', () => {
    expect(getToolFamilyLabel('canopy')).toBe('App');
    expect(getToolFamilyLabel('app-advisor')).toBe('App Advisor');
    expect(getToolFamilyLabel('watcher')).toBe('Watcher');
  });

  const dispatchWrappers = [
    'mcp__canopy__DispatchAction',
    'canopy_dispatch_action',
    // Cursor ACP tool-display normalization emits the Claude/MCP name,
    // not its raw "Canopy: DispatchAction" transport title.
    'mcp__canopy__DispatchAction',
    'mcp__canopy_app_advisor__DispatchAction',
    'canopy_app_advisor_dispatch_action',
    'DispatchAction',
    'mcp__canopy__DispatchAction',
  ];

  it.each([
    ['projects.list', 'Projects - List'],
    ['projects.list_tasks', 'Projects - List Tasks'],
    ['projects.list_task_chats', 'Projects - List Task Chats'],
    ['projects.get_last_user_message', 'Projects - Get Last User Message'],
    ['projects.get_last_agent_response', 'Projects - Get Last Agent Response'],
    ['projects.read_history', 'Projects - Read History'],
    ['projects.send_message', 'Projects - Send Message'],
    ['projects.create_task', 'Projects - Create Task'],
    ['projects.create_task_chat', 'Projects - Create Task Chat'],
    ['bots.list', 'Bots - List'],
    ['bots.list_tasks', 'Bots - List Tasks'],
    ['bots.list_task_chats', 'Bots - List Task Chats'],
    ['bots.get_last_user_message', 'Bots - Get Last User Message'],
    ['bots.get_last_agent_response', 'Bots - Get Last Agent Response'],
    ['bots.read_history', 'Bots - Read History'],
    ['bots.send_message', 'Bots - Send Message'],
    ['bots.create_task', 'Bots - Create Task'],
    ['bots.create_task_chat', 'Bots - Create Task Chat'],
    ['projects.steer_queued_message', 'Projects - Steer Queued Message'],
    ['projects.schedule_message', 'Projects - Schedule Message'],
    ['worktree-chat.send_message', 'Worktree Chat - Send Message'],
    ['standalone-chat.read_history', 'Standalone Chat - Read History'],
    ['advisor-chat.create_entry', 'Advisor Chat - Create Entry'],
    ['future_tools.inspect_status', 'Future Tools - Inspect Status'],
  ])('keeps a readable generic title for %s', (type, title) => {
    for (const wrapper of dispatchWrappers) {
      const info = getToolDisplayInfo(
        wrapper,
        JSON.stringify({ action: { type } }),
        TRUSTED_MCP_SCOPE,
      );
      const html = renderToString(<>{info.label}</>);
      expect(html).toContain('Dispatch action');
      expect(html).toContain(title);
    }
  });

  it.each([
    'project_task_chat_completion',
    'project_new_chat_started',
    'bot_task_chat_completion',
    'bot_new_chat_started',
    'worktree_chat_completion',
    'worktree_new_chat_started',
    'standalone_chat_completion',
    'standalone_new_chat_started',
  ])('keeps query/count watcher titles for %s', (trigger) => {
    const wrappers = [
      ['mcp__canopy__SearchWatchers', 'mcp__canopy__SetupWatchers'],
      ['canopy_search_watchers', 'canopy_setup_watchers'],
      [
        // The names emitted by Cursor ACP normalization.
        'mcp__canopy__SearchWatchers',
        'mcp__canopy__SetupWatchers',
      ],
      [
        'mcp__canopy_app_advisor__SearchWatchers',
        'mcp__canopy_app_advisor__SetupWatchers',
      ],
      [
        'canopy_app_advisor_search_watchers',
        'canopy_app_advisor_setup_watchers',
      ],
      ['SearchWatchers', 'SetupWatchers'],
    ];
    for (const [search, setup] of wrappers) {
      const searchInfo = getToolDisplayInfo(
        search,
        JSON.stringify({ query: 'chat completion', trigger }),
        TRUSTED_MCP_SCOPE,
      );
      const setupInfo = getToolDisplayInfo(
        setup,
        JSON.stringify({ watchers: [{ trigger, target: {} }] }),
        TRUSTED_MCP_SCOPE,
      );
      expect(renderToString(<>{searchInfo.label}</>)).toContain(
        'Search watchers',
      );
      expect(renderToString(<>{searchInfo.label}</>)).toContain(
        'chat completion',
      );
      const setupHtml = renderToString(<>{setupInfo.label}</>);
      expect(setupHtml).toContain('Setup watchers');
      expect(setupHtml.replace(/<[^>]*>/g, '')).toBe(
        'Setup watchers 1 watcher',
      );
      expect(setupHtml).not.toContain(trigger);
      expect(getToolFamilyFromName(search, TRUSTED_MCP_SCOPE)).toBe('watcher');
      expect(getToolFamilyFromName(setup, TRUSTED_MCP_SCOPE)).toBe('watcher');
    }
  });
});

const TRUSTED_MCP_SCOPE = { trustedMcpNamespace: 'canopy' };

const FAMILIES: PortalChatToolFamily[] = [
  'read',
  'edit',
  'write',
  'plan',
  'bash',
  'grep',
  'glob',
  'todo',
  'web',
  'agent',
  'ask-user',
  'script-output',
  'skill',
  'monitor',
  'claude',
  'watcher',
  'canopy',
  'app-advisor',
  'pipeline-editor',
  'computer-use',
  'unknown',
];

describe('tool-display-info', () => {
  it.each([
    'mcp__canopy__PreviewVisual',
    'canopy_preview_visual',
    'canopy: PreviewVisual',
  ])('shows %s width and appearance without HTML', (name) => {
    const input = JSON.stringify({
      html: '<b>SECRET_HTML</b>',
      width: 520,
      appearance: 'dark',
    });
    expect(getToolRowInput(name, input)).toBe('520px, dark');
    expect(getToolRowInput(name, '<b>SECRET_HTML</b>')).toBe('');
    const label = renderToString(<>{getToolDisplayInfo(name, input).label}</>);
    expect(label).toContain('Preview visual');
    expect(label).toContain('520px, dark');
    expect(label).not.toContain('SECRET_HTML');
  });
  it.each(['mcp__canopy__ShowVisual', 'canopy_show_visual'])(
    'renders %s as a bounded app tool row',
    (name) => {
      const input = JSON.stringify({
        title: 'Revenue chart',
        html: '<b>SECRET_HTML</b>',
      });
      expect(getToolRowInput(name, input)).toBe('Revenue chart');
      expect(getToolRowInput(name, '<b>SECRET_HTML</b>')).toBe('');
      const display = getToolDisplayInfo(name, input);
      const label = renderToString(<>{display.label}</>);
      expect(label).toContain('Show visual');
      expect(label).toContain('Revenue chart');
      expect(label).not.toContain('SECRET_HTML');
      expect(getToolFamilyFromName(name)).toBe('canopy');
    },
  );
  it("leaves other tools' inputs unchanged", () => {
    const input = JSON.stringify({ title: 'x', html: '<p>kept</p>' });
    expect(getToolRowInput('Read', input)).toBe(input);
    expect(getToolRowInput('mcp__canopy__ShowFiles', input)).toBe(input);
  });
  it.each([
    'mcp__canopy_app_advisor__SetAutoArchive',
    'canopy_app_advisor_set_auto_archive',
    'mcp__somebrand_app_advisor__SetAutoArchive',
    'somebrand_app_advisor_set_auto_archive',
  ])(
    'renders Advisor auto-archive tool %s with the shared archive display',
    (name) => {
      expect(isSetAutoArchiveToolName(name)).toBe(true);
      expect(getToolDisplayInfo(name, '{"enabled":true}').label).toBe(
        'Enable chat auto-archive',
      );
      expect(getToolFamilyFromName(name)).toBe('app-advisor');
    },
  );

  it.each(FAMILIES)('maps %s to an icon component', (family) => {
    const Icon = getToolFamilyIcon(family);
    expect(typeof Icon).toBe('function');
    const html = renderToString(<Icon />);
    expect(html.length).toBeGreaterThan(0);
  });

  it.each(FAMILIES)('maps %s to a non-empty label', (family) => {
    expect(getToolFamilyLabel(family).length).toBeGreaterThan(0);
  });

  it('falls back to the wrench icon for undefined family', () => {
    const Icon = getToolFamilyIcon(undefined);
    expect(typeof Icon).toBe('function');
    const html = renderToString(<Icon />);
    expect(html.length).toBeGreaterThan(0);
  });

  it('falls back to a "Tool" label for undefined family', () => {
    expect(getToolFamilyLabel(undefined)).toBe('Tool');
  });

  it('renders compact and historical proxied MCP names identically', () => {
    const toolName = 'list_agentic_agent_session_artifacts';
    const compactLabel = renderToString(
      <>
        {
          getToolDisplayInfo(
            `mcp__appproxy-prod-mcp-server--1b377c49de9ad913__${toolName}`,
            '{}',
          ).label
        }
      </>,
    );
    const historicalLabel = renderToString(
      <>
        {
          getToolDisplayInfo(
            `mcp__appproxy-prod-mcp-server--622d6a60-adde-461c-9888-b1d100efcd26-59e020b9-764b-48a2-b23f-3f66acb2a165__${toolName}`,
            '{}',
          ).label
        }
      </>,
    );

    expect(compactLabel).toBe(historicalLabel);
    expect(compactLabel).toContain('Prod Mcp Server');
    expect(compactLabel).toContain('List Agentic Agent Session Artifacts');
    expect(compactLabel).not.toContain('appproxy');
    expect(compactLabel).not.toContain('1b377c49de9ad913');
  });

  it('renderToolFamilyIcon emits a JSX element', () => {
    const html = renderToString(renderToolFamilyIcon('bash'));
    expect(html.length).toBeGreaterThan(0);
  });

  it('renders Computer Use tools with the cursor icon and reset detail', () => {
    const run = getToolDisplayInfo('mcp__cua_repl__js', '{"code":"1 + 1"}');
    const reset = getToolDisplayInfo('mcp__cua_repl__js_reset', '{}');

    expect(renderToString(run.icon)).toBe(renderToString(<PickIcon />));
    expect(renderToString(reset.icon)).toBe(renderToString(<PickIcon />));
    expect(renderToString(<>{run.label}</>)).toContain('Computer use');
    const resetLabel = renderToString(<>{reset.label}</>);
    expect(resetLabel).toContain('Computer use');
    expect(resetLabel).toContain('Reset');
    expect(resetLabel).toContain('<code');
    expect(getToolFamilyFromName('mcp__cua_repl__js')).toBe('computer-use');
    expect(getToolFamilyFromName('mcp__cua_repl__js_reset')).toBe(
      'computer-use',
    );
  });

  it('does not claim another MCP server that happens to expose js', () => {
    expect(getToolFamilyFromName('mcp__other_server__js')).toBe('unknown');
    const label = renderToString(
      <>{getToolDisplayInfo('mcp__other_server__js', '{}').label}</>,
    );
    expect(label).toContain('Other Server');
    expect(label).toContain('Js');
    expect(label).not.toContain('Computer use');
  });

  it('produces distinct icons for read vs bash', () => {
    const readHtml = renderToString(renderToolFamilyIcon('read'));
    const bashHtml = renderToString(renderToolFamilyIcon('bash'));
    expect(readHtml).not.toEqual(bashHtml);
  });

  it('maps Canopy worktree action names to the canopy family', () => {
    expect(getToolFamilyFromName('mcp__canopy__SearchActions')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_search_actions')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__DispatchAction')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_dispatch_action')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__GetGitPreferences')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('canopy_get_git_preferences')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__SaveMemory')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_save_memory')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__SearchMemory')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_search_memory')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__ReadMemory')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_read_memory')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__ReadPipelineYaml')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('canopy_read_pipeline_yaml')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__ShowFiles')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_show_files')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_get_file_comments')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_respond_to_file_comment')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('mcp__canopy__SetAutoArchive')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_set_auto_archive')).toBe('canopy');
    expect(getToolFamilyFromName('SetAutoArchive')).toBe('canopy');
    // Historical tool names remain recognizable in persisted transcripts.
    expect(getToolFamilyFromName('mcp__canopy__ArchiveChat')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_archive_chat')).toBe('canopy');
    expect(getToolFamilyFromName('ArchiveChat')).toBe('canopy');
    expect(
      getToolFamilyFromName(
        'mcp__canopy__SearchDeferredTools',
        TRUSTED_MCP_SCOPE,
      ),
    ).toBe('canopy');
    expect(getToolFamilyFromName('canopy_search_deferred_tools')).toBe(
      'canopy',
    );
    expect(
      getToolFamilyFromName(
        'mcp__canopy__LoadDeferredTools',
        TRUSTED_MCP_SCOPE,
      ),
    ).toBe('canopy');
    expect(getToolFamilyFromName('canopy_load_deferred_tools')).toBe('canopy');
    expect(getToolFamilyFromName('somebrand_search_deferred_tools')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('mcp__canopy__AddFeedEntry')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_add_feed_entry')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__SearchFeedEntries')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('canopy_search_feed_entries')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__canopy__UpdateFeedEntry')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('canopy_update_feed_entry')).toBe('canopy');
  });

  it('renders memory tool labels with their scope and query context', () => {
    const saveHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__SaveMemory',
            '{"text":"Uses Vim","scope":"user"}',
          ).label
        }
      </>,
    );
    const searchHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_search_memory',
            '{"query":"package manager"}',
          ).label
        }
      </>,
    );
    const readHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_read_memory',
            '{"scope":"workspace","file":"topics/package-manager.md"}',
          ).label
        }
      </>,
    );

    expect(saveHtml).toContain(
      'data-testid="chat-tool-call-save-memory-label"',
    );
    expect(saveHtml).toContain('Save');
    expect(saveHtml).toContain('user');
    expect(saveHtml).toContain('memory');
    expect(searchHtml).toContain(
      'data-testid="chat-tool-call-search-memory-label"',
    );
    expect(searchHtml).toContain('Search memory');
    expect(searchHtml).toContain('package manager');
    expect(readHtml).toContain(
      'data-testid="chat-tool-call-read-memory-label"',
    );
    expect(readHtml).toContain('Read');
    expect(readHtml).toContain('workspace');
    expect(readHtml).toContain('memory');
    expect(readHtml).toContain('topics/package-manager.md');
  });

  it('renders ledger tool labels with their title, query, and status context', () => {
    const addHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__AddFeedEntry',
            '{"type":"TASK","title":"Fix the login redirect loop","content":"Investigate"}',
          ).label
        }
      </>,
    );
    const searchHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_search_feed_entries',
            '{"query":"login redirect"}',
          ).label
        }
      </>,
    );
    const searchByIdsHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_search_feed_entries',
            '{"entryIds":["11111111-1111-1111-1111-111111111111"]}',
          ).label
        }
      </>,
    );
    const updateHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__UpdateFeedEntry',
            '{"entryId":"11111111-1111-1111-1111-111111111111","expectedRevision":1,"status":"IN_PROGRESS","owner":"self"}',
          ).label
        }
      </>,
    );

    expect(addHtml).toContain(
      'data-testid="chat-tool-call-add-ledger-entry-label"',
    );
    expect(addHtml).toContain('Add Feed entry');
    expect(addHtml).toContain('Fix the login redirect loop');
    expect(searchHtml).toContain(
      'data-testid="chat-tool-call-search-ledger-entries-label"',
    );
    expect(searchHtml).toContain('Search Feed');
    expect(searchHtml).toContain('login redirect');
    expect(searchByIdsHtml).toContain('Search Feed');
    expect(searchByIdsHtml).toContain('1');
    expect(searchByIdsHtml).toContain('entry');
    expect(updateHtml).toContain(
      'data-testid="chat-tool-call-update-ledger-entry-label"',
    );
    expect(updateHtml).toContain('Update Feed entry');
    expect(updateHtml).toContain('IN_PROGRESS');
    expect(updateHtml).toContain('owner self');
  });

  it('renders Cursor and App Advisor Ledger calls exactly like the native Ledger calls', () => {
    // Cursor persists the CLI title of the call on the app's MCP server, and
    // App Advisor advertises the Ledger tools under its own namespace. Both
    // fold into the phase 05 Ledger UX, including the canopy family.
    const cases = [
      {
        native: 'mcp__canopy__AddFeedEntry',
        input:
          '{"type":"TASK","title":"Fix the checkout retry loop","content":"Investigate"}',
        aliases: [
          'canopy: AddFeedEntry',
          'mcp__canopy_app_advisor__AddFeedEntry',
          'canopy_app_advisor_add_feed_entry',
          'mcp__somebrand_app_advisor__AddFeedEntry',
          'somebrand_app_advisor_add_feed_entry',
        ],
      },
      {
        native: 'canopy_search_feed_entries',
        input: '{"query":"checkout retry","owner":"self"}',
        aliases: [
          'canopy: SearchFeedEntries',
          'mcp__canopy_app_advisor__SearchFeedEntries',
          'canopy_app_advisor_search_feed_entries',
          'mcp__somebrand_app_advisor__SearchFeedEntries',
          'somebrand_app_advisor_search_feed_entries',
        ],
      },
      {
        native: 'mcp__canopy__UpdateFeedEntry',
        input:
          '{"entryId":"11111111-1111-1111-1111-111111111111","expectedRevision":1,"status":"IN_PROGRESS","owner":"self"}',
        aliases: [
          'canopy: UpdateFeedEntry',
          'mcp__canopy_app_advisor__UpdateFeedEntry',
          'canopy_app_advisor_update_feed_entry',
          'mcp__somebrand_app_advisor__UpdateFeedEntry',
          'somebrand_app_advisor_update_feed_entry',
        ],
      },
    ];

    for (const { native, input, aliases } of cases) {
      const expected = getToolDisplayInfo(native, input, TRUSTED_MCP_SCOPE);
      const expectedLabel = renderToString(<>{expected.label}</>);
      const expectedIcon = renderToString(expected.icon);
      expect(expectedLabel).toContain('data-testid="chat-tool-call-');
      for (const alias of aliases) {
        for (const scope of [undefined, TRUSTED_MCP_SCOPE]) {
          const actual = getToolDisplayInfo(alias, input, scope);
          expect(renderToString(<>{actual.label}</>)).toBe(expectedLabel);
          expect(renderToString(actual.icon)).toBe(expectedIcon);
          expect(getToolFamilyFromName(alias, scope)).toBe('canopy');
        }
      }
    }
  });

  it('renders persisted pre-Feed Ledger tool names with the Feed labels', () => {
    const cases = [
      {
        native: 'mcp__canopy__AddFeedEntry',
        input: '{"type":"TASK","title":"Fix the checkout retry loop"}',
        legacy: [
          'mcp__canopy__AddLedgerEntry',
          'canopy_add_ledger_entry',
          'canopy: AddLedgerEntry',
          'AddLedgerEntry',
          'mcp__canopy_app_advisor__AddLedgerEntry',
          'canopy_app_advisor_add_ledger_entry',
        ],
        label: 'Add Feed entry',
      },
      {
        native: 'canopy_search_feed_entries',
        input: '{"query":"checkout retry"}',
        legacy: [
          'mcp__canopy__SearchLedgerEntries',
          'canopy_search_ledger_entries',
          'canopy: SearchLedgerEntries',
          'SearchLedgerEntries',
          'mcp__canopy_app_advisor__SearchLedgerEntries',
          'canopy_app_advisor_search_ledger_entries',
        ],
        label: 'Search Feed',
      },
      {
        native: 'mcp__canopy__UpdateFeedEntry',
        input:
          '{"entryId":"11111111-1111-1111-1111-111111111111","status":"COMPLETED"}',
        legacy: [
          'mcp__canopy__UpdateLedgerEntry',
          'canopy_update_ledger_entry',
          'canopy: UpdateLedgerEntry',
          'UpdateLedgerEntry',
          'mcp__canopy_app_advisor__UpdateLedgerEntry',
          'canopy_app_advisor_update_ledger_entry',
        ],
        label: 'Update Feed entry',
      },
    ];

    for (const { native, input, legacy, label } of cases) {
      const expectedLabel = renderToString(
        <>{getToolDisplayInfo(native, input, TRUSTED_MCP_SCOPE).label}</>,
      );
      expect(expectedLabel).toContain(label);
      for (const legacyName of legacy) {
        expect(
          renderToString(
            <>
              {getToolDisplayInfo(legacyName, input, TRUSTED_MCP_SCOPE).label}
            </>,
          ),
        ).toBe(expectedLabel);
        expect(getToolFamilyFromName(legacyName, TRUSTED_MCP_SCOPE)).toBe(
          'canopy',
        );
      }
    }
  });

  it('folds a Ledger Cursor title only when it names the app MCP server', () => {
    const input = '{"query":"checkout retry"}';
    const brandedScope = { trustedMcpNamespace: 'somebrand' };
    const labelHtml = (
      toolName: string,
      scope?: { trustedMcpNamespace: string },
    ): string =>
      renderToString(<>{getToolDisplayInfo(toolName, input, scope).label}</>);

    expect(
      getToolFamilyFromName('somebrand: SearchFeedEntries', brandedScope),
    ).toBe('canopy');
    expect(labelHtml('somebrand: SearchFeedEntries', brandedScope)).toBe(
      labelHtml('mcp__somebrand__SearchFeedEntries', brandedScope),
    );
    // Without the host's namespace a branded title is any other server's.
    expect(getToolFamilyFromName('somebrand: SearchFeedEntries')).toBe(
      'unknown',
    );
    // A plugin server's tool with the same name is not the app's Ledger tool.
    expect(
      getToolFamilyFromName('linear: SearchFeedEntries', TRUSTED_MCP_SCOPE),
    ).toBe('unknown');
    expect(
      labelHtml('linear: SearchFeedEntries', TRUSTED_MCP_SCOPE),
    ).not.toContain('chat-tool-call-search-ledger-entries-label');
  });

  it('keeps the other App Advisor tools out of the Ledger folding', () => {
    expect(getToolFamilyFromName('mcp__canopy_app_advisor__ShowFiles')).toBe(
      'app-advisor',
    );
    expect(getToolFamilyFromName('canopy_app_advisor_dispatch_action')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__WatchGitHubItems'),
    ).toBe('watcher');
  });

  it('maps watcher tool names to the watcher family', () => {
    expect(getToolFamilyFromName('mcp__canopy__SearchWatchers')).toBe(
      'watcher',
    );
    expect(getToolFamilyFromName('canopy_setup_watchers')).toBe('watcher');
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__SearchWatchers'),
    ).toBe('watcher');
    expect(getToolFamilyFromName('app_advisor_setup_watchers')).toBe('watcher');
    expect(getToolFamilyFromName('mcp__somebrand__SearchWatchers')).toBe(
      'watcher',
    );
    expect(getToolFamilyFromName('somebrand_setup_watchers')).toBe('watcher');
    expect(getToolFamilyFromName('mcp__canopy__WatchGitHubItems')).toBe(
      'watcher',
    );
    expect(getToolFamilyFromName('canopy_watch_github_items')).toBe('watcher');
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__WatchGitHubItems'),
    ).toBe('watcher');
    expect(getToolFamilyFromName('app_advisor_watch_github_items')).toBe(
      'watcher',
    );
    expect(getToolFamilyFromName('mcp__canopy__DeleteWatchers')).toBe(
      'watcher',
    );
    expect(getToolFamilyFromName('canopy_delete_watchers')).toBe('watcher');
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__DeleteWatchers'),
    ).toBe('unknown');
    expect(getToolFamilyFromName('canopy_app_advisor_delete_watchers')).toBe(
      'unknown',
    );
  });

  it('maps App Advisor deferred tool names to the app-advisor family', () => {
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__SearchDeferredTools'),
    ).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_load_deferred_tools')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('somebrand_app_advisor_search_deferred_tools'),
    ).toBe('app-advisor');
  });

  it('maps App Advisor StartForkedAgent names to the app-advisor family', () => {
    for (const name of [
      'mcp__canopy_app_advisor__StartForkedAgent',
      'canopy_app_advisor_start_forked_agent',
      'somebrand_app_advisor_start_forked_agent',
    ]) {
      expect(getToolFamilyFromName(name)).toBe('app-advisor');
    }
  });

  it('maps pipeline-editor tool names to the pipeline-editor family', () => {
    expect(
      getToolFamilyFromName('mcp__canopy_pipeline_editor__GetCurrentPipeline'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName('canopy_pipeline_editor_pipeline_set_yaml'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName('mcp__canopy_pipeline_editor__SearchDeferredTools'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName('canopy_pipeline_editor_load_deferred_tools'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName('mcp__somebrand_pipeline_editor__OpenPipeline'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName('somebrand_pipeline_editor_navigation_to_list'),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName(
        'mcp__canopy_pipeline_editor__GetBuiltinActionDefinition',
      ),
    ).toBe('pipeline-editor');
    expect(
      getToolFamilyFromName(
        'canopy_pipeline_editor_pipeline_get_action_definition',
      ),
    ).toBe('pipeline-editor');
    // AskUserQuestion is intentionally NOT folded into the pipeline family.
    expect(
      getToolFamilyFromName('mcp__canopy_pipeline_editor__AskUserQuestion'),
    ).toBe('ask-user');
  });

  it('renders clean labels for deferred tool calls', () => {
    const search = getToolDisplayInfo(
      'canopy_search_deferred_tools',
      '{"queries":[{"text":"python"}]}',
    );
    expect(renderToString(<>{search.label}</>)).toContain(
      'Search deferred tools',
    );
    expect(renderToString(<>{search.label}</>)).toContain('1');
    expect(renderToString(<>{search.label}</>)).toContain('query');

    const load = getToolDisplayInfo(
      'mcp__canopy__LoadDeferredTools',
      '{"items":[{"ref":"skill:demo"},{"ref":"plugin:demo"}]}',
      TRUSTED_MCP_SCOPE,
    );
    expect(renderToString(<>{load.label}</>)).toContain('Load deferred tools');
    expect(renderToString(<>{load.label}</>)).toContain('2');
    expect(renderToString(<>{load.label}</>)).toContain('items');

    const untrustedLoad = getToolDisplayInfo(
      'mcp__evil__LoadDeferredTools',
      '{"items":[{"ref":"plugin:malicious"}]}',
      TRUSTED_MCP_SCOPE,
    );
    expect(getToolFamilyFromName('mcp__evil__LoadDeferredTools')).toBe(
      'unknown',
    );
    expect(renderToString(<>{untrustedLoad.label}</>)).toContain('Evil');

    const appAdvisor = getToolDisplayInfo(
      'app_advisor_search_deferred_tools',
      '{"queries":[{"text":"watcher"}]}',
    );
    expect(renderToString(<>{appAdvisor.label}</>)).toContain(
      'Search deferred tools',
    );

    const pipelineEditor = getToolDisplayInfo(
      'canopy_pipeline_editor_load_deferred_tools',
      '{"items":[{"ref":"mcp:demo"}]}',
    );
    expect(renderToString(<>{pipelineEditor.label}</>)).toContain(
      'Load deferred tools',
    );
  });

  it('renders clean labels and the pipeline icon for pipeline-editor tools', () => {
    const setYaml = getToolDisplayInfo(
      'mcp__canopy_pipeline_editor__SetPipelineYaml',
      '{"yaml":"pipeline: {}"}',
    );
    expect(renderToString(<>{setYaml.label}</>)).toContain(
      'Edit pipeline YAML',
    );
    const pipelineIcon = renderToString(setYaml.icon);
    // The same icon is used for every pipeline-editor capability.
    const open = getToolDisplayInfo(
      'mcp__canopy_pipeline_editor__OpenPipeline',
      '{"pipelineId":"p-1"}',
    );
    expect(renderToString(open.icon)).toEqual(pipelineIcon);
    expect(renderToString(<>{open.label}</>)).toContain('Open pipeline');
  });

  it('maps plan-comment tool names to the plan family', () => {
    expect(getToolFamilyFromName('canopy_respond_to_comment')).toBe('plan');
    expect(getToolFamilyFromName('GetPlanComments')).toBe('plan');
    expect(getToolFamilyFromName('mcp__canopy__RespondToComment')).toBe('plan');
    expect(getToolFamilyFromName('RespondToComment')).toBe('plan');
    expect(getToolFamilyFromName('mcp__canopy__GetPlanComments')).toBe('plan');
    expect(getToolFamilyFromName('canopy_get_plan_comments')).toBe('plan');
    expect(getToolFamilyFromName('mcp__somebrand__RespondToComment')).toBe(
      'plan',
    );
    expect(getToolFamilyFromName('somebrand_get_plan_comments')).toBe('plan');
  });

  it('renders a descriptive label and plan icon per plan-comment tool', () => {
    const planIcon = renderToString(
      getToolDisplayInfo('canopy_respond_to_comment', '{"threadId":"t-1"}')
        .icon,
    );
    expect(planIcon).toBe(renderToString(renderToolFamilyIcon('plan')));

    const respondLabel = renderToString(
      <>
        {
          getToolDisplayInfo(
            'RespondToComment',
            '{"threadId":"t-1","body":"hi","resolve":true}',
          ).label
        }
      </>,
    );
    expect(respondLabel).toContain('Reply &amp; resolve comment');
    expect(respondLabel).toContain('t-1');

    const replyOnlyLabel = renderToString(
      <>
        {
          getToolDisplayInfo(
            'RespondToComment',
            '{"threadId":"t-2","body":"hi"}',
          ).label
        }
      </>,
    );
    expect(replyOnlyLabel).toContain('Reply to comment');
    expect(replyOnlyLabel).not.toContain('resolve');

    const getCommentsLabel = renderToString(
      <>{getToolDisplayInfo('GetPlanComments', '{}').label}</>,
    );
    expect(getCommentsLabel).toContain('Read plan comments');
    expect(getCommentsLabel).toContain('all open threads');

    const readThreadLabel = renderToString(
      <>{getToolDisplayInfo('GetPlanComments', '{"threadId":"t-9"}').label}</>,
    );
    expect(readThreadLabel).toContain('Read comment thread');
    expect(readThreadLabel).toContain('t-9');
  });

  it('maps review-comment tool names to the plan family', () => {
    expect(getToolFamilyFromName('canopy_respond_to_comment')).toBe('plan');
    expect(getToolFamilyFromName('GetReviewComments')).toBe('plan');
    expect(getToolFamilyFromName('mcp__canopy__RespondToComment')).toBe('plan');
    expect(getToolFamilyFromName('RespondToComment')).toBe('plan');
    expect(getToolFamilyFromName('mcp__canopy__GetReviewComments')).toBe(
      'plan',
    );
    expect(getToolFamilyFromName('canopy_get_review_comments')).toBe('plan');
    expect(getToolFamilyFromName('mcp__somebrand__RespondToComment')).toBe(
      'plan',
    );
    expect(getToolFamilyFromName('somebrand_get_review_comments')).toBe('plan');
  });

  it('renders a descriptive label and plan icon per review-comment tool', () => {
    const planIcon = renderToString(
      getToolDisplayInfo('canopy_respond_to_comment', '{"threadId":"t-1"}')
        .icon,
    );
    expect(planIcon).toBe(renderToString(renderToolFamilyIcon('plan')));

    const respondLabel = renderToString(
      <>
        {
          getToolDisplayInfo(
            'RespondToComment',
            '{"threadId":"t-1","body":"hi","resolve":true}',
          ).label
        }
      </>,
    );
    expect(respondLabel).toContain('Reply &amp; resolve comment');
    expect(respondLabel).toContain('t-1');

    const getCommentsLabel = renderToString(
      <>{getToolDisplayInfo('GetReviewComments', '{}').label}</>,
    );
    expect(getCommentsLabel).toContain('Read review comments');
    expect(getCommentsLabel).toContain('all open threads');

    const readThreadLabel = renderToString(
      <>
        {getToolDisplayInfo('GetReviewComments', '{"threadId":"t-9"}').label}
      </>,
    );
    expect(readThreadLabel).toContain('Read comment thread');
    expect(readThreadLabel).toContain('t-9');
  });

  it('gives GetReviewComments a code-flavored icon by name alone, no scope needed', () => {
    const planIcon = renderToString(renderToolFamilyIcon('plan'));

    const reviewIcon = renderToString(
      getToolDisplayInfo('GetReviewComments', '{}').icon,
    );
    expect(reviewIcon).not.toBe(planIcon);
    expect(reviewIcon).toBe(renderToString(<CodeBracketsIcon />));

    // Same result across providers/brand namespaces — name-based, not scoped.
    const codexReviewIcon = renderToString(
      getToolDisplayInfo('canopy_get_review_comments', '{}').icon,
    );
    expect(codexReviewIcon).toBe(reviewIcon);
  });

  it('gives RespondToComment the code-flavored icon only when the host passes Code Review scope', () => {
    const planIcon = renderToString(renderToolFamilyIcon('plan'));
    const reviewIcon = renderToString(
      getToolDisplayInfo('GetReviewComments', '{}').icon,
    );

    // No scope (e.g. Plan Explore, or a host that can't thread chat scope
    // like the Portal web renderer) — RespondToComment stays the neutral
    // Plan icon since its raw name is identical in both surfaces.
    const unscoped = renderToString(
      getToolDisplayInfo('RespondToComment', '{"threadId":"t-1"}').icon,
    );
    expect(unscoped).toBe(planIcon);

    // Code Review scope flips it to the same code-flavored icon GetReviewComments uses.
    const scoped = renderToString(
      getToolDisplayInfo('RespondToComment', '{"threadId":"t-1"}', {
        isCodeReview: true,
      }).icon,
    );
    expect(scoped).toBe(reviewIcon);
    expect(scoped).not.toBe(planIcon);

    // Explicit `isCodeReview: false` (Plan Explore threading its own scope)
    // still resolves to the Plan icon.
    const explicitlyPlan = renderToString(
      getToolDisplayInfo('RespondToComment', '{"threadId":"t-1"}', {
        isCodeReview: false,
      }).icon,
    );
    expect(explicitlyPlan).toBe(planIcon);
  });

  it('keeps App Advisor action names in the app-advisor family', () => {
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__SearchActions'),
    ).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_search_actions')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__GetCurrentUiState'),
    ).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_get_current_ui_state')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__DispatchAction'),
    ).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_dispatch_action')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__ReadPipelineYaml'),
    ).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_read_pipeline_yaml')).toBe(
      'app-advisor',
    );
    expect(getToolFamilyFromName('mcp__canopy_app_advisor__ShowFiles')).toBe(
      'app-advisor',
    );
    expect(getToolFamilyFromName('app_advisor_show_files')).toBe('app-advisor');
    expect(getToolFamilyFromName('app_advisor_get_file_comments')).toBe(
      'app-advisor',
    );
    expect(getToolFamilyFromName('app_advisor_respond_to_file_comment')).toBe(
      'app-advisor',
    );
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__GetPipelineDebugContext'),
    ).toBe('app-advisor');
    expect(
      getToolFamilyFromName('app_advisor_get_pipeline_debug_context'),
    ).toBe('app-advisor');
  });

  it('keeps branded App Advisor tool names in the app-advisor family', () => {
    expect(
      getToolFamilyFromName('mcp__unstoppable-code_app_advisor__SearchActions'),
    ).toBe('app-advisor');
    expect(
      getToolFamilyFromName('unstoppable-code_app_advisor_dispatch_action'),
    ).toBe('app-advisor');
    expect(
      getToolFamilyFromName(
        'mcp__unstoppable-code_app_advisor__ReadPipelineYaml',
      ),
    ).toBe('app-advisor');
    expect(
      getToolFamilyFromName('unstoppable-code_app_advisor_read_pipeline_yaml'),
    ).toBe('app-advisor');
  });

  it('maps branded App Advisor watcher names to the watcher family', () => {
    expect(
      getToolFamilyFromName(
        'mcp__unstoppable-code_app_advisor__SearchWatchers',
      ),
    ).toBe('watcher');
    expect(
      getToolFamilyFromName('unstoppable-code_app_advisor_setup_watchers'),
    ).toBe('watcher');
  });

  it('uses the App Advisor icon for branded App Advisor action tool calls', () => {
    const iconHtml = renderToString(
      getToolDisplayInfo(
        'mcp__unstoppable-code_app_advisor__SearchActions',
        '{"query":"pipeline"}',
      ).icon,
    );
    expect(iconHtml).toBe(renderToString(<AppAdvisorIcon />));
  });

  it('maps branded Canopy worktree action names to the canopy family', () => {
    expect(getToolFamilyFromName('mcp__somebrand__SearchActions')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('somebrand_dispatch_action')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__somebrand__ReadPipelineYaml')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('mcp__somebrand__GetGitPreferences')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('somebrand_get_git_preferences')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('somebrand_read_pipeline_yaml')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('mcp__somebrand__ArchiveChat')).toBe('canopy');
    expect(getToolFamilyFromName('somebrand_archive_chat')).toBe('canopy');
    expect(getToolFamilyFromName('mcp__somebrand__SetAutoArchive')).toBe(
      'canopy',
    );
    expect(getToolFamilyFromName('somebrand_set_auto_archive')).toBe('canopy');
  });

  it('maps branded code-graph tool names to the graph family with correct labels', () => {
    const cases: Array<{
      mcpName: string;
      codexName: string;
      label: string;
    }> = [
      {
        mcpName: 'mcp__canopy__GetCodeGraphContext',
        codexName: 'canopy_get_code_graph_context',
        label: 'Code Graph context',
      },
      {
        mcpName: 'mcp__canopy__BuildOrUpdateCodeGraph',
        codexName: 'canopy_build_or_update_code_graph',
        label: 'Build Code Graph',
      },
      {
        mcpName: 'mcp__canopy__QueryCodeGraph',
        codexName: 'canopy_query_code_graph',
        label: 'Query Code Graph',
      },
      {
        mcpName: 'mcp__canopy__SearchCodeGraph',
        codexName: 'canopy_search_code_graph',
        label: 'Search Code Graph',
      },
      {
        mcpName: 'mcp__canopy__ExplainCodeSymbol',
        codexName: 'canopy_explain_code_symbol',
        label: 'Explain symbol',
      },
      {
        mcpName: 'mcp__canopy__GetImpactRadius',
        codexName: 'canopy_get_impact_radius',
        label: 'Impact radius',
      },
      {
        mcpName: 'mcp__canopy__DetectChangedSymbols',
        codexName: 'canopy_detect_changed_symbols',
        label: 'Detect changed symbols',
      },
      {
        mcpName: 'mcp__canopy__CompareChangeImpact',
        codexName: 'canopy_compare_change_impact',
        label: 'Compare change impact',
      },
      {
        mcpName: 'mcp__canopy__GetReviewContext',
        codexName: 'canopy_get_review_context',
        label: 'Review context',
      },
    ];

    for (const { mcpName, codexName, label } of cases) {
      expect(getToolFamilyFromName(mcpName)).toBe('graph');
      expect(getToolFamilyFromName(codexName)).toBe('graph');

      const mcpHtml = renderToString(
        <>{getToolDisplayInfo(mcpName, '{}').label}</>,
      );
      expect(mcpHtml).toContain(label);

      const codexHtml = renderToString(
        <>{getToolDisplayInfo(codexName, '{}').label}</>,
      );
      expect(codexHtml).toContain(label);
    }
  });

  it('surfaces call context in code-graph tool labels', () => {
    const query = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__QueryCodeGraph',
            '{"mode":"callers","target":"apps/desktop-app/src/main/lib/paths.ts::getWorktreeHomeDir"}',
          ).label
        }
      </>,
    );
    expect(query).toContain('Query Code Graph');
    expect(query).toContain('callers');
    expect(query).toContain('paths.ts::getWorktreeHomeDir');
    expect(query).not.toContain('apps/desktop-app/src/main/lib/paths.ts');

    const search = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_search_code_graph',
            '{"query":"getWorktreeHomeDir"}',
          ).label
        }
      </>,
    );
    expect(search).toContain('Search Code Graph');
    expect(search).toContain('getWorktreeHomeDir');

    const explain = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__ExplainCodeSymbol',
            '{"qualifiedName":"packages/protocol/src/index.ts::CanopyClient"}',
          ).label
        }
      </>,
    );
    expect(explain).toContain('Explain symbol');
    expect(explain).toContain('index.ts::CanopyClient');

    const impact = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__GetImpactRadius',
            '{"target":"packages/protocol/src/index.ts::CanopyClient","maxDepth":3}',
          ).label
        }
      </>,
    );
    expect(impact).toContain('Impact radius');
    expect(impact).toContain('index.ts::CanopyClient');
    expect(impact).toContain('depth 3');

    const review = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_get_review_context',
            '{"baseRef":"origin/develop"}',
          ).label
        }
      </>,
    );
    expect(review).toContain('Review context');
    expect(review).toContain('origin/develop');

    const detect = renderToString(
      <>
        {
          getToolDisplayInfo(
            'mcp__canopy__DetectChangedSymbols',
            '{"baseRef":"main"}',
          ).label
        }
      </>,
    );
    expect(detect).toContain('Detect changed symbols');
    expect(detect).toContain('main');

    const compare = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_compare_change_impact',
            '{"baseRef":"origin/develop","maxDepth":4}',
          ).label
        }
      </>,
    );
    expect(compare).toContain('Compare change impact');
    expect(compare).toContain('origin/develop');
    expect(compare).toContain('depth 4');
  });

  it('renders set-auto-archive tool calls with state-specific labels and a dedicated icon', () => {
    const enabledInfo = getToolDisplayInfo(
      'canopy_set_auto_archive',
      '{"enabled":true}',
    );
    expect(renderToString(enabledInfo.icon)).toBe(
      renderToString(<ArchiveIcon />),
    );
    expect(renderToString(<>{enabledInfo.label}</>)).toContain(
      'Enable chat auto-archive',
    );

    const brandedInfo = getToolDisplayInfo(
      'mcp__somebrand__SetAutoArchive',
      '{"enabled":false}',
    );
    expect(renderToString(brandedInfo.icon)).toBe(
      renderToString(<ArchiveIcon />),
    );
    expect(renderToString(<>{brandedInfo.label}</>)).toContain(
      'Disable chat auto-archive',
    );

    const legacyInfo = getToolDisplayInfo('canopy_archive_chat', '{}');
    expect(renderToString(<>{legacyInfo.label}</>)).toContain(
      'Set chat auto-archive',
    );
  });

  it('uses a neutral fallback for branded worktree action tool calls', () => {
    const iconHtml = renderToString(
      getToolDisplayInfo(
        'mcp__somebrand__DispatchAction',
        '{"action":{"type":"pipeline.run"}}',
      ).icon,
    );
    expect(iconHtml).toBe(renderToString(<WrenchIcon />));
  });

  it('maps ImmediateTurnRestart to the branded app family with its chat label', () => {
    const info = getToolDisplayInfo(
      'canopy_immediate_turn_restart',
      '{}',
      TRUSTED_MCP_SCOPE,
    );

    expect(
      getToolFamilyFromName('canopy_immediate_turn_restart', TRUSTED_MCP_SCOPE),
    ).toBe('canopy');
    expect(renderToString(<>{info.label}</>)).toBe('Refresh and resume');

    const spoofed = 'mcp__attacker__fake_immediate_turn_restart';
    expect(getToolFamilyFromName(spoofed, TRUSTED_MCP_SCOPE)).toBe('unknown');
    expect(
      renderToString(
        <>{getToolDisplayInfo(spoofed, '{}', TRUSTED_MCP_SCOPE).label}</>,
      ),
    ).not.toBe('Refresh and resume');

    const spoofedDynamicTool = 'attacker_fake_immediate_turn_restart';
    expect(getToolFamilyFromName(spoofedDynamicTool, TRUSTED_MCP_SCOPE)).toBe(
      'unknown',
    );
    expect(
      renderToString(
        <>
          {
            getToolDisplayInfo(spoofedDynamicTool, '{}', TRUSTED_MCP_SCOPE)
              .label
          }
        </>,
      ),
    ).not.toBe('Refresh and resume');
  });

  it('renders the Claude model-change marker with a descriptive label', () => {
    const info = getToolDisplayInfo(
      'ClaudeModelChange',
      '{"previous_model":"fable[1m]","detected_model":"opus[1m]","previous_model_display":"Fable 5 1M","detected_model_display":"Opus 4.8 1M","reported_model":"claude-opus-4-8"}',
    );
    expect(renderToString(info.icon)).toBe(
      renderToString(<ClaudeLogo width={14} height={14} />),
    );
    const labelHtml = renderToString(<>{info.label}</>);
    expect(labelHtml).toContain('Claude model changed from');
    expect(labelHtml).toContain('<strong>Fable 5 1M</strong>');
    expect(labelHtml).toContain('to');
    expect(labelHtml).toContain('<strong>Opus 4.8 1M</strong>');
    expect(labelHtml).not.toContain('fable[1m]');
    expect(labelHtml).not.toContain('opus[1m]');
    expect(labelHtml).not.toContain('claude-opus-4-8');
    expect(getToolFamilyFromName('ClaudeModelChange')).toBe('claude');
  });

  it('uses App Advisor-style labels for Canopy action tools', () => {
    const searchHtml = renderToString(
      <>
        {
          getToolDisplayInfo('canopy_search_actions', '{"query":"pipeline"}')
            .label
        }
      </>,
    );
    const dispatchHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_dispatch_action',
            '{"action":{"type":"pipeline.run"}}',
          ).label
        }
      </>,
    );
    const readYamlHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_read_pipeline_yaml',
            '{"pipelineId":"build.yml","startLine":4,"endLine":12,"pattern":"steps"}',
          ).label
        }
      </>,
    );

    expect(searchHtml).toContain('Search actions');
    expect(searchHtml).toContain('pipeline');
    expect(dispatchHtml).toContain('Dispatch action');
    expect(dispatchHtml).toContain('Pipeline - Run');
    expect(readYamlHtml).toContain('Read pipeline YAML');
    expect(readYamlHtml).toContain('build.yml');
    expect(readYamlHtml).toContain('lines 4-12');
    expect(readYamlHtml).toContain('steps');
  });

  it('renders WatchGitHubItems consistently for worktree and App Advisor calls', () => {
    const input = JSON.stringify({
      items: [
        { kind: 'workflow_run', repository: 'acme/api', runId: '1' },
        { kind: 'workflow_run', repository: 'acme/web', runId: '2' },
      ],
      notifyOn: { conclusions: ['failure'] },
    });
    const worktree = getToolDisplayInfo('canopy_watch_github_items', input);
    const advisor = getToolDisplayInfo(
      'mcp__canopy_app_advisor__WatchGitHubItems',
      input,
    );

    expect(renderToString(<>{worktree.label}</>)).toContain(
      'Watch GitHub workflow runs',
    );
    expect(renderToString(<>{worktree.label}</>)).toContain('>2<!-- -->');
    expect(renderToString(<>{worktree.label}</>)).toContain('runs</span>');
    expect(renderToString(<>{advisor.label}</>)).toContain('>2<!-- -->');
    expect(renderToString(<>{advisor.label}</>)).toContain('runs</span>');
    expect(renderToString(worktree.icon)).toBe(renderToString(advisor.icon));
    expect(getToolFamilyFromName('canopy_watch_github_items')).toBe('watcher');
    expect(
      getToolFamilyFromName('mcp__canopy_app_advisor__WatchGitHubItems'),
    ).toBe('watcher');
  });

  it('renders WatchGitHubItems pull request targets compactly', () => {
    const single = getToolDisplayInfo(
      'canopy_watch_github_items',
      JSON.stringify({
        items: [
          {
            kind: 'pull_request',
            target: 'https://github.com/acme/api/pull/42/files',
          },
        ],
      }),
    );
    const singleHtml = renderToString(<>{single.label}</>);
    expect(singleHtml).toContain('Watch pull requests');
    expect(singleHtml).toContain('acme/api#42');

    const many = getToolDisplayInfo(
      'mcp__canopy_app_advisor__WatchGitHubItems',
      JSON.stringify({
        repository: 'acme/api',
        items: [
          { kind: 'pull_request', target: 'acme/web#7' },
          { kind: 'pull_request', number: 9 },
        ],
      }),
    );
    expect(renderToString(<>{many.label}</>)).toContain('2 pull requests');

    const numbered = getToolDisplayInfo(
      'canopy_watch_github_items',
      JSON.stringify({
        items: [{ kind: 'pull_request', repository: 'acme/api', number: 3 }],
      }),
    );
    expect(renderToString(<>{numbered.label}</>)).toContain('acme/api#3');

    const defaultRepository = getToolDisplayInfo(
      'canopy_watch_github_items',
      JSON.stringify({
        repository: 'acme/api',
        items: [{ kind: 'pull_request', number: 9 }],
      }),
    );
    expect(renderToString(<>{defaultRepository.label}</>)).toContain(
      'acme/api#9',
    );
  });

  it('renders GetGitHubPullRequestStatus as an app read on every surface', () => {
    const input = JSON.stringify({
      pullRequest: 'https://github.com/acme/api/pull/42',
    });
    for (const name of [
      'mcp__canopy__GetGitHubPullRequestStatus',
      'canopy_get_github_pull_request_status',
      'GetGitHubPullRequestStatus',
    ]) {
      const html = renderToString(<>{getToolDisplayInfo(name, input).label}</>);
      expect(html).toContain('Read pull request status');
      expect(html).toContain('acme/api#42');
      expect(getToolFamilyFromName(name)).toBe('canopy');
    }
    const advisor = getToolDisplayInfo(
      'mcp__canopy_app_advisor__GetGitHubPullRequestStatus',
      JSON.stringify({ pullRequest: 'acme/web#7' }),
    );
    expect(renderToString(<>{advisor.label}</>)).toContain('acme/web#7');
    expect(
      getToolFamilyFromName(
        'mcp__canopy_app_advisor__GetGitHubPullRequestStatus',
      ),
    ).toBe('app-advisor');
    expect(
      renderToString(
        <>
          {
            getToolDisplayInfo(
              'canopy_get_github_pull_request_status',
              JSON.stringify({}),
            ).label
          }
        </>,
      ),
    ).toBe('Read pull request status');
  });

  it('renders DeleteWatchers for worktree calls', () => {
    const input = JSON.stringify({ watcherIds: ['watcher-1', 'watcher-2'] });
    const worktree = getToolDisplayInfo('canopy_delete_watchers', input);

    expect(renderToString(<>{worktree.label}</>)).toContain('Delete watchers');
    expect(renderToString(<>{worktree.label}</>)).toContain('>2<!-- -->');
  });

  it.each([
    [{ type: 'workspace.get' }, ['Read project']],
    [{ type: 'worktree.list', limit: 20 }, ['List worktrees']],
    [{ type: 'chat.list' }, ['List chats']],
    [{ type: 'models.list' }, ['List models']],
    [{ type: 'capability_package.analyze' }, ['Check share dependencies']],
    [{ type: 'chat.get', chatId: 'chat-2' }, ['Check chat', 'chat-2']],
    [
      { type: 'chat.send_message', chatId: 'chat-2', message: 'Also docs.' },
      ['Message chat', 'chat-2'],
    ],
    [{ type: 'chat.create', message: 'Review it.' }, ['Start chat']],
    [
      {
        type: 'chat.create',
        message: 'Spike it.',
        title: 'Parser spike',
        placement: 'new_worktree',
      },
      ['Start chat', 'Parser spike', 'in a new worktree'],
    ],
  ])('labels the environment action %j', (action, expected) => {
    for (const toolName of [
      'canopy_dispatch_action',
      'mcp__canopy__DispatchAction',
    ]) {
      const html = renderToString(
        <>{getToolDisplayInfo(toolName, JSON.stringify({ action })).label}</>,
      );
      for (const text of expected) expect(html).toContain(text);
      expect(html).not.toContain('Dispatch action');
    }
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'renders the generic dispatch row for the inherited key %s',
    (type) => {
      const html = renderToString(
        <>
          {
            getToolDisplayInfo(
              'mcp__canopy__DispatchAction',
              JSON.stringify({ action: { type } }),
            ).label
          }
        </>,
      );
      expect(html).toContain('Dispatch action');
    },
  );

  it('renders hook pause/resume dispatch actions with specific labels', () => {
    const pauseHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'canopy_dispatch_action',
            '{"action":{"type":"hook.pause","hookKey":"project:pr:checks:fail"}}',
          ).label
        }
      </>,
    );
    const resumeHtml = renderToString(
      <>
        {
          getToolDisplayInfo(
            'app_advisor_dispatch_action',
            '{"action":{"type":"hook.resume","all":true,"projectId":"project-1","worktreeId":"worktree-1"}}',
          ).label
        }
      </>,
    );

    expect(pauseHtml).toContain('Pause hook');
    expect(pauseHtml).toContain('project:pr:checks:fail');
    expect(resumeHtml).toContain('Resume all hooks');
    expect(resumeHtml).not.toContain('Dispatch action');
  });

  it('uses family icons for App Advisor and Canopy inline action rows', () => {
    const appAdvisorIcon = renderToString(
      getToolDisplayInfo(
        'mcp__canopy_app_advisor__DispatchAction',
        '{"action":{"type":"navigation.go_to_page"}}',
      ).icon,
    );
    const appAdvisorFamilyIcon = renderToString(
      renderToolFamilyIcon('app-advisor'),
    );
    const canopyIcon = renderToString(
      getToolDisplayInfo(
        'mcp__canopy__DispatchAction',
        '{"action":{"type":"pipeline.run"}}',
      ).icon,
    );
    const canopyFamilyIcon = renderToString(renderToolFamilyIcon('canopy'));

    expect(appAdvisorIcon).toBe(appAdvisorFamilyIcon);
    expect(canopyIcon).toBe(canopyFamilyIcon);
  });

  it('renders only the filename for Windows absolute file paths', () => {
    const windowsPath = [
      'C:',
      'Users',
      'Tommy',
      '.canopy',
      'workspaces',
      'canopy',
      'worktrees',
      'python',
      'apps',
      'desktop-app',
      'src',
      'renderer',
      'src',
      'components',
      'worktree',
      'WorkspaceSettingsModal.tsx',
    ].join('\\');
    const html = renderToString(
      <>
        {
          getToolDisplayInfo('Read', JSON.stringify({ file_path: windowsPath }))
            .label
        }
      </>,
    );

    expect(html).toContain('WorkspaceSettingsModal.tsx');
    expect(html).not.toContain('C:\\Users');
    expect(html).not.toContain('worktrees\\python');
  });

  it('renders last-line ReadLines labels', () => {
    const html = renderToString(
      <>
        {
          getToolDisplayInfo(
            'ReadLines',
            JSON.stringify({
              file_path:
                'packages/ui-shared/src/components/chat/tool-display.tsx',
              last: '40',
            }),
          ).label
        }
      </>,
    );

    expect(html).toContain('tool-display.tsx');
    expect(html).toContain('last 40 lines');
  });

  it('capitalizes the first letter of Claude Bash descriptions', () => {
    const info = getToolDisplayInfo(
      'Bash',
      JSON.stringify({ command: 'npm test', description: 'run the tests' }),
    );

    const label = renderToString(<>{info.label}</>);
    expect(label).toContain('Run the tests');
    expect(label).not.toContain('run the tests');
  });

  it('renders the Windows PowerShell tool exactly like Bash', () => {
    const input = JSON.stringify({
      command: 'npm test',
      description: 'run the tests',
    });
    const bash = getToolDisplayInfo('Bash', input);
    const powershell = getToolDisplayInfo('PowerShell', input);

    expect(renderToString(powershell.icon)).toBe(renderToString(bash.icon));
    expect(renderToString(<>{powershell.label}</>)).toBe(
      renderToString(<>{bash.label}</>),
    );
  });

  it('falls back to the PowerShell heading when no description is given', () => {
    const info = getToolDisplayInfo(
      'PowerShell',
      JSON.stringify({ command: 'Get-ChildItem' }),
    );

    const label = renderToString(<>{info.label}</>);
    expect(label).toContain('PowerShell');
    expect(label).toContain('Get-ChildItem');
  });

  it('maps PowerShell to the bash family', () => {
    expect(getToolFamilyFromName('PowerShell')).toBe('bash');
  });

  it('maps SendMessage to the agent family', () => {
    expect(getToolFamilyFromName('SendMessage')).toBe('agent');
  });

  it('maps ManageDelegate names to the app family', () => {
    expect(getToolFamilyFromName('mcp__canopy__ManageDelegate')).toBe('canopy');
    expect(getToolFamilyFromName('canopy_manage_delegate')).toBe('canopy');
    expect(
      renderToString(
        <>
          {
            getToolDisplayInfo(
              'mcp__canopy__ManageDelegate',
              '{}',
              TRUSTED_MCP_SCOPE,
            ).label
          }
        </>,
      ),
    ).toBe('Manage delegate');
  });

  it('renders SendMessage as "Agent message" with the agent icon', () => {
    const info = getToolDisplayInfo(
      'SendMessage',
      '{"to":"ac70abe6769a1e1ea","summary":"Re-review Windows shell fix","message":"body"}',
    );
    expect(renderToString(info.icon)).toBe(renderToString(<AgentIcon />));
    const label = renderToString(<>{info.label}</>);
    expect(label).toContain('Agent message');
    expect(label).toContain('Re-review Windows shell fix');
    // Without a host-resolved recipient the raw id is shown as a fallback.
    expect(label).toContain('ac70abe6769a1e1ea');
  });

  it('prefers a host-resolved recipient over the raw SendMessage id', () => {
    const resolved = getSendMessageDisplayInfo(
      '{"to":"ac70abe6769a1e1ea","summary":"Re-review Windows shell fix","message":"body"}',
      'Fix Task 18',
    );
    const label = renderToString(<>{resolved.label}</>);
    expect(label).toContain('Agent message');
    expect(label).toContain('Fix Task 18');
    expect(label).toContain('Re-review Windows shell fix');
    expect(label).not.toContain('ac70abe6769a1e1ea');
  });
});

describe('independent agent tools', () => {
  it.each([
    ['canopy_start_forked_agent', 'Start forked agent'],
    ['mcp__canopy__StartBranchedAgent', 'Start branched agent'],
  ])(
    'renders %s as an app action with the follow-up prompt',
    (toolName, label) => {
      const display = getToolDisplayInfo(
        toolName,
        JSON.stringify({
          followUpInstruction: 'Investigate the follow-up task',
        }),
        TRUSTED_MCP_SCOPE,
      );
      const html = renderToString(<>{display.label}</>);
      expect(html).toContain(label);
      expect(html).toContain('Investigate the follow-up task');
      expect(getToolFamilyFromName(toolName, TRUSTED_MCP_SCOPE)).toBe('canopy');
    },
  );
});

// The spawn is agent work; every other delegation tool is app plumbing and
// counts with the app tools, as the Portal family and turn summary do.
it.each([
  ['DelegateTask', 'spawn_delegate', 'Delegate task', 'agent'],
  ['WatchDelegates', 'watch_delegates', 'Watch delegates', 'canopy'],
  ['GetDelegateOutput', 'get_delegate_output', 'Get delegate output', 'canopy'],
  ['InspectDelegate', 'inspect_delegate', 'Inspect delegation', 'canopy'],
  ['ListDelegates', 'list_delegates', 'List delegations', 'canopy'],
  ['StopDelegate', 'stop_delegate', 'Stop delegation', 'canopy'],
  [
    'ManageDelegateWorktree',
    'manage_delegate_worktree',
    'Manage delegate worktree',
    'canopy',
  ],
  ['MessageDelegate', 'message_delegate', 'Message delegate', 'canopy'],
  ['RequestSteering', 'request_steering', 'Request steering', 'canopy'],
])(
  'maps managed %s controls in tool rows and summaries',
  (claude, codex, label, family) => {
    for (const name of [claude, `mcp__canopy__${claude}`, `canopy_${codex}`]) {
      expect(
        renderToString(
          <>{getToolDisplayInfo(name, '{}', TRUSTED_MCP_SCOPE).label}</>,
        ),
      ).toContain(label);
      expect(getToolFamilyFromName(name, TRUSTED_MCP_SCOPE)).toBe(family);
    }
  },
);

it.each(['', 'update: src/index.ts', 'add: src/new.ts', 'delete: src/old.ts'])(
  'renders retained apply_patch activity using the file-edit display: %s',
  (input) => {
    const patch = getToolDisplayInfo('apply_patch', input);
    const edit = getToolDisplayInfo('file_change', input);
    expect(getToolFamilyFromName('apply_patch')).toBe('edit');
    expect(
      renderToString(
        <>
          {patch.label}
          {patch.icon}
        </>,
      ),
    ).toBe(
      renderToString(
        <>
          {edit.label}
          {edit.icon}
        </>,
      ),
    );
  },
);

it.each([
  ['Bash', '/bin/zsh -c "printf hello && pwd"', 'printf hello &amp;&amp; pwd'],
  [
    'Bash',
    String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Get-ChildItem -Force"`,
    'Get-ChildItem -Force',
  ],
  [
    'PowerShell',
    String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content README.md'`,
    'Get-Content README.md',
  ],
])(
  'unwraps %s commands in delegated tool labels',
  (tool, command, expected) => {
    const label = renderToString(
      <>{getToolDisplayInfo(tool, JSON.stringify({ command })).label}</>,
    );
    expect(label).toContain(expected);
    expect(label).not.toMatch(/zsh|pwsh\.exe|powershell\.exe/);
  },
);

/**
 * CAN-3019: Canopy denies `ExitPlanMode` on purpose so the plan routes into its
 * own review UI. Resolving both plan-mode names to the `plan` family is what
 * stops the denial rendering as a nondescript failed tool row.
 */
describe('plan-mode tool family', () => {
  it('maps both plan-mode tool names to the plan family', () => {
    expect(getToolFamilyFromName('ExitPlanMode')).toBe('plan');
    expect(getToolFamilyFromName('EnterPlanMode')).toBe('plan');
  });
});

describe('cloud tool display aliases', () => {
  it.each([
    ['read', 'read', 'Read', { filePath: '/repo/src/app.ts' }, 'app.ts'],
    ['read', 'read', 'Read', { file_path: '/repo/src/app.ts' }, 'app.ts'],
    ['read_file', 'read', 'Read', { file_path: '/repo/src/app.ts' }, 'app.ts'],
    ['write', 'write', 'Write', { filePath: '/repo/src/app.ts' }, 'app.ts'],
    [
      'write_file',
      'write',
      'Write',
      { file_path: '/repo/src/app.ts' },
      'app.ts',
    ],
    ['edit', 'edit', 'Edit', { filePath: '/repo/src/app.ts' }, 'app.ts'],
    ['replace', 'edit', 'Edit', { file_path: '/repo/src/app.ts' }, 'app.ts'],
    ['grep', 'grep', 'Grep', { pattern: 'needle', path: 'src' }, 'needle'],
    [
      'grep_search',
      'grep',
      'Grep',
      { pattern: 'needle', dir_path: 'src' },
      'src',
    ],
    ['glob', 'glob', 'Glob', { pattern: '*.ts' }, '*.ts'],
    ['bash', 'bash', 'Bash', { command: 'npm test' }, 'npm test'],
    ['exec_command', 'bash', 'Bash', { cmd: 'npm test' }, 'npm test'],
    ['run_shell_command', 'bash', 'Bash', { command: 'npm test' }, 'npm test'],
    [
      'webSearch',
      'web',
      'WebSearch',
      { query: 'cloud agents' },
      'cloud agents',
    ],
    [
      'web_search',
      'web',
      'WebSearch',
      { query: 'cloud agents' },
      'cloud agents',
    ],
    [
      'google_web_search',
      'web',
      'WebSearch',
      { query: 'cloud agents' },
      'cloud agents',
    ],
    [
      'web_fetch',
      'web',
      'WebFetch',
      { url: 'https://example.com' },
      'example.com',
    ],
    ['todo_write', 'todo', 'TodoWrite', { todos: [] }, 'Update todos'],
    ['write_todos', 'todo', 'TodoWrite', { todos: [] }, 'Update todos'],
  ] as const)(
    'renders %s with its existing family and rich label',
    (name, family, canonical, args, detail) => {
      const actual = getToolDisplayInfo(name, JSON.stringify(args));
      const expected = getToolDisplayInfo(canonical, '{}');
      expect(getToolFamilyFromName(name)).toBe(family);
      expect(actual.icon.type).toBe(expected.icon.type);
      const label = renderToString(<>{actual.label}</>);
      expect(label).toContain(detail);
      expect(label).not.toContain('&quot;query&quot;');
    },
  );

  it.each([
    ['list_directory', { path: '/repo/src' }, 'glob', 'src'],
    ['read_many_files', { paths: ['src/*.ts'] }, 'read', 'src/*.ts'],
  ] as const)('renders %s with file context', (name, args, family, detail) => {
    expect(getToolFamilyFromName(name)).toBe(family);
    expect(
      renderToString(
        <>{getToolDisplayInfo(name, JSON.stringify(args)).label}</>,
      ),
    ).toContain(detail);
  });

  it('preserves raw Codex web-search queries', () => {
    expect(
      renderToString(
        <>{getToolDisplayInfo('web_search', 'cloud agents').label}</>,
      ),
    ).toContain('cloud agents');
  });

  it.each(['unknown_tool', 'mcp__files__read'])(
    'does not interpret unrelated tools as builtins: %s',
    (name) => {
      expect(getToolFamilyFromName(name)).toBe('unknown');
      expect(
        getToolDisplayInfo(name, '{"filePath":"secret.txt"}').icon.type,
      ).not.toBe(getToolDisplayInfo('Read', '{}').icon.type);
    },
  );
});

describe('cloud shell read display', () => {
  it.each([
    ['bash', { command: 'cat package.json' }, 'Read', 'package.json'],
    ['bash', { command: "sed -n '1,20p' src/app.ts" }, 'ReadLines', '1 to 20'],
    [
      'bash',
      { command: 'cat /repo/skills/testing/SKILL.md' },
      'Skill',
      'testing',
    ],
    ['exec_command', { cmd: 'cat package.json' }, 'Read', 'package.json'],
    [
      'run_shell_command',
      { command: 'cat package.json' },
      'Read',
      'package.json',
    ],
  ] as const)(
    'renders %s read commands using the existing desktop display',
    (name, args, canonical, detail) => {
      const display = getToolDisplayInfo(name, JSON.stringify(args));
      expect(display.icon.type).toBe(
        getToolDisplayInfo(canonical, '{}').icon.type,
      );
      expect(renderToString(<>{display.label}</>)).toContain(detail);
    },
  );

  it.each([
    'npm test',
    'cat package.json && npm test',
    'cat package.json;pwd',
    'cat package.json>copy.json',
    'cat /tmp/file;touch/SKILL.md',
    'cat foo>skills/SKILL.md',
    'cat /tmp/file|touch/skills/testing/SKILL.md',
    'cat $(touch /tmp/example)',
    'Get-Content foo -Encoding utf8;pwd',
    'cat -n',
    'cat --help',
  ])('keeps real or compound shell operations as shell: %s', (command) => {
    const display = getToolDisplayInfo('bash', JSON.stringify({ command }));
    expect(display.icon.type).toBe(getToolDisplayInfo('Bash', '{}').icon.type);
    expect(renderToString(<>{display.label}</>)).toContain('Bash');
  });
});

describe('saved and raw shell tool displays', () => {
  it.each([
    ['command', 'cat package.json'],
    ['bash', 'cat package.json'],
    ['exec_command', 'cat package.json'],
    ['run_shell_command', 'cat package.json'],
  ])('recognizes a raw %s read', (name, input) => {
    expect(getToolFamilyFromName(name, undefined, input)).toBe('read');
    expect(getToolDisplayInfo(name, input).icon.type).toBe(
      getToolDisplayInfo('Read', '{}').icon.type,
    );
    expect(
      renderToString(<>{getToolDisplayInfo(name, input).label}</>),
    ).toContain('package.json');
  });

  it('keeps raw shell operations visible', () => {
    expect(
      renderToString(<>{getToolDisplayInfo('bash', 'npm test').label}</>),
    ).toContain('npm test');
  });

  it.each([
    'cat *.ts',
    "sed -n '1,20p' src/*.ts",
    'cat src/?.ts',
    'cat src/[ab].ts',
    'cat src/{a,b}.ts',
  ])('leaves expanded paths as shell calls: %s', (command) => {
    const input = JSON.stringify({ command });
    expect(getToolFamilyFromName('bash', undefined, input)).toBe('bash');
    expect(getToolDisplayInfo('bash', input).icon.type).toBe(
      getToolDisplayInfo('Bash', '{}').icon.type,
    );
  });
});
