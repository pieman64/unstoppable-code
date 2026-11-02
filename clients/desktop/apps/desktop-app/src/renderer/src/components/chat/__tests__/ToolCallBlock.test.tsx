import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  type AppAdvisorLedgerToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { CodeBracketsIcon, GraphIcon, McpIcon } from '@canopy/ui-shared/icons';
import { ChatLookProvider } from '@canopy/ui-shared/components';
import { ToolCallBlock } from '../ToolCallBlock';
import { TranscriptSearchRevealContext } from '../transcript-search-reveal';
import type { ChatVisualOwner } from '@canopy/ui-app';
import type * as UiAppModule from '@canopy/ui-app';

jest.mock('@canopy/ui-app', () => ({
  ...jest.requireActual<typeof UiAppModule>('@canopy/ui-app'),
  ChatVisualSourceButton: ({
    owner,
  }: {
    owner: ChatVisualOwner;
  }): JSX.Element => (
    <button data-testid="chat-visual-source-button" type="button">
      {owner.reference.title}
    </button>
  ),
}));

/** Canonical proxied Codex MCP tool name used by the MCP-card tests. */
const PROXIED_MCP_TOOL_NAME =
  'mcp__appproxy-internal-hub-prod--1b377c49de9ad913__query-gcp-logs';

/** Visible text of the rendered markup with every tag (and therefore every
 * attribute, including the raw `data-tool-name`) stripped away. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function malformedPersistedAuthFailureResult(): {
  output: string;
  isError: boolean;
} {
  const result = {
    output: 'MCP error -32001: MCP server authorization required',
    isError: true,
  };
  Object.assign(result, { authFailure: { nonsense: true } });
  return result;
}

describe('ToolCallBlock', () => {
  it.each(['WebFetch', 'SendMessage', 'Bash'])(
    'shows a %s denial as blocked with sanitized text in its expanded panel',
    (toolName) => {
      const html = renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <TranscriptSearchRevealContext.Provider value={true}>
            <ToolCallBlock
              toolName={toolName}
              input='{"prompt":"p","message":"m","command":"git push --force"}'
              result={{
                output: `PreToolUse:${toolName} hook error: The user denied this tool call: Not on this branch.`,
                isError: true,
              }}
            />
          </TranscriptSearchRevealContext.Provider>
        </ChatLookProvider>,
      );
      expect(html).toContain('data-tool-status="blocked"');
      expect(visibleText(html)).toContain('Denied by you');
      expect(visibleText(html)).toContain(
        'The user denied this tool call: Not on this branch.',
      );
      expect(html).not.toContain('PreToolUse');
      expect(html).not.toContain('fg-destructive');
    },
  );

  it('tints a large error output in the classic look only', () => {
    const outputClass = (look: 'classic' | 'clean'): string | undefined =>
      /<pre class="([^"]*)">boom<\/pre>/.exec(
        renderToStaticMarkup(
          <ChatLookProvider value={look}>
            <TranscriptSearchRevealContext.Provider value={true}>
              <ToolCallBlock
                toolName="Bash"
                input='{"command":"ls"}'
                result={{
                  output: 'boom',
                  isError: true,
                  fullOutputRef: {
                    version: 1,
                    artifactId: 'tool-output/boom.txt',
                    byteLength: 4,
                    sha256: 'test',
                    encoding: 'utf-8',
                    mediaType: 'text/plain',
                  },
                }}
              />
            </TranscriptSearchRevealContext.Provider>
          </ChatLookProvider>,
        ),
      )?.[1];
    expect(outputClass('classic')).toContain('fg-destructive/80');
    expect(outputClass('clean')).toBeDefined();
    expect(outputClass('clean')).not.toContain('fg-destructive');
  });

  it('uses the owning visual reference title and offers source without raw HTML', () => {
    const visualCall = (
      <ToolCallBlock
        toolName="mcp__canopy__ShowVisual"
        input='{"html":"<script>RAW_HTML</script>","title":"Stale title"}'
        result={{
          output: 'Shown',
          isError: false,
          messageId: 'result-1',
          toolUseId: 'tool-1',
          visualRef: {
            version: 1,
            visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            byteLength: 8,
            mediaType: 'text/html',
            title: 'Verified chart',
            maxHeight: 320,
          },
        }}
      />
    );
    const collapsed = renderToStaticMarkup(visualCall);
    expect(visibleText(collapsed)).toContain('Verified chart');
    expect(visibleText(collapsed)).not.toContain('Stale title');
    expect(collapsed).not.toContain('chat-visual-source-button');
    // Expanded, the row offers the source in place of the raw input.
    const expanded = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <TranscriptSearchRevealContext.Provider value={true}>
          {visualCall}
        </TranscriptSearchRevealContext.Provider>
      </ChatLookProvider>,
    );
    expect(expanded).toContain('chat-visual-source-button');
    expect(visibleText(expanded)).not.toContain('Stale title');
    expect(expanded).not.toContain('RAW_HTML');
  });
  it('uses the active brand logo for worktree-scoped tool calls', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="canopy_dispatch_action"
          input='{"action":{"type":"pipeline.run"}}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(html).toContain('data-tool-family="canopy"');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="100%"');
  });

  it('renders ImmediateTurnRestart as Refresh and resume with the active brand logo', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`${BRAND.tools.namespace}_immediate_turn_restart`}
          input="{}"
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];

    expect(html).toContain('data-tool-family="canopy"');
    expect(visibleText(html)).toContain('Refresh and resume');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
  });

  it('renders worktree hook pause actions as Canopy tool calls', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="canopy_dispatch_action"
          input='{"action":{"type":"hook.pause","hookKey":"project:pr:checks:fail"}}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(html).toContain('data-tool-family="canopy"');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).toContain('Pause hook');
    expect(html).toContain('project:pr:checks:fail');
  });

  it('renders worktree base-branch actions with specific chat-row labels', () => {
    const setBaseHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="app_advisor_dispatch_action"
          input='{"action":{"type":"worktree.set_base_branch","projectId":"project-1","worktreeId":"worktree-1","baseBranch":"release/next"}}'
        />
      </ChatLookProvider>,
    );
    const createHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="app_advisor_dispatch_action"
          input='{"action":{"type":"worktree.create","workspaceId":"project-1","baseBranch":"develop"}}'
        />
      </ChatLookProvider>,
    );
    const createFromWorktreeHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="app_advisor_dispatch_action"
          input='{"action":{"type":"worktree.create","workspaceId":"project-1","baseWorktreeId":"worktree-1"}}'
        />
      </ChatLookProvider>,
    );
    const createFromHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="app_advisor_dispatch_action"
          input='{"action":{"type":"worktree.create_from","workspaceId":"project-1","source":"branch","reference":"feature/source","baseBranch":"develop"}}'
        />
      </ChatLookProvider>,
    );

    expect(setBaseHtml).toContain('data-tool-family="app-advisor"');
    expect(visibleText(setBaseHtml)).toContain('Set base branch release/next');
    expect(visibleText(setBaseHtml)).not.toContain('Dispatch action');
    expect(visibleText(createHtml)).toContain(
      'Create worktree from branch develop',
    );
    expect(visibleText(createFromWorktreeHtml)).toContain(
      'Create worktree from worktree worktree-1',
    );
    expect(visibleText(createFromHtml)).toContain(
      'Create worktree from feature/source',
    );
    expect(visibleText(createFromHtml)).toContain('base develop');
  });

  it('renders the worktree SetBaseBranch tool in the branded app family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`${BRAND.tools.namespace}_set_base_branch`}
          input='{"baseBranch":"release/next","repoId":"repo-a"}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];

    expect(html).toContain('data-tool-family="canopy"');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(visibleText(html)).toContain('Set base branch release/next');
    expect(visibleText(html)).toContain('repo-a');
  });

  it('uses the active brand logo for worktree read pipeline YAML calls', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__ReadPipelineYaml`}
          input='{"pipelineId":"build.yml","pattern":"steps"}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(html).toContain('data-tool-family="canopy"');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).toContain('Read workflow YAML');
    expect(html).toContain('build.yml');
  });

  it('renders SetAutoArchive calls as branded Canopy tool calls', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__SetAutoArchive`}
          input='{"enabled":true}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(html).toContain('data-tool-family="canopy"');
    expect(logoPath).toBeTruthy();
    expect(html).toContain(logoPath);
    expect(html).toContain('Enable chat auto-archive');
  });

  it('renders save, search, and read memory calls as branded Canopy tools', () => {
    const saveHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__SaveMemory`}
          input='{"text":"Uses Vim","scope":"user"}'
        />
      </ChatLookProvider>,
    );
    const searchHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`${BRAND.tools.namespace}_search_memory`}
          input='{"query":"package manager"}'
        />
      </ChatLookProvider>,
    );
    const readHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__ReadMemory`}
          input='{"scope":"workspace","file":"topics/package-manager.md"}'
        />
      </ChatLookProvider>,
    );

    expect(saveHtml).toContain('data-tool-family="canopy"');
    expect(saveHtml).toContain(
      'data-testid="chat-tool-call-save-memory-label"',
    );
    expect(saveHtml).toContain('Save');
    expect(saveHtml).toContain('user');
    expect(searchHtml).toContain('data-tool-family="canopy"');
    expect(searchHtml).toContain(
      'data-testid="chat-tool-call-search-memory-label"',
    );
    expect(searchHtml).toContain('Search memory');
    expect(searchHtml).toContain('package manager');
    expect(readHtml).toContain('data-tool-family="canopy"');
    expect(readHtml).toContain(
      'data-testid="chat-tool-call-read-memory-label"',
    );
    expect(readHtml).toContain('Read workspace memory');
    expect(readHtml).toContain('topics/package-manager.md');
  });

  it('renders add, search, and update ledger entry calls as branded Canopy tools', () => {
    const addHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__AddFeedEntry`}
          input='{"type":"TASK","title":"Fix the login redirect loop","content":"Investigate"}'
        />
      </ChatLookProvider>,
    );
    const searchHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`${BRAND.tools.namespace}_search_feed_entries`}
          input='{"query":"login redirect"}'
        />
      </ChatLookProvider>,
    );
    const updateHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__UpdateFeedEntry`}
          input='{"entryId":"11111111-1111-1111-1111-111111111111","expectedRevision":1,"status":"IN_PROGRESS","owner":"self"}'
        />
      </ChatLookProvider>,
    );

    expect(addHtml).toContain('data-tool-family="canopy"');
    expect(addHtml).toContain(
      'data-testid="chat-tool-call-add-ledger-entry-label"',
    );
    expect(addHtml).toContain('Add Feed entry');
    expect(addHtml).toContain('Fix the login redirect loop');
    expect(searchHtml).toContain('data-tool-family="canopy"');
    expect(searchHtml).toContain(
      'data-testid="chat-tool-call-search-ledger-entries-label"',
    );
    expect(searchHtml).toContain('Search Feed');
    expect(searchHtml).toContain('login redirect');
    expect(updateHtml).toContain('data-tool-family="canopy"');
    expect(updateHtml).toContain(
      'data-testid="chat-tool-call-update-ledger-entry-label"',
    );
    expect(updateHtml).toContain('Update Feed entry');
    expect(updateHtml).toContain('IN_PROGRESS');
    expect(updateHtml).toContain('owner self');
  });

  it('renders Cursor and App Advisor ledger calls exactly like the native ledger calls', () => {
    // The raw names these surfaces persist: the Cursor CLI title of the call
    // on the app's MCP server, and App Advisor's own Claude and Codex names.
    // Only the provider-accurate `data-tool-name` may differ.
    const withoutToolName = (html: string): string =>
      html.replace(/ data-tool-name="[^"]*"/, '');
    const cases: ReadonlyArray<{
      key: AppAdvisorLedgerToolKey;
      input: string;
      testId: string;
    }> = [
      {
        key: 'add_ledger_entry',
        input:
          '{"type":"TASK","title":"Fix the checkout retry loop","content":"Investigate"}',
        testId: 'chat-tool-call-add-ledger-entry-label',
      },
      {
        key: 'search_ledger_entries',
        input: '{"query":"checkout retry","owner":"self"}',
        testId: 'chat-tool-call-search-ledger-entries-label',
      },
      {
        key: 'update_ledger_entry',
        input:
          '{"entryId":"11111111-1111-1111-1111-111111111111","expectedRevision":1,"status":"IN_PROGRESS","owner":"self"}',
        testId: 'chat-tool-call-update-ledger-entry-label',
      },
    ];
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(logoPath).toBeTruthy();

    for (const { key, input, testId } of cases) {
      const nativeHtml = renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <ToolCallBlock
            toolName={CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName}
            input={input}
          />
        </ChatLookProvider>,
      );
      expect(nativeHtml).toContain('data-tool-family="canopy"');
      expect(nativeHtml).toContain(`data-testid="${testId}"`);
      expect(nativeHtml).toContain(logoPath);
      for (const toolName of [
        CANOPY_INJECTED_TOOL_REGISTRY[key].cursorToolName,
        APP_ADVISOR_TOOL_REGISTRY[key].claudeToolName,
        APP_ADVISOR_TOOL_REGISTRY[key].codexToolName,
      ]) {
        const html = renderToStaticMarkup(
          <ChatLookProvider value="classic">
            <ToolCallBlock toolName={toolName} input={input} />
          </ChatLookProvider>,
        );
        expect(html).toContain(`data-tool-name="${toolName}"`);
        expect(withoutToolName(html)).toBe(withoutToolName(nativeHtml));
      }
    }
  });

  it('renders code-graph tool calls in the graph family with the GraphIcon, not the brand logo', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__QueryCodeGraph`}
          input='{"mode":"callers","target":"apps/desktop-app/src/main/lib/paths.ts::getWorktreeHomeDir"}'
        />
      </ChatLookProvider>,
    );
    const logoPath = BRAND.assets.logoSvg.match(/<path[^>]+>/)?.[0];
    expect(html).toContain('data-tool-family="graph"');
    expect(html).toContain('Query Code Graph');
    expect(html).toContain('paths.ts::getWorktreeHomeDir');
    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <GraphIcon />
        </ChatLookProvider>,
      ),
    );
    expect(logoPath).toBeTruthy();
    expect(html).not.toContain(logoPath);
  });

  it('keeps branded App Advisor action calls in the app-advisor family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}_app_advisor__SearchActions`}
          input='{"query":"pipeline"}'
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="app-advisor"');
    expect(html).toContain('Search actions');
  });

  it('keeps branded App Advisor read pipeline YAML calls in the app-advisor family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}_app_advisor__ReadPipelineYaml`}
          input='{"pipelineId":"build.yml","startLine":2,"endLine":5}'
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="app-advisor"');
    expect(html).toContain('Read workflow YAML');
    expect(html).toContain('build.yml');
    expect(html).toContain('lines 2-5');
  });

  it('renders WatchGitHubItems calls in the watcher family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}_app_advisor__WatchGitHubItems`}
          input='{"items":[{"kind":"workflow_run","repository":"acme/api","runId":"1"}],"notifyOn":{"conclusions":["failure"]}}'
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="watcher"');
    expect(html).toContain('Watch GitHub workflow runs');
    expect(html).toContain('run');
  });

  it('renders App Advisor hook resume actions in the App Advisor family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="app_advisor_dispatch_action"
          input='{"action":{"type":"hook.resume","all":true,"projectId":"project-1","worktreeId":"worktree-1"}}'
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="app-advisor"');
    expect(html).toContain('Resume all hooks');
    expect(html).not.toContain('data-tool-family="canopy"');
  });

  it('renders SendMessage as an "Agent message" row in the agent family', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="SendMessage"
          input='{"to":"ac70abe6769a1e1ea","summary":"Re-review Windows shell fix","message":"A fix pass addressed your critical finding."}'
          result={{ output: 'delivered', isError: false }}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="agent"');
    expect(html).toContain('Agent message');
    expect(html).toContain('Re-review Windows shell fix');
    // The collapsed label surfaces the recipient id, not the raw JSON input.
    expect(html).toContain('ac70abe6769a1e1ea');
    expect(html).not.toContain('"to":"ac70abe6769a1e1ea"');
  });

  it('shows the resolved recipient name for SendMessage when provided', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="SendMessage"
          input='{"to":"ac70abe6769a1e1ea","summary":"Re-review","message":"body"}'
          resolvedRecipient="Fix Task 18"
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('Agent message');
    expect(html).toContain('Fix Task 18');
    expect(html).not.toContain('ac70abe6769a1e1ea');
  });

  it('gives RespondToComment the plan icon in Plan Explore chats and the code icon in Code Review chats', () => {
    const planHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="RespondToComment"
          input='{"threadId":"t-1","body":"looks good"}'
        />
      </ChatLookProvider>,
    );
    expect(planHtml).toContain('data-tool-family="plan"');
    expect(planHtml).not.toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <CodeBracketsIcon />
        </ChatLookProvider>,
      ),
    );

    const reviewHtml = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="RespondToComment"
          input='{"threadId":"t-1","body":"looks good"}'
          isCodeReviewChat
        />
      </ChatLookProvider>,
    );
    expect(reviewHtml).toContain('data-tool-family="plan"');
    expect(reviewHtml).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <CodeBracketsIcon />
        </ChatLookProvider>,
      ),
    );
  });

  it('gives GetReviewComments the code icon by name alone, regardless of scope', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock toolName="GetReviewComments" input="{}" />
      </ChatLookProvider>,
    );
    expect(html).toContain('data-tool-family="plan"');
    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <CodeBracketsIcon />
        </ChatLookProvider>,
      ),
    );
  });

  it('renders proxied Codex MCP calls with the MCP icon and a friendly label', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId=\\"fixture-operation\\""}'
        />
      </ChatLookProvider>,
    );
    expect(html).toContain(
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <McpIcon />
        </ChatLookProvider>,
      ),
    );
    const text = visibleText(html);
    expect(text).toContain('Internal Hub Prod');
    expect(text).toContain('Query Gcp Logs');
    // Opaque internal proxy identifiers never reach the visible label.
    expect(text).not.toContain('appproxy');
    expect(text).not.toContain('opaque');
    expect(text).not.toContain('mcp__');
  });

  it('renders Computer Use reset with its cursor icon and keeps details collapsible', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="mcp__cua_repl__js_reset"
          input='{"reason":"recover stale bindings"}'
          result={{ output: 'Reset complete', isError: false }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-tool-family="computer-use"');
    expect(html).toContain('Computer use');
    expect(html).toContain('Reset');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('recover stale bindings');
    expect(html).not.toContain('Reset complete');
  });

  it('keeps the raw canonical MCP name and status in automation metadata', () => {
    const pending = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock toolName={PROXIED_MCP_TOOL_NAME} input="{}" />
      </ChatLookProvider>,
    );
    expect(pending).toContain('data-testid="chat-tool-call"');
    expect(pending).toContain(`data-tool-name="${PROXIED_MCP_TOOL_NAME}"`);
    expect(pending).toContain('data-tool-status="pending"');

    const success = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input="{}"
          result={{ output: '3 log entries', isError: false }}
        />
      </ChatLookProvider>,
    );
    expect(success).toContain('data-tool-status="success"');

    const failure = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input="{}"
          result={{ output: 'HTTP 504 gateway timeout', isError: true }}
        />
      </ChatLookProvider>,
    );
    expect(failure).toContain('data-tool-status="error"');
  });

  it('keeps MCP call input and output collapsed until activated', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{ output: '3 log entries', isError: false }}
        />
      </ChatLookProvider>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('operationId');
    expect(html).not.toContain('3 log entries');
    expect(html).not.toContain('>Result<');
  });

  it('offers an MCP connection CTA when an MCP tool fails for missing authorization', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="chat-connection-cta-mcp"');
    // The legacy fallback knows a display name but no serverId/configId, so
    // it routes to the MCP settings surface exactly as the button it replaces
    // did — and still names the server (CAN-1814 PR 2).
    expect(html).toContain('Connect Internal Hub Prod');
  });

  it('renders one checklist row per dependency from a persisted authFailures array', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'expired',
              recovery: {
                kind: 'mcp_oauth',
                serverId: 'srv-1',
                configId: 'cfg-1',
              },
            },
            authFailures: [
              {
                dependencyClass: 'mcp',
                dependencyId: 'srv-1:cfg-1',
                displayName: 'Prod MCP server',
                failureClass: 'expired',
                recovery: {
                  kind: 'mcp_oauth',
                  serverId: 'srv-1',
                  configId: 'cfg-1',
                },
              },
              {
                dependencyClass: 'mcp',
                dependencyId: 'srv-2:cfg-1',
                displayName: 'Docs MCP server',
                failureClass: 'expired',
                recovery: {
                  kind: 'mcp_oauth',
                  serverId: 'srv-2',
                  configId: 'cfg-1',
                },
              },
            ],
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-dependency-id="srv-1:cfg-1"');
    expect(html).toContain('data-dependency-id="srv-2:cfg-1"');
    expect(html).toContain('Reconnect Prod MCP server');
    expect(html).toContain('Reconnect Docs MCP server');
    expect(html).toContain(
      '2 connections need attention before this can continue.',
    );
  });

  it('still reads a block that carries only the pre-checklist singular field', () => {
    // Transcripts persisted before `authFailures` existed carry only
    // `authFailure`, and they must keep rendering their card (CAN-1814 PR 2).
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'expired',
              recovery: {
                kind: 'mcp_oauth',
                serverId: 'srv-1',
                configId: 'cfg-1',
              },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('Reconnect Prod MCP server');
    expect(html).not.toContain('auth-recovery-checklist-header');
  });

  it('does not offer a connection CTA for unrelated MCP failures', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input="{}"
          result={{ output: 'HTTP 504 gateway timeout', isError: true }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('offers an MCP connection CTA from structured authFailure even when the tool succeeded (isError false)', () => {
    // Structured data (CAN-1814) must bypass the legacy isError gate
    // entirely when present — see ToolCallBlock.tsx's
    // `structuredAuthFailure` computation.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: '3 log entries',
            isError: false,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'expired',
              recovery: {
                kind: 'mcp_oauth',
                serverId: 'srv-1',
                configId: 'cfg-1',
              },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="chat-connection-cta-mcp"');
    expect(html).toContain('Reconnect Prod MCP server');
  });

  it('offers an MCP connection CTA from structured authFailure even when the tool name is not MCP-namespaced', () => {
    // Structured data must also bypass the legacy parseMcpToolName gate —
    // main only attaches authFailure to genuine MCP tool_results, so the
    // renderer trusts it without re-deriving MCP-ness from the tool name.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="Bash"
          input='{"command":"cat app.log"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'expired',
              recovery: {
                kind: 'mcp_oauth',
                serverId: 'srv-1',
                configId: 'cfg-1',
              },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="chat-connection-cta-mcp"');
    expect(html).toContain('Reconnect Prod MCP server');
  });

  it('does not offer an MCP connection CTA when structured authFailure is not an MCP dependency', () => {
    // A non-mcp dependencyClass (e.g. a provider auth failure that
    // happens to land on a tool_result-shaped result) must not show the
    // MCP-specific CTA, and structured data being present must not fall
    // back to the legacy regex either.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'provider',
              dependencyId: 'claude',
              displayName: 'Claude',
              failureClass: 'unauthenticated',
              recovery: { kind: 'provider_terminal', provider: 'claude' },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="chat-connection-cta-mcp"');
  });

  // CAN-1814 PR 4. The GitHub blocker lands on a Canopy-injected tool's own
  // errored result, whose name is NOT an MCP server tool. The structured branch
  // is name-agnostic by design, so the card renders and names GitHub.
  it('renders the GitHub reconnect CTA on an injected tool result', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={`mcp__${BRAND.tools.namespace}__WatchGitHubItems`}
          input='{"items":[123],"notifyOn":{"jobs":{"conclusions":"any"}}}'
          result={{
            output:
              '{"ok":false,"code":"not_authenticated","message":"No GitHub token is available."}',
            isError: true,
            authFailure: {
              dependencyClass: 'integration',
              dependencyId: 'integration:github',
              displayName: 'GitHub',
              failureClass: 'unauthenticated',
              recovery: { kind: 'github_login' },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="auth-recovery-card"');
    expect(html).toContain('data-dependency-class="integration"');
    expect(html).toContain('data-testid="chat-connection-cta-github"');
    expect(visibleText(html)).toContain('needs to be reconnected.');
  });

  // The legacy regex fallback stays MCP-only: it has nothing but the tool name
  // and the output text to go on, so it may not guess GitHub from a Canopy
  // tool's error body.
  it('does not guess a GitHub failure from an injected tool error alone', () => {
    // Explicitly the BRANDED namespace `parseMcpToolName` accepts, not the
    // legacy `canopy` one it rejects, so this pins the exclusion itself rather
    // than passing for free under whichever brand the suite happens to run.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="mcp__unstoppable-code__WatchGitHubItems"
          input='{"items":[123],"notifyOn":{"jobs":{"conclusions":"any"}}}'
          result={{
            // Exactly the body `isMcpConnectionError` DOES match — a 401 next
            // to an `invalid_token` marker — so the exclusion is what suppresses
            // the card, not a heuristic miss.
            output:
              'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}',
            isError: true,
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="auth-recovery-card"');
  });

  it('does not offer an MCP connection CTA for an HTTP 403 insufficient_scope failure (CAN-1814)', () => {
    // classifyMcpAuthFailure maps a 403 to insufficient_scope with
    // `recovery: { kind: 'none' }` — the token authenticated and was refused
    // on scope. The proxy publishes 403s alongside 401s, so gating on
    // dependencyClass alone rendered "Connect MCP server" for a failure that
    // reconnecting cannot fix.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error: HTTP 403 Forbidden',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'insufficient_scope',
              recovery: { kind: 'none' },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('does not fall back to the legacy regex for a non-recoverable structured MCP failure', () => {
    // Structured data must win outright: an output the legacy regex WOULD
    // match must still not produce a CTA once main has said the failure has
    // no inline recovery.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'insufficient_scope',
              recovery: { kind: 'none' },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('does not offer a CTA for a persisted authFailure that breaks the recoverable-class invariant', () => {
    // Both write paths enforce `isValidAuthDependencyFailure`, but the
    // read-from-disk path does not: `chat-tabs-reader.ts`'s
    // `isPersistedChatBlock` validates only toolUseId/toolName/output/isError
    // and passes `authFailure` through unchecked. A persisted block pairing a
    // non-recoverable `failureClass` with an `mcp_oauth` recovery would
    // otherwise render "Connect MCP server" for a failure logging in cannot
    // fix (CAN-1814 review).
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={{
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
            authFailure: {
              dependencyClass: 'mcp',
              dependencyId: 'srv-1:cfg-1',
              displayName: 'Prod MCP server',
              failureClass: 'quota_exceeded',
              recovery: {
                kind: 'mcp_oauth',
                serverId: 'srv-1',
                configId: 'cfg-1',
              },
            },
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).not.toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('falls back to the text heuristic when the persisted authFailure is not even shape-valid', () => {
    // CAN-1814 follow-up. Two "invalid" cases mean opposite things:
    //
    //   - shape-valid but semantically invalid (quota_exceeded + mcp_oauth):
    //     main DID reach a verdict and it says non-recoverable. Suppress; the
    //     text heuristic must not overrule it. Covered by the test above.
    //   - not shape-valid at all: there is NO readable verdict to defer to.
    //     Suppressing here removed the user's only recovery path over a
    //     corrupt cache entry, while the tool output is independent evidence
    //     of a real auth failure. Fall back to the heuristic.
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName={PROXIED_MCP_TOOL_NAME}
          input='{"filter":"operationId"}'
          result={malformedPersistedAuthFailureResult()}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('does not throw, and falls back to the heuristic, for a truncated persisted authFailure missing recovery', () => {
    // The persisted-read path (chat-tabs-reader.ts's isPersistedChatBlock)
    // only checks toolUseId/toolName/output/isError and passes unknown
    // fields through untouched, so a corrupted or hand-edited
    // chats/{worktreeId}.json can carry an `authFailure` object with no
    // `recovery` field. `structuredAuthFailure.recovery.kind` must not throw
    // a TypeError for that shape — the repo's persistence rule is silent
    // fallback on missing/corrupt data, not a crash.
    //
    // It must also not SUPPRESS the CTA (changed in the CAN-1814 follow-up).
    // Missing `recovery` makes this shape-invalid, so there is no readable
    // verdict from main to defer to — and the output text is independent
    // evidence of a real auth failure. Suppressing here cost the user their
    // only recovery path over a corrupt cache entry. The semantically-invalid
    // case above (a readable but non-recoverable verdict) still suppresses.
    const render = (): string =>
      renderToStaticMarkup(
        <ChatLookProvider value="classic">
          <ToolCallBlock
            toolName={PROXIED_MCP_TOOL_NAME}
            input='{"filter":"operationId"}'
            result={{
              output: 'MCP error -32001: MCP server authorization required',
              isError: true,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- intentionally simulates unvalidated persisted JSON missing `recovery`
              authFailure: JSON.parse('{"dependencyClass":"mcp"}'),
            }}
          />
        </ChatLookProvider>,
      );

    expect(render).not.toThrow();
    expect(render()).toContain('data-testid="chat-connection-cta-mcp"');
  });

  it('renders Claude model-change rows with display names and a stable icon size', () => {
    const html = renderToStaticMarkup(
      <ChatLookProvider value="classic">
        <ToolCallBlock
          toolName="ClaudeModelChange"
          input='{"previous_model":"fable[1m]","detected_model":"opus[1m]","previous_model_display":"Fable 5 1M","detected_model_display":"Opus 4.8 1M","reported_model":"claude-opus-4-8"}'
          result={{
            output:
              'Previous model: fable[1m]\nDetected model: opus[1m]\nReported model: claude-opus-4-8',
            isError: false,
          }}
        />
      </ChatLookProvider>,
    );

    expect(html).toContain('data-tool-family="claude"');
    expect(html).toContain('Claude model changed from');
    expect(html).toContain('<strong>Fable 5 1M</strong>');
    expect(html).toContain('to');
    expect(html).toContain('<strong>Opus 4.8 1M</strong>');
    expect(html).not.toContain('claude-opus-4-8');
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
    // Claude cards keep their accessible chrome and now share the stable
    // automation hook with every other chat tool card.
    expect(html).toContain('data-testid="chat-tool-call"');
    expect(html).toContain('data-tool-status="success"');
    expect(html).toContain('aria-expanded="false"');
  });
});
