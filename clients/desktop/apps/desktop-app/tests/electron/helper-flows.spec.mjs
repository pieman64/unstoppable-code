import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closeFixture,
  conversationRequests,
  createFixture,
  protocolEntries,
  seedPreferences as seedCodexPreferences,
} from './codexPipelineRuntime.mjs';
import {
  CHAT_SUMMARY_FIXTURE_REPLY,
  chatSummaryTurnStarts,
} from './fixtures/codex-chat-summary-traffic.mjs';

// Doc 5 §5 ("helper-default") / Doc 13 WP-LIVE-HELPERS — live coverage for
// Canopy's one-shot Claude *helper flows*.
//
// Canopy's background helpers (chat/worktree summary, branch naming, commit
// message, PR generation) are not turns the test can author: each builds its
// own SDK invocation. Claude-backed helpers go through
// `resolveClaudeCompatibleInvocation`
// (apps/desktop-app/src/main/ollama/claude-compatible.ts), while Codex-backed
// helpers go through the shared Codex app-server runtime. Under the
// `__CANOPY_E2E__` build
// both paths are redirected at the shared mock LLM server. The mock's LLM route
// (tests/electron/mock-server/routes/llm.mjs) carries a *helper-fingerprint
// library* (Tier 2 of `resolveCannedStep`) that matches each helper's
// distinctive system prompt and answers with canned output. Those fingerprints
// are matched purely from the request's *system* text — unlike a marker-keyed
// conversation, a test cannot author them directly. Scenario registrations can
// override a matched helper by fingerprint id, which lets the fallback test
// below exercise an empty provider response through the real helper path.
//
// HELPER EXERCISED: chat (topic) summary.
//   Chosen as the helper that is most directly + deterministically assertable
//   from the UI: it is produced by a SINGLE provider response (no interactive
//   loop), its canned output is plain text with NO output-schema validation,
//   and on success the main process pushes `chatTabDescriptionUpdated`
//   (apps/desktop-app/src/main/lib/worktree-chat-turn.ts `scheduleChatSummary`)
//   to the renderer, which immediately relabels the chat tab (ChatTabBar
//   `tabLabel = tab.description ?? tab.title`). The asserted text — "Mock topic
//   summary" (llm.mjs HELPER_FINGERPRINTS[topic-summary]) — can ONLY come from
//   the mock provider answering the live helper turn, so the success and
//   fallback tests prove the bundled Claude SDK drove a one-shot helper end to
//   end against the mock.
//
//   Trigger: send the FIRST user message in a freshly-seeded worktree chat.
//   The chat turn itself is answered by the mock's benign default step, which
//   is enough to complete it; sending the first turn is what fires
//   `scheduleChatSummary` (gated on `!sdkSessionId` / not a resumed session).
//
//   The shipped default summary model is a Codex model. A separate test leaves
//   the summary preference unset and runs the same helper through the fake
//   Codex app-server (fixtures/fake-codex-app-server.mjs), whose summary reply
//   relabels the tab.
//
// Additional helper coverage in this file:
//
//   • branch-naming — covered through the Home surface's chat-mode send
//     below (New Task → fill the composer → Send, the Home-surface
//     replacement for the old Create Task modal's Chat button). The test
//     creates a real worktree, auto-sends the task text into the new chat, and
//     pins the factory-seeded Haiku model even though the worktree default is
//     Codex, so the scenario-registered agent response is parsed
//     deterministically. A green
//     run proves the first chat message reached the branch-naming helper and
//     the helper-provided branch name propagated back into the worktree row.
//
// HELPERS CONSIDERED BUT BLOCKED AGAINST THE CURRENT MOCK (captured exactly so
// a future mock/helper change can re-enable them):
//
//   • commit-message — TRIGGER works (local-only "Commit" with
//     `reviewCommitMessage: true` → `github:generate-commit-messages` →
//     `generateCommitMessage` helper → review modal opens), but the canned
//     value never surfaces. The fingerprint returns
//     `{ message: { subject, body } }`, while the helper's output schema +
//     `isCommitMessage` guard require `message` to be a *string*
//     (packages/desktop-shared/src/lib/commit-message-generator.ts). The object
//     form fails validation, so the helper falls back to the branch title.
//     Verified empirically: the review textarea filled with the fallback
//     "Demo main", not "chore: mock commit".
//
// The bundled `claude` binary runs for real (redirected to the mock), so the
// helper turn takes a few seconds; assertions use generous timeouts.

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const CHAT_TAB_ID = 't1';
// Only placeholder-titled chats are eligible for their initial generated
// title; a seeded meaningful creation title is preserved (CAN-3652).
const NEW_CHAT_TITLE = 'New Chat';

// Canned chat-summary output from the mock helper-fingerprint library (llm.mjs
// HELPER_FINGERPRINTS[topic-summary]).
const CANNED_SUMMARY = 'Mock topic summary';
const FALLBACK_MARKER = 'Canopy-CHELPER-FALLBACK';
// `[Canopy-CHELPER-FALLBACK] Retain this fallback title` without its brackets
// (word-internal hyphens stay), cut to 40 characters at the last whole word.
const FALLBACK_TITLE = 'Canopy-CHELPER-FALLBACK Retain this';
const CODEX_CONVERSATION_REPLY = 'Codex conversation reply for the summary';
// Canned branch-naming output from the mock helper-fingerprint library. Helper
// fingerprints intentionally take precedence over marker conversations.
const CANNED_BRANCH_NAME = 'canopy/mock-branch';

function currentGitBranch(worktreePath) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
}

// Both preference-seed helpers below pre-write `preferences.json` before
// `launchCanopy()` runs, so `launchCanopy.mjs`'s own `seedOnboardingCompleted`
// (which seeds the blocking first-run legal gate's acceptance, but only when
// the file doesn't already exist) never runs for these tests. Seed the same
// `legalConsentAcceptedAt`/`legalConsentTosVersion` fields here so the shell
// isn't blocked behind the legal gate.
const HELPER_FLOWS_LEGAL_CONSENT_PREFERENCES = {
  legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
  legalConsentTosVersion: '2026-07-06',
};

function seedCanopyNativeHelperPreferences(userDataDir) {
  // Keep this helper safe if a future caller passes a not-yet-created directory.
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          canopyBackgroundProcessesMode: 'canopy',
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: true,
          summaryThinkingLevel: 'off',
          defaultWorktreeProvider: 'codex',
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'claude-haiku-4-5-20251001',
              thinkingLevel: 'off',
            },
            codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
            ollama: null,
            aiCredits: null,
          },
          ...HELPER_FLOWS_LEGAL_CONSENT_PREFERENCES,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function latestChatSummaryAuditEntry(userDataDir) {
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  const day = new Date().toISOString().slice(0, 10);
  const auditPath = path.join(auditDir, `${day}.jsonl`);
  if (!existsSync(auditPath)) {
    return undefined;
  }
  const entries = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.eventType === 'chat_summary');
  return entries.at(-1);
}

function latestBranchNamingAuditEntry(userDataDir) {
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  const day = new Date().toISOString().slice(0, 10);
  const auditPath = path.join(auditDir, `${day}.jsonl`);
  if (!existsSync(auditPath)) {
    return undefined;
  }
  const entries = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.eventType === 'branch_naming');
  return entries.at(-1);
}

function seedBranchNamingPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          branchNamePrefixMode: 'custom',
          branchNameCustomPrefix: '',
          branchNamingModel: 'claude-haiku-4-5-20251001',
          branchNamingThinkingLevel: 'off',
          defaultWorktreeProvider: 'codex',
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'claude-haiku-4-5-20251001',
              thinkingLevel: 'off',
            },
            codex: { model: 'gpt-5.6-sol', thinkingLevel: 'high' },
            ollama: null,
            aiCredits: null,
          },
          ...HELPER_FLOWS_LEGAL_CONSENT_PREFERENCES,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

test.describe('helper flows (live, mock-redirected)', () => {
  test('chat-summary helper relabels the chat tab with the mock canned summary', async () => {
    // The chat turn + the chat-summary helper turn both run the real bundled
    // `claude` binary for this test; give it comfortably above the 60s default.
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-helper-flows-'),
    );
    // This spec asserts the legacy SDK helper fingerprint path; terminal
    // worker-backed background process coverage lives in separate tests.
    seedCanopyNativeHelperPreferences(userDataDir);

    // Phase 1: real git worktree for the single-repo demo workspace.
    const demoSeed = seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    expect(currentGitBranch(worktreePath)).toBe(WORKTREE_BRANCH);

    // Phase 1: a Claude-backed empty chat tab so the composer mounts ready to
    // send. The tab starts with NO description, so its label is the title until
    // the chat-summary helper relabels it.
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: CHAT_TAB_ID, title: NEW_CHAT_TITLE }],
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      // Scope to the sidebar: when no worktree is selected yet, the central
      // panel's embedded Home surface also renders a workspace picker option
      // with this same name, which would make an unscoped lookup ambiguous.
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();

      await app.selectWorktree(WORKTREE_BRANCH);

      // The Claude chat panel + composer mount.
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // The seeded tab renders with its title until the summary helper runs.
      const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`);
      await expect(tab).toBeVisible();
      await expect(tab).toContainText(NEW_CHAT_TITLE);

      // Send a first user message. The chat turn itself is answered by the
      // mock's benign default step (no marker), which completes the turn;
      // sending it is what fires the one-shot chat-summary helper for this first
      // turn.
      const userMessage = 'Investigate the failing health-check endpoint.';
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The user message renders in the transcript once sent.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The chat-summary helper round-trips through the bundled `claude` binary
      // → mock `/v1/messages` → topic-summary fingerprint → main pushes
      // `chatTabDescriptionUpdated` → the tab relabels to the canned summary.
      // This text can ONLY originate from the mock helper answering the live
      // turn. Allow time for the real binary spawn + handshake + stream.
      await expect(tab).toContainText(CANNED_SUMMARY, { timeout: 90_000 });

      // The summary preference is explicitly Haiku while the interactive
      // worktree default is Codex. The helper must honor the feature-specific
      // preference instead of treating Haiku as an untouched lane seed.
      await expect
        .poll(() => latestChatSummaryAuditEntry(userDataDir)?.status, {
          timeout: 30_000,
        })
        .toBe('success');
      expect(latestChatSummaryAuditEntry(userDataDir)?.model).toBe(
        'claude-haiku-4-5-20251001',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('chat-summary helper runs on the default Codex summary model on its own thread', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-helper-codex-summary-'),
    );
    // No summary preference: the chat summary uses the shipped provider-aware
    // default, which is a Codex model, and runs through the fake Codex
    // app-server alongside the Codex conversation.
    const fixture = createFixture('normal', CODEX_CONVERSATION_REPLY);
    seedCodexPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: CHAT_TAB_ID,
          title: NEW_CHAT_TITLE,
          providerType: 'codex',
          model: 'gpt-6-sol',
        },
      ],
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`);
      await expect(tab).toContainText('Chat');

      const userMessage = 'Investigate the failing health-check endpoint.';
      const composer = window.getByRole('textbox').first();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText(CODEX_CONVERSATION_REPLY, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      // Only the summary turn answers with this text, so the relabel proves
      // the Codex summary helper ran end to end.
      await expect(tab).toContainText(CHAT_SUMMARY_FIXTURE_REPLY, {
        timeout: 90_000,
      });
      await expect
        .poll(() => latestChatSummaryAuditEntry(userDataDir)?.status, {
          timeout: 30_000,
        })
        .toBe('success');
      // DEFAULT_SUMMARY_MODEL in packages/desktop-shared/src/types.ts.
      expect(latestChatSummaryAuditEntry(userDataDir)?.model).toBe(
        'gpt-6-luna',
      );

      // The summary quotes the message on its own thread; the conversation
      // keeps exactly one turn.
      const summaryTurns = chatSummaryTurnStarts(
        protocolEntries(fixture.logPath),
      );
      expect(summaryTurns).toHaveLength(1);
      expect(JSON.stringify(summaryTurns[0].params.input)).toContain(
        userMessage,
      );
      const conversationTurns = conversationRequests(fixture.logPath).filter(
        (request) => request.method === 'turn/start',
      );
      expect(conversationTurns).toHaveLength(1);
      expect(conversationTurns[0].params.threadId).not.toBe(
        summaryTurns[0].params.threadId,
      );
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('chat-summary fallback keeps the original description and records failure usage', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-helper-fallback-'),
    );
    seedCanopyNativeHelperPreferences(userDataDir);
    await registerScenario(DEFAULT_MOCK_BASE_URL, FALLBACK_MARKER, {
      llm: {
        helperStepsById: {
          'topic-summary': {
            text: '',
            stopReason: 'end_turn',
            usage: { inputTokens: 37, outputTokens: 0 },
          },
        },
      },
    });

    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
    });
    const worktreePath = demoSeed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded worktree path').toBeTruthy();
    expect(currentGitBranch(worktreePath)).toBe(WORKTREE_BRANCH);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: CHAT_TAB_ID, title: NEW_CHAT_TITLE }],
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      const tab = window.getByTestId(`panel-tab-panel-chat-${CHAT_TAB_ID}`);
      const userMessage = `[${FALLBACK_MARKER}] Retain this fallback title`;
      const composer = window.getByRole('textbox').first();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // A saved fallback is the chat's permanent initial title, so it is
      // bounded to the concise 40-character limit at a word boundary.
      await expect(tab).toContainText(FALLBACK_TITLE, { timeout: 90_000 });
      await expect(tab).not.toContainText(userMessage);
      await expect
        .poll(() => latestChatSummaryAuditEntry(userDataDir)?.status, {
          timeout: 30_000,
        })
        .toBe('failure');

      await app.openAuditPage();
      await window
        .getByTestId('audit-trail-event-type-filter')
        .selectOption('chat_summary');
      const auditEntries = window.getByTestId('audit-entry-list');
      await expect(auditEntries).toContainText('Chat summary');
      await expect(auditEntries).toContainText('Failure');
      await expect(auditEntries).toContainText(
        'Summary generation returned no usable text.',
      );
      // The Claude SDK reports the configured 37 input tokens on both its
      // stream and result usage events; the helper collector preserves the
      // aggregate rather than dropping usage when output is empty.
      await expect(auditEntries).toContainText('74 tokens');

      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(tab).toContainText(FALLBACK_TITLE);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('branch-naming helper renames a Home-surface chat worktree with the mock branch', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-branch-naming-'),
    );
    seedBranchNamingPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      // Scope to the sidebar: when no worktree is selected yet, the central
      // panel's embedded Home surface also renders a workspace picker option
      // with this same name, which would make an unscoped lookup ambiguous.
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();

      // The sidebar's "New Task" item (testid `sidebar-create-task`) now lands
      // on the Home surface instead of opening a Create Task modal.
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // The single seeded workspace is auto-selected (MRU-fallback-to-first
      // seed effect); wait for the picker to reflect it before typing.
      await expect(homePage.getByTestId('home-workspace-select')).toContainText(
        WORKSPACE_NAME,
      );

      const taskText = 'Add billing metrics panel to the dashboard.';
      // Scope to `page-home`: `WorktreeManager` stays mounted (hidden) behind
      // the Home page and can render its own embedded Home surface/composer
      // when no worktree is selected, so an unscoped textbox lookup would be
      // ambiguous.
      const composer = homePage.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(taskText);

      // Chat mode + "New worktree" branch target are both the composer's
      // defaults, matching the old Create Task modal's Chat button.
      await homePage.getByTestId('home-send-button').click();
      await expect(homePage).toHaveCount(0);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 45_000 });
      await expect(panel.getByText(taskText).first()).toBeVisible({
        timeout: 45_000,
      });

      // Create Task initially creates a placeholder branch based on the new
      // worktree id. The first chat message schedules branch naming; the Haiku
      // helper request matches the mock's branch-naming fingerprint, so the
      // app-server turn returns the canned JSON branch name and the renderer
      // eventually refreshes the row's `data-branch` attribute from git state.
      const renamedRow = window.locator(
        `[data-testid="worktree-row"][data-branch="${CANNED_BRANCH_NAME}"]`,
      );
      await expect(renamedRow).toBeVisible({ timeout: 120_000 });
      await expect(renamedRow).toContainText(CANNED_BRANCH_NAME);
      await expect
        .poll(() => latestBranchNamingAuditEntry(userDataDir)?.model, {
          timeout: 30_000,
        })
        .toBe('claude-haiku-4-5-20251001');
      expect(latestBranchNamingAuditEntry(userDataDir)?.provider).toBe(
        'claude',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
