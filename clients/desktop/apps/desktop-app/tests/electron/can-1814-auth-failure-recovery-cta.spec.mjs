// CAN-1814: structured auth-failure data drives the MCP reconnect CTA.
//
// Task 6-8 (main process) taught the app to attach a structured
// `AuthDependencyFailure` to the `tool_result` block that explains an MCP
// auth failure. Task 9 (this change) makes `ToolCallBlock` prefer that
// structured data over the `isMcpConnectionError` text fallback, while keeping
// that fallback as a last resort: the structured producer only fires for HTTP
// MCP servers that completed OAuth through Canopy's proxy, so Codex, stdio
// servers, and static-header HTTP servers still depend on the 401 status line.
//
// The seeded `authFailure` on a persisted `tool_result` is the shape production
// actually writes: the `canopy_auth_failure` branch in
// `packages/agent-transcript/src/lib/transcript-parser.ts` attaches the field
// during reduction, and main persists the reducer's messages.
//
// Ten scenarios. The first seven are read-only persisted transcript variants
// seeded as independently selectable tabs in one app. The two live send paths
// and the Codex transcript case retain fresh launches because they exercise
// distinct providers or preflight credentials:
//   1. An errored MCP tool_result carrying a structured `authFailure` ->
//      the CTA renders, sourced entirely from the structured data.
//   2. An errored MCP tool_result whose output is a real 401 status line with
//      NO structured `authFailure` -> the CTA still renders. This covers the
//      providers and transports the structured producer cannot reach.
//   3. An errored MCP tool_result that merely mentions the number 401 in
//      non-auth prose -> no CTA renders.
//   4. An errored MCP tool_result carrying an `insufficient_scope` (HTTP 403)
//      `authFailure` whose recovery is `{ kind: 'none' }` -> the card renders
//      and explains the scope problem, but offers no connect CTA. Logging in
//      again cannot widen a scope, so a login prompt would be actively
//      misleading. Before `AuthRecoveryCard` (CAN-1814 PR 2) this case
//      rendered nothing at all.
//   5. An errored MCP tool_result whose persisted `authFailure` pairs a
//      non-recoverable `failureClass` with an `mcp_oauth` recovery -> no CTA
//      renders. Nothing validates `authFailure` when a chat file is read back
//      from disk, so the component must re-check the invariant itself.
//   6. An errored MCP tool_result carrying an `authFailures` ARRAY for two
//      distinct dependencies -> ONE card with a row per dependency, each with
//      its own reconnect CTA. Claiming a pending failure is destructive, so
//      before the array existed the second dependency was silently dropped
//      (CAN-1814 PR 2).
//   7. An errored `WatchGitHubItems` tool_result carrying an `integration`
//      `authFailure` -> the card names GitHub and offers the `gh auth login`
//      terminal CTA. `integration` had no producer before CAN-1814 PR 4, and
//      the tool name is not an MCP server tool, so the legacy text heuristic
//      could never have produced this card.
//   8. A LIVE send into a chat whose selected MCP server holds no OAuth token
//      -> the send-time preflight refuses it, and the refusal reaches the
//      renderer as data (`ChatSendMessageResult.refusedAuthDependencies`) so
//      the same card renders with a working reconnect CTA. Unlike 1-7 nothing
//      is seeded into the transcript: the card is produced end to end by the
//      real preflight, the real IPC result, and the real renderer path
//      (CAN-1814 PR 7). No LLM is involved -- the turn is refused before
//      dispatch -- and no token is seeded either, because an absent token is
//      exactly what `getMcpOAuthAuthStatus` reports as `not_connected`.
//   9. A LIVE send with the same optional OAuth metadata but a configured
//      bearer token -> the preflight falls through, the provider turn runs,
//      and no reconnect card is rendered.
//  10. A Codex dynamic-tool GitHub authFailure offers the same reconnect CTA.
//
// Run: pnpm run build:e2e && pnpm run test:electron:built
//   can-1814-auth-failure-recovery-cta.spec.mjs --reporter=line
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedMcpServers,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const MCP_TOOL_NAME = 'mcp__fixture-connected-account__lookup-records';
/**
 * Claude reaches Canopy's own injected tools over the branded MCP HTTP server,
 * so this is the raw name a transcript records for `WatchGitHubItems`. It is
 * deliberately NOT a third-party MCP server tool.
 */
const WATCH_GITHUB_TOOL_NAME = 'mcp__canopy__WatchGitHubItems';
/**
 * Codex reaches the same tool as a dynamic tool under the branded snake_case
 * name, and the transcript keys its blocks `codex-<item id>`. Main's pairing
 * attaches the failure to that id (`auth-failure-event.ts`), so this pins the
 * Codex-shaped transcript rendering the same card.
 */
const CODEX_WATCH_GITHUB_TOOL_NAME = 'canopy_watch_github_items';
const GITHUB_FAILURE = {
  dependencyClass: 'integration',
  dependencyId: 'integration:github',
  displayName: 'GitHub',
  failureClass: 'unauthenticated',
  recovery: { kind: 'github_login' },
};
const NOW = Date.parse('2026-09-01T12:00:00.000Z');

async function launchWithSeededChats(tabs) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-1814-auth-failure-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: tabs[0].providerType ?? 'claude',
    activeTabId: tabs[0].chatId,
    tabs: tabs.map(({ chatId, blocks, providerType = 'claude' }) => ({
      id: chatId,
      title: 'Auth failure recovery',
      providerType,
      messages: [
        {
          id: `${chatId}-user`,
          role: 'user',
          blocks: [{ type: 'text', text: 'Look up the account records.' }],
          timestamp: NOW,
        },
        {
          id: `${chatId}-assistant`,
          role: 'assistant',
          blocks,
          timestamp: NOW + 1_000,
        },
      ],
    })),
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { electronApp, userDataDir, window };
}

async function launchWithSeededChat(
  chatId,
  blocks,
  { providerType = 'claude' } = {},
) {
  const harness = await launchWithSeededChats([
    { chatId, blocks, providerType },
  ]);
  const chatPanel = harness.window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
  await expect(chatPanel).toBeVisible();
  return { ...harness, chatPanel };
}

const staticTranscriptTabs = [];
let staticTranscriptHarness;

function staticTranscriptTest(title, chatId, blocks, assertion) {
  staticTranscriptTabs.push({ chatId, blocks });
  test(title, async () => {
    test.setTimeout(120_000);
    staticTranscriptHarness ??=
      await launchWithSeededChats(staticTranscriptTabs);
    const { window } = staticTranscriptHarness;
    const tab = window.getByTestId(`panel-tab-panel-chat-${chatId}`);
    await expect(tab).toBeVisible();
    await tab.click();
    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(chatPanel).toBeVisible();
    await assertion({ chatPanel });
  });
}

test.afterAll(async () => {
  if (staticTranscriptHarness) {
    await teardown(
      staticTranscriptHarness.electronApp,
      staticTranscriptHarness.userDataDir,
    );
  }
});

async function teardown(electronApp, userDataDir) {
  await closeCanopy(electronApp, userDataDir);
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
}

staticTranscriptTest(
  'a structured MCP authFailure on the tool_result shows the reconnect CTA',
  'structured-auth-failure-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'mcp-auth-call',
      toolName: MCP_TOOL_NAME,
      input: '{"query":"account records"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'mcp-auth-call',
      toolName: MCP_TOOL_NAME,
      output: 'MCP error -32001: MCP server authorization required',
      isError: true,
      authFailure: {
        dependencyClass: 'mcp',
        dependencyId:
          'fixture-connected-account:fixture-connected-account-default',
        displayName: 'Fixture Connected Account',
        failureClass: 'expired',
        recovery: {
          kind: 'mcp_oauth',
          serverId: 'fixture-connected-account',
          configId: 'fixture-connected-account-default',
        },
      },
    },
  ],
  async ({ chatPanel }) => {
    const mcpRecovery = chatPanel.getByTestId('auth-recovery-card');
    await expect(mcpRecovery).toBeVisible();
    // The card names the failing server, straight from the structured data.
    await expect(mcpRecovery).toContainText('Fixture Connected Account');
    const mcpCta = mcpRecovery.getByTestId('chat-connection-cta-mcp');
    await expect(mcpCta).toBeVisible();
    await expect(mcpCta).toHaveCount(1);
    await expect(mcpCta).toHaveText('Reconnect Fixture Connected Account');
  },
);

staticTranscriptTest(
  'a 401 status line with no structured authFailure still shows the CTA (CAN-1814)',
  'legacy-401-cta-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'stdio-mcp-call',
      toolName: MCP_TOOL_NAME,
      input: '{"query":"account records"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'stdio-mcp-call',
      toolName: MCP_TOOL_NAME,
      // A stdio MCP server never traverses Canopy's HTTP proxy, so nothing
      // publishes a structured failure for it. The status line is the only
      // signal there is.
      output: 'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}',
      isError: true,
    },
  ],
  async ({ chatPanel }) => {
    const mcpRecovery = chatPanel.getByTestId('auth-recovery-card');
    await expect(mcpRecovery).toBeVisible();
    // No structured data means no serverId/configId, so the fallback names the
    // server from the tool name and routes to the MCP settings surface — the
    // same destination the button it replaced used.
    await expect(mcpRecovery.getByTestId('chat-connection-cta-mcp')).toHaveText(
      'Connect Fixture Connected Account',
    );
  },
);

staticTranscriptTest(
  'a non-auth mention of 401 in tool output shows no CTA (CAN-1814)',
  'bare-401-no-cta-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'log-read-call',
      toolName: MCP_TOOL_NAME,
      input: '{"path":"app.log"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'log-read-call',
      toolName: MCP_TOOL_NAME,
      // The number appears, but never as an auth status.
      output: 'app.log:42: processed 401 events, 0 failures',
      isError: true,
    },
  ],
  async ({ chatPanel }) => {
    // The raw tool output only renders once the tool-call card is expanded
    // (ToolCallCard defaults to collapsed). Expand it first so this asserts
    // against the actual seeded transcript rather than passing vacuously if
    // the chat failed to load.
    const toolCallCard = chatPanel
      .locator(
        `[data-testid="chat-tool-call"][data-tool-name="${MCP_TOOL_NAME}"]`,
      )
      .first();
    await expect(toolCallCard).toBeVisible();
    await toolCallCard.getByRole('button').click();
    await expect(
      toolCallCard.getByText('app.log:42: processed 401 events, 0 failures'),
    ).toBeVisible();
    await expect(chatPanel.getByTestId('chat-connection-cta-mcp')).toHaveCount(
      0,
    );
    await expect(chatPanel.getByTestId('auth-recovery-card')).toHaveCount(0);
  },
);

staticTranscriptTest(
  'a 403 insufficient_scope authFailure explains the scope, with no reconnect CTA (CAN-1814)',
  'insufficient-scope-no-cta-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'mcp-scope-call',
      toolName: MCP_TOOL_NAME,
      input: '{"query":"account records"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'mcp-scope-call',
      toolName: MCP_TOOL_NAME,
      // Output the text fallback WOULD match, to prove structured data wins.
      output: 'MCP error -32001: MCP server authorization required',
      isError: true,
      authFailure: {
        dependencyClass: 'mcp',
        dependencyId:
          'fixture-connected-account:fixture-connected-account-default',
        displayName: 'Fixture Connected Account',
        failureClass: 'insufficient_scope',
        recovery: { kind: 'none' },
      },
    },
  ],
  async ({ chatPanel }) => {
    const toolCallCard = chatPanel
      .locator(
        `[data-testid="chat-tool-call"][data-tool-name="${MCP_TOOL_NAME}"]`,
      )
      .first();
    await expect(toolCallCard).toBeVisible();
    const card = chatPanel.getByTestId('auth-recovery-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(
      'refused this request — the connection is missing a required permission.',
    );
    // A settings route is not a login affordance; a connect CTA would be.
    await expect(chatPanel.getByTestId('chat-connection-cta-mcp')).toHaveCount(
      0,
    );
    await expect(
      chatPanel.getByTestId('auth-recovery-settings-cta'),
    ).toBeVisible();
  },
);

staticTranscriptTest(
  'a persisted authFailure breaking the recoverable-class invariant shows no CTA (CAN-1814)',
  'invalid-pairing-no-cta-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'mcp-invalid-call',
      toolName: MCP_TOOL_NAME,
      input: '{"query":"account records"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'mcp-invalid-call',
      toolName: MCP_TOOL_NAME,
      // Output the text fallback WOULD match, so this proves the component
      // fails CLOSED on unusable structured data rather than falling back.
      output: 'MCP error -32001: MCP server authorization required',
      isError: true,
      // `chat-tabs-reader.ts` validates only toolUseId/toolName/output/
      // isError and passes `authFailure` through unchecked, so this shape
      // survives a read from disk. `quota_exceeded` is not a recoverable
      // class, so pairing it with `mcp_oauth` violates the wire invariant.
      authFailure: {
        dependencyClass: 'mcp',
        dependencyId:
          'fixture-connected-account:fixture-connected-account-default',
        displayName: 'Fixture Connected Account',
        failureClass: 'quota_exceeded',
        recovery: {
          kind: 'mcp_oauth',
          serverId: 'fixture-connected-account',
          configId: 'fixture-connected-account-default',
        },
      },
    },
  ],
  async ({ chatPanel }) => {
    const toolCallCard = chatPanel
      .locator(
        `[data-testid="chat-tool-call"][data-tool-name="${MCP_TOOL_NAME}"]`,
      )
      .first();
    await expect(toolCallCard).toBeVisible();
    await expect(chatPanel.getByTestId('auth-recovery-card')).toHaveCount(0);
    await expect(chatPanel.getByTestId('chat-connection-cta-mcp')).toHaveCount(
      0,
    );
  },
);

const prodFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'fixture-connected-account:fixture-connected-account-default',
  displayName: 'Fixture Connected Account',
  failureClass: 'expired',
  recovery: {
    kind: 'mcp_oauth',
    serverId: 'fixture-connected-account',
    configId: 'fixture-connected-account-default',
  },
};
const docsFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'fixture-docs-account:fixture-docs-account-default',
  displayName: 'Fixture Docs Account',
  failureClass: 'unauthenticated',
  recovery: {
    kind: 'mcp_oauth',
    serverId: 'fixture-docs-account',
    configId: 'fixture-docs-account-default',
  },
};

staticTranscriptTest(
  'two blocked dependencies render one card with an independent row each (CAN-1814)',
  'multi-blocker-checklist-chat',
  [
    {
      type: 'tool_use',
      toolUseId: 'mcp-multi-call',
      toolName: MCP_TOOL_NAME,
      input: '{"query":"account records"}',
    },
    {
      type: 'tool_result',
      toolUseId: 'mcp-multi-call',
      toolName: MCP_TOOL_NAME,
      output: 'MCP error -32001: MCP server authorization required',
      isError: true,
      // Both fields, exactly as `attachAuthFailureToBlocks` writes them: the
      // scalar for readers predating the checklist, the array for the card.
      authFailure: prodFailure,
      authFailures: [prodFailure, docsFailure],
    },
  ],
  async ({ chatPanel }) => {
    const card = chatPanel.getByTestId('auth-recovery-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(
      '2 connections need attention before this can continue.',
    );

    const rows = card.getByTestId('auth-recovery-row');
    await expect(rows).toHaveCount(2);

    const prodRow = card.locator(
      `[data-testid="auth-recovery-row"][data-dependency-id="${prodFailure.dependencyId}"]`,
    );
    const docsRow = card.locator(
      `[data-testid="auth-recovery-row"][data-dependency-id="${docsFailure.dependencyId}"]`,
    );
    await expect(prodRow.getByTestId('chat-connection-cta-mcp')).toHaveText(
      'Reconnect Fixture Connected Account',
    );
    await expect(docsRow.getByTestId('chat-connection-cta-mcp')).toHaveText(
      'Reconnect Fixture Docs Account',
    );
    const mediumWeightLabel = prodRow
      .locator('strong')
      .filter({ hasText: prodFailure.displayName });
    await expect(mediumWeightLabel).toBeVisible();
    expect(
      await mediumWeightLabel.evaluate(
        (element) => window.getComputedStyle(element).fontWeight,
      ),
    ).toBe('450');
  },
);

staticTranscriptTest(
  'a GitHub integration authFailure offers the gh auth login CTA (CAN-1814 PR 4)',
  'github-integration-cta-chat',
  [
    // `integration` had no producer until PR 4. `WatchGitHubItems` is the one
    // Canopy-injected tool that reaches the first-party GitHub integration, and a
    // broker `not_authenticated` verdict now rides its errored `tool_result` the
    // same way an MCP 401 rides an MCP tool's. Two things this pins that a unit
    // test cannot: the failure survives the persisted read path and reduction
    // into a real transcript, and the CTA renders on a tool name that is NOT an
    // MCP server tool — the legacy text heuristic could never have produced it.
    {
      type: 'tool_use',
      toolUseId: 'github-watcher-call',
      toolName: WATCH_GITHUB_TOOL_NAME,
      input: '{"items":[123],"notifyOn":{"jobs":{"conclusions":"any"}}}',
    },
    {
      type: 'tool_result',
      toolUseId: 'github-watcher-call',
      toolName: WATCH_GITHUB_TOOL_NAME,
      output:
        '{"ok":false,"code":"not_authenticated","message":"No GitHub token is available. Configure a PAT or sign in with the GitHub CLI."}',
      isError: true,
      authFailure: GITHUB_FAILURE,
      authFailures: [GITHUB_FAILURE],
    },
  ],
  async ({ chatPanel }) => {
    const card = chatPanel.getByTestId('auth-recovery-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('GitHub needs to be reconnected.');

    const row = card.locator(
      '[data-testid="auth-recovery-row"][data-dependency-id="integration:github"]',
    );
    await expect(row).toHaveAttribute('data-dependency-class', 'integration');
    await expect(row).toHaveAttribute('data-recovery-kind', 'github_login');

    // The GitHub CTA is the shared provider-terminal affordance, so it carries
    // the `chat-connection-cta-<provider>` id rather than the dependency-class
    // one a settings route would get. NOT clicked: the click spawns the real
    // `gh auth login` PTY.
    const cta = row.getByTestId('chat-connection-cta-github');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText('Reconnect GitHub');
    await expect(row.getByTestId('auth-recovery-settings-cta')).toHaveCount(0);
  },
);

test('a Codex dynamic-tool GitHub authFailure offers the same reconnect CTA', async () => {
  test.setTimeout(120_000);
  // Same failure, Codex transcript shape: the raw dynamic tool name and the
  // `codex-<item id>` block id main's pairing produces for a Codex session.
  const chatId = 'codex-github-integration-cta-chat';
  const { electronApp, userDataDir, chatPanel } = await launchWithSeededChat(
    chatId,
    [
      {
        type: 'tool_use',
        toolUseId: 'codex-item-github-watch',
        toolName: CODEX_WATCH_GITHUB_TOOL_NAME,
        input: '{"items":[123],"notifyOn":{"run":{"conclusions":"any"}}}',
      },
      {
        type: 'tool_result',
        toolUseId: 'codex-item-github-watch',
        toolName: CODEX_WATCH_GITHUB_TOOL_NAME,
        output:
          '{"ok":false,"code":"not_authenticated","message":"No GitHub token is available. Configure a PAT or sign in with the GitHub CLI."}',
        isError: true,
        authFailure: GITHUB_FAILURE,
        authFailures: [GITHUB_FAILURE],
      },
    ],
    { providerType: 'codex' },
  );

  try {
    const card = chatPanel.getByTestId('auth-recovery-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('GitHub needs to be reconnected.');
    const row = card.locator(
      '[data-testid="auth-recovery-row"][data-dependency-id="integration:github"]',
    );
    await expect(row).toHaveAttribute('data-recovery-kind', 'github_login');
    await expect(row.getByTestId('chat-connection-cta-github')).toHaveText(
      'Reconnect GitHub',
    );
  } finally {
    await teardown(electronApp, userDataDir);
  }
});

// CAN-4006 plan §6: exercise the real pending-turn claim, credential resolver,
// refresh handler and automatic dispatch. Seed the pending failure through the
// build-gated main stop boundary; the safety policy remains unchanged.
test('GitHub login resumes a stopped read once after main resolves a saved token', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can-4006-auth-resume-'),
  );
  const chatId = 'github-auto-resume';
  const marker = 'Canopy-C4006-GITHUB-AUTO-RESUME';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'GitHub recovery',
        providerType: 'claude',
        messages: [
          {
            id: 'github-user',
            role: 'user',
            timestamp: Date.now() - 2000,
            blocks: [
              {
                type: 'text',
                text: `[${marker}] Read the pull request status.`,
              },
            ],
          },
          {
            id: 'github-failure',
            role: 'system',
            timestamp: Date.now() - 1000,
            blocks: [
              {
                type: 'text',
                text: 'Reconnect GitHub.',
                authFailures: [GITHUB_FAILURE],
              },
            ],
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { GH_CONFIG_DIR: path.join(userDataDir, 'empty-gh-config') },
  });
  const outcomes = () => {
    const directory = path.join(
      userDataDir,
      'agent-observability',
      'diagnostics',
      'session-events',
    );
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) =>
        readFileSync(path.join(directory, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .filter(
        (event) =>
          event.kind === 'auth_resume_outcome' && event.chatId === chatId,
      );
  };
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      for (const [channel, handler] of [
        ['auth-terminal:start', () => ({ sessionId: 'github-resume-login' })],
        ['auth-terminal:stop', () => {}],
        ['auth-terminal:resize', () => {}],
        ['auth-terminal:write', () => {}],
      ]) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      }
    });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    const stopped = await electronApp.evaluate(
      async ({ BrowserWindow }, input) =>
        globalThis.__CANOPY_E2E_STOP_AUTH_FAILURE__({
          target: {
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            chatId: input.chatId,
          },
          event: {
            type: 'canopy_auth_failure',
            toolUseId: 'github-read',
            failure: input.failure,
            failures: [input.failure],
          },
          toolName: 'mcp__github__list_issues',
          initiationSource: 'user',
          getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId,
        failure: GITHUB_FAILURE,
      },
    );
    expect(stopped).toMatchObject({ stopped: true, autoResumeSafe: true });
    const cta = panel.getByTestId('chat-connection-cta-github');
    await expect(cta).toBeVisible({ timeout: 60_000 });
    await expect(
      panel.getByRole('button', { name: 'Send message' }),
    ).toBeVisible();
    await cta.click();
    await expect(window.getByTestId('auth-login-modal')).toBeVisible();
    // Closing without a main-side token cannot claim or resume the turn.
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    expect(outcomes()).toEqual([]);
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: 'CAN4006_RESUMED', stopReason: 'end_turn' }] },
    });
    await cta.click();
    const saved = await window.evaluate(() =>
      window.api.saveGitHubPat('ghp_can4006_fixture_token'),
    );
    expect(saved.success).toBe(true);
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(
      panel.getByText('CAN4006_RESUMED', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => outcomes().map((event) => event.authResumeStatus))
      .toEqual(['resumed']);
    await window.evaluate(() =>
      Promise.all([
        window.api.refreshGitHubCredentials(),
        window.api.refreshGitHubCredentials(),
      ]),
    );
    expect(outcomes().map((event) => event.authResumeStatus)).toEqual([
      'resumed',
    ]);
    await expect(
      panel.getByText('CAN4006_RESUMED', { exact: true }),
    ).toHaveCount(1);
  } finally {
    await teardown(electronApp, userDataDir);
  }
});

test('a send refused by the auth preflight renders the reconnect card (CAN-1814 PR 7)', async () => {
  test.setTimeout(120_000);
  // The only scenario here that seeds NO transcript. The chat starts empty and
  // the card is produced by the live path end to end:
  //   `chat:send-message` -> `assertTurnAuthDependencies` (cached-only, reads
  //   the seeded `mcp-servers/server-*.json` and finds no stored OAuth token)
  //   -> `TurnAuthPreflightBlockedError` -> `describeTurnAuthRefusal` ->
  //   `ChatSendMessageResult.refusedAuthDependencies` -> the renderer's system
  //   message with `authFailures` -> `ChatBlockRenderer` -> `AuthRecoveryCard`.
  //
  // Before PR 7 the refusal crossed the IPC boundary as a bare string and this
  // rendered as plain prose with no way to reconnect.
  //
  // Deterministic and offline: `httpAuthHandler: 'canopy'` keeps the server on
  // the Canopy-owned credential axis (no upstream OAuth probe, CAN-399), the
  // absent token store yields `not_connected` without seeding secure storage,
  // and no provider turn ever starts because the send is refused first.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-1814-refused-send-'),
  );
  const chatId = 'refused-send-chat';
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'fixture-connected-account',
          name: 'Fixture Connected Account',
          description: 'HTTP MCP server whose OAuth token Canopy owns',
          type: 'http',
          url: 'https://fixture.example.test/mcp',
          // Canopy-owned credential: the only axis the preflight may judge.
          httpAuthHandler: 'canopy',
          oauth: { clientId: 'fixture-client-id' },
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            description: 'Default configuration',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-01T12:00:00.000Z',
          },
        ],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Refused send',
        providerType: 'claude',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'fixture-connected-account', configId: 'default' },
          ],
        },
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(chatPanel).toBeVisible();

    const composer = chatPanel.getByRole('textbox').first();
    await composer.fill('Look up the account records.');
    await chatPanel.getByRole('button', { name: 'Send message' }).click();

    const card = chatPanel.getByTestId('auth-recovery-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(
      'Fixture Connected Account needs to be reconnected.',
    );

    const row = card.locator(
      '[data-testid="auth-recovery-row"][data-dependency-id="fixture-connected-account:default"]',
    );
    await expect(row).toHaveAttribute('data-dependency-class', 'mcp');
    await expect(row).toHaveAttribute('data-recovery-kind', 'mcp_oauth');
    // NOT clicked: the click starts a real OAuth browser flow.
    await expect(row.getByTestId('chat-connection-cta-mcp')).toHaveText(
      'Reconnect Fixture Connected Account',
    );
  } finally {
    await teardown(electronApp, userDataDir);
  }
});

test('a configured bearer token bypasses the optional OAuth preflight', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-1814-bearer-send-'),
  );
  const chatId = 'bearer-send-chat';
  const marker = 'CAN-1814-BEARER-PREFLIGHT';
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'fixture-bearer-account',
          name: 'Fixture Bearer Account',
          description: 'HTTP MCP server with optional OAuth metadata',
          type: 'http',
          url: 'https://fixture.example.test/mcp',
          httpAuthHandler: 'canopy',
          oauth: { clientId: 'fixture-client-id' },
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            description: 'Bearer-owned configuration',
            enabled: true,
            authToken: 'fixture-bearer-token',
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-01T12:00:00.000Z',
          },
        ],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Bearer send',
        providerType: 'claude',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'fixture-bearer-account', configId: 'default' },
          ],
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(chatPanel).toBeVisible();
    await chatPanel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Confirm the bearer configuration can send.`);
    await chatPanel.getByRole('button', { name: 'Send message' }).click();

    await expect(
      chatPanel.getByText(
        'Mock response from the Canopy UI-automation LLM surface.',
      ),
    ).toBeVisible({ timeout: 90_000 });
    await expect(chatPanel.getByTestId('auth-recovery-card')).toHaveCount(0);
  } finally {
    await teardown(electronApp, userDataDir);
  }
});

for (const { worked, toolFailure, label } of [
  { worked: false, label: 'fresh' },
  { worked: true, label: 'worked' },
  { worked: true, toolFailure: true, label: 'tool-failure' },
]) {
  test(`MCP recovery resumes ${label} turn only after Resume and removes the card`, async () => {
    const { launchAuthRecoveryFixture } =
      await import('./authRecoveryFixture.mjs');
    const fixture = await launchAuthRecoveryFixture({ worked, toolFailure });
    try {
      if (toolFailure)
        await fixture.panel
          .getByRole('button', { name: /^Agent steps:/ })
          .click();
      await fixture.panel.getByTestId('chat-connection-cta-mcp').click();
      // Replaying the turn can repeat an external write, so the card never
      // resends on its own; the user confirms with Resume.
      await expect(
        fixture.panel.getByTestId('auth-recovery-resume'),
      ).toBeEnabled();
      expect(
        await fixture.electronApp.evaluate(
          () => globalThis.__authRecoveryFixture.sends.length,
        ),
      ).toBe(0);
      await fixture.panel.getByTestId('auth-recovery-resume').click();
      await expect
        .poll(() =>
          fixture.electronApp.evaluate(() =>
            globalThis.__authRecoveryFixture.sends.map(
              (request) => request.text,
            ),
          ),
        )
        .toEqual([worked ? 'Continue' : 'Investigate the Datadog errors.']);
      await expect(fixture.panel.getByTestId('auth-recovery-card')).toHaveCount(
        0,
      );
      await fixture.app.openChatPage();
      await fixture.app.openMainPage();
      await expect(fixture.panel.getByTestId('auth-recovery-card')).toHaveCount(
        0,
      );
    } finally {
      await teardown(fixture.electronApp, fixture.userDataDir);
    }
  });
}

test('MCP recovery keeps Resume after a failed dispatch and retries it', async () => {
  const { launchAuthRecoveryFixture } =
    await import('./authRecoveryFixture.mjs');
  const fixture = await launchAuthRecoveryFixture({ failFirstSend: true });
  try {
    await fixture.panel.getByTestId('chat-connection-cta-mcp').click();
    await fixture.panel.getByTestId('auth-recovery-resume').click();
    // The failed attempt leaves its user message in the transcript; that must
    // not retire the card and take the retry with it.
    await expect(
      fixture.panel.getByText('Could not resume. Try again.'),
    ).toBeVisible();
    await expect(
      fixture.panel.getByTestId('auth-recovery-resume'),
    ).toBeEnabled();
    await fixture.panel.getByTestId('auth-recovery-resume').click();
    await expect
      .poll(() =>
        fixture.electronApp.evaluate(
          () => globalThis.__authRecoveryFixture.sends.length,
        ),
      )
      .toBe(2);
    await expect(fixture.panel.getByTestId('auth-recovery-card')).toHaveCount(
      0,
    );
  } finally {
    await teardown(fixture.electronApp, fixture.userDataDir);
  }
});

test('MCP recovery observes external authentication and offers Resume after navigation', async () => {
  const { launchAuthRecoveryFixture, connectAuthRecoveryElsewhere } =
    await import('./authRecoveryFixture.mjs');
  const fixture = await launchAuthRecoveryFixture();
  try {
    await expect(fixture.panel.getByTestId('auth-recovery-card')).toBeVisible();
    await connectAuthRecoveryElsewhere(fixture.electronApp);
    await expect(
      fixture.panel.getByTestId('auth-recovery-resume'),
    ).toBeVisible();
    expect(
      await fixture.electronApp.evaluate(
        () => globalThis.__authRecoveryFixture.sends.length,
      ),
    ).toBe(0);
    await fixture.app.openChatPage();
    await fixture.app.openMainPage();
    await expect(
      fixture.panel.getByTestId('auth-recovery-resume'),
    ).toBeVisible();
    await fixture.panel.getByTestId('auth-recovery-resume').click();
    await expect(fixture.panel.getByTestId('auth-recovery-card')).toHaveCount(
      0,
    );
  } finally {
    await teardown(fixture.electronApp, fixture.userDataDir);
  }
});
