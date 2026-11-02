import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  buildApprovalRule,
  injectApprovalAutoResolvedEvent,
  injectApprovalRequestEvent,
  injectChatEvent,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// Task 18 — the synthetic tool-approval prompt-interaction matrix
// (`ToolApprovalCard.tsx`, the turn-timer pause/resume wiring in
// `stores/chat/slices/approvals.ts`, and the Settings > Approvals rule
// tables in `ApprovalsTab.tsx`).
//
// Task 20 — the card moved out of the chat transcript into a dock rendered
// directly above the composer (`ToolApprovalDock.tsx`), so it no longer
// needs to match itself to a specific `tool_use` block by `toolUseId` —
// `ChatBlockRenderer.tsx` (and the now-deleted `tool-approval-pending-
// match.ts`) never render an approval card inline anymore. The dock shows
// every pending approval for the active chat, in arrival order, with ← →
// navigation and an "Approval N of M" count once there is more than one.
// `data-testid="tool-approval-card"` is unchanged (still the same
// `ToolApprovalCard` component, just relocated and wrapped), so every test
// below that only cares about the card's own behavior (Allow/Deny/menus/
// reason) needed no changes beyond this header. Two tests DID need
// structural changes:
//   - The old "Codex flavor (exact toolUseId matching): Allow once matches
//     its own block, not an earlier unresolved decoy" test existed
//     specifically to prove block-matching correctness — a decoy unresolved
//     `tool_use` block with a different `toolUseId` must not steal the
//     card. That distinction no longer exists (the dock never looks at
//     transcript blocks at all), so it has been replaced below with a
//     multi-approval navigation test, which is the actual new behavior this
//     task adds.
//   - Every remaining "Claude flavor" / "Codex flavor" test still seeds the
//     provider-appropriate event shape (id-less for Claude, a
//     deterministic `codex-<id>` `toolUseId` for Codex — see the correction
//     below), but that shape now only matters for provider-side plumbing,
//     not for which card renders — the dock always renders whatever is in
//     `pendingApprovals` for the active chat regardless of `toolUseId`.
//
// Task 21 — commit 034edc2e9 ("fix: close approval policy bypasses") made
// hydration discard any persisted `pendingApprovals` entry whose `requestId`
// has no matching live entry in the main process's pending-approval registry
// (`reconcileLivePendingApprovals` in `stores/chat/pending-approvals.ts`,
// `pendingApprovalRequests()` in
// `apps/desktop-app/src/main/approvals/pending-approvals.ts` — see
// `docs/tool-approvals.md` "Renderer cancellation"). A fresh Electron
// process always starts with an empty pending registry, so a disk-only
// seeded approval is exactly the spoofed/stale case that fix closes and is
// always scrubbed on load. Every test below that wants an actionable card
// now goes through `launchWithSeededApproval`, which injects the event LIVE
// via `injectApprovalRequestEvent` after launch instead of pre-seeding
// `pendingApprovals` in the persisted `ChatTabsFile`. Since the dock renders
// purely from that live state and has no dependency on a transcript
// `tool_use` block, these tests also no longer seed one.
//
// Two further architectural facts, verified empirically while writing this
// spec (not assumed from the task brief), constrain what these tests can
// honestly assert:
//
// 1. `window.api.approvals.respond` cannot be monkey-patched from a spec.
//    Electron's `contextBridge.exposeInMainWorld` deep-freezes the exposed
//    `api` object (`Object.isFrozen(window.api.approvals) === true`); an
//    assignment to `window.api.approvals.respond` silently no-ops. There is
//    no spy seam for the outgoing `ApprovalRespondRequest` payload from a
//    black-box UI-automation spec.
//
// 2. Responding to a *synthetic* (seeded or live-injected) pending approval
//    NEVER persists a rule to disk, and never emits `approval:rule-added`.
//    Rule persistence (`persistScopedRule` in
//    `apps/desktop-app/src/main/approvals/approval-service.ts`) only runs
//    inside `promptForDecision`, which is only reached through a REAL
//    `createApprovalSession(...).check(...)` call from a live agent
//    tool-call. `createPendingApproval` (the main-process promise a
//    `respond` IPC call resolves) is registered only by that same real
//    call — a synthetically-injected `requestId` has no matching entry, so
//    `resolveApproval` on the main side is a silent no-op beyond clearing
//    the card client-side. Verified directly: seeding a pending approval,
//    clicking "Always in this project", and polling
//    `workspaces/<ws>/approvals.json` afterwards shows the file was never
//    created.
//
// Given those two facts:
//   - Tests that click a scoped Allow/Deny menu item assert only the
//     directly-observable, real behavior: the card clears (the renderer
//     definitely called `respondToApproval`/`window.api.approvals.respond`)
//     and reachability of every menu action. The exact outgoing behavior,
//     scope, target, and stopTurn payload for every action is covered by
//     `components/chat/__tests__/ToolApprovalCard.test.tsx`. These Electron
//     scenarios explicitly do NOT assert
//     `approvals.json` / `preferences.json` / `sessionApprovalRules` changed,
//     because that would either be a no-op assertion (always vacuously true,
//     masking a real regression forever) or an assertion that is known to be
//     false for reasons that have nothing to do with the UI under test.
//   - Real rule-persistence + Settings-table-visibility + relaunch-survival
//     coverage (which the task also asks for) is instead exercised through
//     the Settings > Approvals "Add rule" form, which calls
//     `window.api.approvals.addRule` directly — a genuinely reachable,
//     non-live-session-dependent write path — and through the new
//     `seedWorkspaceApprovals` seeder for the read side.
//   - Session-scope (`sessionApprovalRules`, "Allow for this chat") rule
//     persistence has NO settings-page equivalent (it is prompt-only) and is
//     therefore a real, documented coverage gap here: it can only be
//     exercised end-to-end from a live agent session. See the "Known gaps"
//     note at the bottom of this file.
//
// One more correction from investigation (the task brief had the provider
// association backwards): reading `apps/desktop-app/src/main/agents/
// claude-session.ts` and `claude-approval-adapter.ts` shows the CLAUDE path
// intentionally OMITS `toolUseId` on the approval event (mirroring its
// ask-user path — the SDK's `canUseTool` callback has no way to supply the
// transcript tool_use id). `apps/desktop-app/src/main/codex/
// app-server-client.ts` DOES set a deterministic `toolUseId:
// codex-<itemId>` for Codex approval requests. Since Task 20, this
// distinction no longer affects which card renders (the dock has no block-
// matching step at all) — it is purely representative fixture shape. This
// spec's "Claude flavor" tests still seed an id-less event and the "Codex
// flavor" tests still seed a `codex-<id>`-style `toolUseId`, purely to keep
// the seeded fixtures representative of what each real provider sends.
//
// Task 22 — Codex `writeStdin` callbacks are projected as callback-specific
// tool approvals without a reusable rule target. The synthetic interaction
// below verifies the resulting terminal-input card and once-only UI; the
// app-server request/response routing and command-rule isolation are covered
// by `codex-app-server-client.test.ts` because the mock LLM cannot emit a live
// Codex custom-tool terminal flow (see `tool-approvals-claude-live.spec.mjs`).
//
// Turn-timer test note: a timer written open on disk before launch is an
// interrupted turn and startup recovery correctly settles it. The turn-timer
// test therefore launches an idle chat first, then creates its open timer via
// the canonical live chat-event ingress before injecting the approval request.
// This keeps the fixture representative of a genuinely running turn without
// requiring a live provider session.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function chatTabsFilePath(userDataDir, workspaceId, worktreeId) {
  return path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chats',
    `${worktreeId}.json`,
  );
}

function readChatTabsFile(userDataDir, workspaceId, worktreeId) {
  return readJsonSafe(chatTabsFilePath(userDataDir, workspaceId, worktreeId));
}

function approvalsFilePath(userDataDir, workspaceId) {
  return path.join(userDataDir, 'workspaces', workspaceId, 'approvals.json');
}

function readWorkspaceApprovalsFile(userDataDir, workspaceId) {
  return readJsonSafe(approvalsFilePath(userDataDir, workspaceId));
}

function preferencesFilePath(userDataDir) {
  return path.join(userDataDir, 'preferences.json');
}

function readGlobalApprovalRules(userDataDir) {
  const file = readJsonSafe(preferencesFilePath(userDataDir));
  return file?.preferences?.globalApprovalRules ?? [];
}

/** Runs in the page: is `el` inside an ancestor that actually scrolls? */
function isInsideScrollableOverflow(el) {
  let node = el.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

async function dismissApprovalsUpgradeNoticeIfPresent(window) {
  const dismiss = window.getByTestId('approvals-upgrade-notice-dismiss');
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await expect(window.getByTestId('approvals-upgrade-notice')).toHaveCount(0);
  }
}

/** Seeds a demo workspace + one worktree chat tab, launches, selects the
 * worktree, then injects the given approval event LIVE via
 * `injectApprovalRequestEvent` and returns the ready app handles.
 *
 * This does NOT pre-seed `pendingApprovals` in the persisted `ChatTabsFile`
 * and rely on hydration to restore it: commit 034edc2e9 ("fix: close
 * approval policy bypasses") made hydration discard any persisted approval
 * whose `requestId` has no matching live entry in the main process's
 * pending-approval registry (`reconcileLivePendingApprovals` in
 * `stores/chat/pending-approvals.ts`, `pendingApprovalRequests()` in
 * `apps/desktop-app/src/main/approvals/pending-approvals.ts`) — see
 * `docs/tool-approvals.md` "Renderer cancellation". A fresh Electron process
 * always starts with an empty pending registry, so a disk-only seeded
 * approval is exactly the spoofed/stale case that fix closes and is always
 * scrubbed on load. Injecting the event into the running app instead (like a
 * real `approval:request` IPC event arriving mid-session) is the only way to
 * get an actionable card without driving a real agent tool call — the dock
 * renders purely from live `pendingApprovals` state and has no dependency on
 * a transcript `tool_use` block (`ToolApprovalDock.tsx`), so no block needs
 * to be seeded either. */
async function launchWithSeededApproval({
  userDataDir,
  tabId,
  event,
  viewportSize,
  injectOnLaunch = true,
}) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: event.provider,
    activeTabId: tabId,
    tabs: [{ id: tabId, title: 'Approval Interactions' }],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    ...(viewportSize ? { viewportSize } : {}),
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('panel-content-chat')).toBeVisible();
  await dismissApprovalsUpgradeNoticeIfPresent(window);
  if (injectOnLaunch) await injectApprovalRequestEvent(electronApp, event);
  return { electronApp, window, app };
}

function claudeCommandEvent({ requestId, tabId, command }) {
  return {
    requestId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: tabId,
    provider: 'claude',
    title: 'Run shell command',
    details: { kind: 'command', command },
    suggestedTarget: { kind: 'command', pattern: command },
    // Claude intentionally omits toolUseId (see file header).
  };
}

function codexCommandEvent({ requestId, tabId, command, toolUseId }) {
  return {
    requestId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: tabId,
    provider: 'codex',
    title: 'Run shell command',
    details: { kind: 'command', command },
    suggestedTarget: { kind: 'command', pattern: command },
    toolUseId,
  };
}

// CAN-5165: a long temporary worktree root, so the absolute path cannot fit
// on one line in the card at any supported width.
const FILE_CHANGE_ROOT =
  '/private/var/folders/xy/abcdefghijklmnopqrstuvwx/T/canopy-worktrees/demo-ts-pnpm-vite/demo-main';
const FILE_CHANGE_RELATIVE =
  'src/components/settings/panels/ApprovalPreferencesPanel.tsx';
const FILE_CHANGE_ABSOLUTE = `${FILE_CHANGE_ROOT}/${FILE_CHANGE_RELATIVE}`;

/** The event the Claude adapter delivers for a contained Edit or Write. */
function claudeFileChangeEvent({ requestId, tabId, title, change }) {
  return {
    requestId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: tabId,
    provider: 'claude',
    title,
    details: {
      kind: 'file-write',
      path: FILE_CHANGE_ABSOLUTE,
      displayPath: FILE_CHANGE_RELATIVE,
      change,
    },
    suggestedTarget: { kind: 'file-write', path: FILE_CHANGE_ABSOLUTE },
  };
}

/** Runs in the page: the target label renders on one line, cut with an
 * ellipsis instead of wrapping, and the card itself does not overflow. */
function fileTargetLayout() {
  const label = document.querySelector(
    '[data-testid="tool-approval-file-target-label"]',
  );
  const card = document.querySelector('[data-testid="tool-approval-card"]');
  if (!label || !card) return null;
  const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
  return {
    height: label.getBoundingClientRect().height,
    lineHeight,
    clipped: label.scrollWidth > label.clientWidth,
    cardOverflows: card.scrollWidth > card.clientWidth,
  };
}

function codexTerminalInputEvent({ requestId, tabId, approvalId }) {
  return {
    requestId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: tabId,
    provider: 'codex',
    title: 'Terminal input approval',
    details: {
      kind: 'tool',
      toolName: 'Terminal input',
      inputSummary: 'Send input to the running test watcher',
    },
    toolUseId: `codex-${approvalId}`,
  };
}

test.describe('tool approval prompt interaction matrix', () => {
  test('Claude Skill prompt displays the skill name while keeping the generic rule target', async ({}, testInfo) => {
    const TAB_ID = 'claude-skill-name';
    const SKILL_NAME = 'ud-linear:linear-agent-implement';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: {
          requestId: 'req-claude-skill-name',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: TAB_ID,
          provider: 'claude',
          title: `Claude wants to use skill ${SKILL_NAME}`,
          details: { kind: 'tool', toolName: SKILL_NAME },
          suggestedTarget: { kind: 'tool', toolName: 'Skill' },
        },
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(
        `Claude wants to use skill ${SKILL_NAME}`,
      );
      await expect(card.locator('code')).toHaveText(SKILL_NAME);

      await window.getByLabel('More allow options').click();
      const allowMenu = window.getByTestId('tool-approval-allow-menu');
      // The card names the skill; the remembered rule is all-skills. Pin both
      // halves of that split so the menu can never drift into the skill name.
      await expect(
        allowMenu.getByTestId('tool-approval-allow-menu-target'),
      ).toHaveText('Skill (all skills)');
      await expect(allowMenu).not.toContainText(SKILL_NAME);

      await window.screenshot({
        path: testInfo.outputPath('claude-skill-name-card.png'),
      });
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('Claude flavor (id-less matching): Allow once clears the card and persists nothing', async ({}, testInfo) => {
    const TAB_ID = 'claude-allow-once';
    const COMMAND = 'npm run build';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeCommandEvent({
          requestId: 'req-claude-allow-once',
          tabId: TAB_ID,
          command: COMMAND,
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      // Renders in the dock above the composer, not anchored to the
      // transcript's `tool_use` block — the dock never mounts the card
      // without the pending approval itself (N=1 here, so no count/nav).
      await expect(window.getByTestId('tool-approval-dock')).toBeVisible();
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(COMMAND);
      await expect(card).toContainText('Run shell command');
      // No `subagentId` on this event (a root-turn request) — the subagent
      // attribution badge must not render.
      await expect(
        window.getByTestId('tool-approval-subagent-badge'),
      ).toHaveCount(0);
      await expect(window.getByTestId('tool-approval-count')).toHaveCount(0);

      await window.screenshot({
        path: testInfo.outputPath('claude-allow-once-card.png'),
      });

      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);

      const tab = readChatTabsFile(
        userDataDir,
        WORKSPACE_ID,
        WORKTREE_ID,
      )?.tabs?.find((t) => t.id === TAB_ID);
      expect(tab?.sessionApprovalRules ?? []).toEqual([]);
      expect(
        readWorkspaceApprovalsFile(userDataDir, WORKSPACE_ID),
      ).toBeUndefined();
      expect(readGlobalApprovalRules(userDataDir)).toEqual([]);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('Codex writeStdin flavor shows a once-only terminal-input approval', async () => {
    const TAB_ID = 'codex-write-stdin';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: codexTerminalInputEvent({
          requestId: 'req-codex-write-stdin',
          tabId: TAB_ID,
          approvalId: 'stdin-callback-1',
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Terminal input approval');
      await expect(card).toContainText('Terminal input');
      await expect(card).toContainText(
        'Send input to the running test watcher',
      );

      await window.getByLabel('More allow options').click();
      const allowMenu = window.getByTestId('tool-approval-allow-menu');
      await expect(allowMenu).toContainText('No additional options');
      await expect(
        allowMenu.getByRole('menuitem', { name: /Always/ }),
      ).toHaveCount(0);

      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('approval menu decision and scope variants are reachable and clear independently in one live queue', async () => {
    const TAB_ID = 'approval-menu-variants';
    const scenarios = [
      {
        name: 'Claude flavor: "Always in this project"',
        provider: 'claude',
        command: 'npm test',
        openLabel: 'More allow options',
        menuName: /Always in this project/,
      },
      {
        name: 'Codex flavor: "Always in this project"',
        provider: 'codex',
        command: 'echo codex-project',
        openLabel: 'More allow options',
        menuName: /Always in this project/,
      },
      {
        name: 'Deny and stop',
        provider: 'claude',
        command: 'shutdown -h now',
        openLabel: 'More deny options',
        menuName: 'Deny and stop',
      },
      {
        name: 'Allow for this chat (session scope)',
        provider: 'claude',
        command: 'npm run lint',
        openLabel: 'More allow options',
        menuName: /Allow for this chat/,
      },
      {
        name: 'Never in this project (deny, project scope)',
        provider: 'claude',
        command: 'npm run e2e',
        openLabel: 'More deny options',
        menuName: /Never in this project/,
      },
      {
        name: 'Always everywhere (allow, global scope)',
        provider: 'claude',
        command: 'npm run format',
        openLabel: 'More allow options',
        menuName: /Always everywhere/,
      },
      {
        name: 'Never everywhere (deny, global scope)',
        provider: 'claude',
        command: 'npm run release',
        openLabel: 'More deny options',
        menuName: /Never everywhere/,
      },
    ];
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const eventFor = (scenario, index) =>
        scenario.provider === 'codex'
          ? codexCommandEvent({
              requestId: `req-menu-variant-${index}`,
              tabId: TAB_ID,
              command: scenario.command,
              toolUseId: `codex-menu-variant-${index}`,
            })
          : claudeCommandEvent({
              requestId: `req-menu-variant-${index}`,
              tabId: TAB_ID,
              command: scenario.command,
            });
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: eventFor(scenarios[0], 0),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      for (const [index, scenario] of scenarios.entries()) {
        await test.step(scenario.name, async () => {
          if (index > 0) {
            await injectApprovalRequestEvent(
              electronApp,
              eventFor(scenario, index),
            );
          }
          const card = window.getByTestId('tool-approval-card');
          await expect(card).toBeVisible();
          await expect(card).toContainText(scenario.command);
          await window.getByLabel(scenario.openLabel).click();
          const menuItem = window.getByRole('menuitem', {
            name: scenario.menuName,
          });
          await expect(menuItem).toBeVisible();
          await menuItem.click();
          await expect(card).toHaveCount(0);
          await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
        });
      }
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('multi-approval navigation: ← → cycles through pending approvals, and resolving one advances gracefully until the dock clears', async ({}, testInfo) => {
    const TAB_ID = 'multi-approval-nav';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const events = [
        claudeCommandEvent({
          requestId: 'req-nav-1',
          tabId: TAB_ID,
          command: 'npm run nav-one',
        }),
        claudeCommandEvent({
          requestId: 'req-nav-2',
          tabId: TAB_ID,
          command: 'npm run nav-two',
        }),
        codexCommandEvent({
          requestId: 'req-nav-3',
          tabId: TAB_ID,
          command: 'npm run nav-three',
          toolUseId: 'codex-nav-3',
        }),
      ];

      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        activeTabId: TAB_ID,
        tabs: [{ id: TAB_ID, title: 'Multi Approval Navigation' }],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);

      // Inject the three approvals live, in arrival order (see
      // `launchWithSeededApproval`'s doc comment for why this test cannot
      // pre-seed `pendingApprovals` on disk and rely on hydration instead).
      for (const event of events) {
        await injectApprovalRequestEvent(electronApp, event);
      }

      const dock = window.getByTestId('tool-approval-dock');
      await expect(dock).toBeVisible();
      const count = window.getByTestId('tool-approval-count');
      const card = window.getByTestId('tool-approval-card');
      await expect(count).toHaveText('Approval 1 of 3');
      await expect(card).toContainText('npm run nav-one');

      const prevButton = window.getByTestId('tool-approval-nav-prev');
      const nextButton = window.getByTestId('tool-approval-nav-next');
      await expect(prevButton).toBeDisabled();
      await expect(nextButton).toBeEnabled();

      await nextButton.click();
      await expect(count).toHaveText('Approval 2 of 3');
      await expect(card).toContainText('npm run nav-two');

      await window.screenshot({
        path: testInfo.outputPath('multi-approval-nav-second.png'),
      });

      // Allow once on the CURRENT (second, Claude-flavored) approval — the
      // dock should advance gracefully to what was previously "next" (the
      // third, Codex-flavored approval) rather than jumping back to the
      // first.
      await window.getByTestId('tool-approval-allow').click();
      await expect(count).toHaveText('Approval 2 of 2');
      await expect(card).toContainText('npm run nav-three');

      // ← is enabled again now that a previous (still-unresolved) entry
      // exists.
      await expect(prevButton).toBeEnabled();
      await prevButton.click();
      await expect(count).toHaveText('Approval 1 of 2');
      await expect(card).toContainText('npm run nav-one');

      // Resolving the currently-viewed (first) approval leaves exactly one
      // approval — the dock drops the count/nav chrome entirely.
      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-count')).toHaveCount(0);
      await expect(card).toContainText('npm run nav-three');

      // Resolving the last remaining approval unmounts the dock.
      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('Deny once clears the card and persists nothing', async () => {
    const TAB_ID = 'deny-once';
    const COMMAND = 'rm -rf build';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeCommandEvent({
          requestId: 'req-deny-once',
          tabId: TAB_ID,
          command: COMMAND,
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();

      await window.getByTestId('tool-approval-deny').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);

      expect(
        readWorkspaceApprovalsFile(userDataDir, WORKSPACE_ID),
      ).toBeUndefined();
      expect(readGlobalApprovalRules(userDataDir)).toEqual([]);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('Deny with reason: the reason textarea accepts text and Deny clears the card', async ({}, testInfo) => {
    const TAB_ID = 'deny-with-reason';
    const COMMAND = 'git push --force';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeCommandEvent({
          requestId: 'req-deny-reason',
          tabId: TAB_ID,
          command: COMMAND,
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();

      await card.getByTestId('tool-approval-reason-toggle').click();
      const reasonBox = card.getByTestId('tool-approval-reason');
      await expect(reasonBox).toBeVisible();
      await reasonBox.fill('Force-pushing to a shared branch is too risky.');
      await expect(card.getByText('Hide reason')).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('deny-with-reason-open.png'),
      });

      await window.getByTestId('tool-approval-deny').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('mcp-kind approval renders server/tool/params details', async ({}, testInfo) => {
    const TAB_ID = 'mcp-kind';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: {
          requestId: 'req-mcp-kind',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: TAB_ID,
          provider: 'claude',
          title: 'Call MCP tool',
          details: {
            kind: 'mcp',
            server: 'linear',
            tool: 'create_issue',
            paramsDisplay: '{"title":"Bug report"}',
          },
          suggestedTarget: {
            kind: 'mcp',
            server: 'linear',
            tool: 'create_issue',
          },
        },
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('linear: create_issue');
      await expect(card).toContainText('"title":"Bug report"');

      await window.screenshot({
        path: testInfo.outputPath('mcp-kind-card.png'),
      });

      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('file-write-kind approval renders the target path and reason', async ({}, testInfo) => {
    const TAB_ID = 'file-write-kind';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: {
          requestId: 'req-file-write-kind',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: TAB_ID,
          provider: 'claude',
          title: 'Write file',
          details: {
            kind: 'file-write',
            path: 'src/index.ts',
            reason: 'Outside the worktree root',
          },
          suggestedTarget: { kind: 'file-write', path: 'src/index.ts' },
        },
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('src/index.ts');
      await expect(card).toContainText('Outside the worktree root');

      await window.screenshot({
        path: testInfo.outputPath('file-write-kind-card.png'),
      });

      await window.getByTestId('tool-approval-deny').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-5165: an Edit card shows the relative target on one line, the old and new text, and the full path on request', async ({}, testInfo) => {
    const TAB_ID = 'file-change-edit';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        viewportSize: { width: 900, height: 700 },
        event: claudeFileChangeEvent({
          requestId: 'req-file-change-edit',
          tabId: TAB_ID,
          title: 'Edit file',
          change: {
            kind: 'edit',
            oldText: "const mode = 'auto';\nexport default mode;",
            newText: "const mode = 'ask';\nexport default mode;",
          },
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      const target = window.getByTestId('tool-approval-file-target');
      await expect(target).toHaveText(FILE_CHANGE_RELATIVE);
      await expect(card).not.toContainText(FILE_CHANGE_ROOT);
      const preview = window.getByTestId('approval-file-change-preview');
      await expect(preview).toContainText("const mode = 'auto';");
      await expect(preview).toContainText("const mode = 'ask';");

      const layout = await window.evaluate(fileTargetLayout);
      expect(layout).not.toBeNull();
      expect(layout.height).toBeLessThan(layout.lineHeight * 1.5);
      expect(layout.cardOverflows).toBe(false);

      // Keyboard access to the full path, without hovering.
      await target.focus();
      await window.keyboard.press('Enter');
      await expect(target).toHaveAttribute('aria-expanded', 'true');
      await expect(
        window.getByTestId('tool-approval-file-target-full'),
      ).toHaveText(FILE_CHANGE_ABSOLUTE);

      await window.screenshot({
        path: testInfo.outputPath('file-change-edit-card.png'),
      });

      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-5165: a Write card bounds its preview, expands to the last line, returns focus on Escape, and still denies', async ({}, testInfo) => {
    const TAB_ID = 'file-change-write';
    const LINES = Array.from(
      { length: 40 },
      (_, i) => `export const line${i + 1} = ${i + 1};`,
    );
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeFileChangeEvent({
          requestId: 'req-file-change-write',
          tabId: TAB_ID,
          title: 'Write file',
          change: { kind: 'write', content: LINES.join('\n') },
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const preview = window.getByTestId('approval-file-change-preview');
      await expect(preview).toContainText('Proposed content');
      await expect(preview).toContainText('line8 = 8');
      await expect(preview).not.toContainText('line40 = 40');
      await expect(preview).toContainText('32 more lines');
      await expect(
        window.getByTestId('approval-file-change-source-truncated'),
      ).toHaveCount(0);

      const expand = window.getByTestId('approval-file-change-expand');
      await expect(expand).toHaveText('View full change');
      await expand.focus();
      await window.keyboard.press('Enter');

      const modal = window.getByTestId('tool-approval-content-modal');
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Full change');
      const body = window.getByTestId('tool-approval-content-modal-body');
      await expect(body).toContainText('line40 = 40');
      await expect(body.getByTestId('approval-file-change-expand')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('tool-approval-content-modal-subtitle'),
      ).toHaveText(FILE_CHANGE_ABSOLUTE);

      await window.screenshot({
        path: testInfo.outputPath('file-change-write-modal.png'),
      });

      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await expect(expand).toBeFocused();

      await window.getByTestId('tool-approval-deny').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-5165: invisible text differences and shortened context stay reviewable', async ({}, testInfo) => {
    const tabId = 'file-change-edge-cases';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId,
        event: claudeFileChangeEvent({
          requestId: 'req-mixed-endings',
          tabId,
          title: 'Edit file',
          change: { kind: 'edit', oldText: 'a\r\nb\n', newText: 'a\nb\r\n' },
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;
      await expect(
        window.getByTestId('approval-file-change-ending'),
      ).toHaveCount(2);
      await window.getByTestId('tool-approval-deny').click();
      await injectApprovalRequestEvent(
        electronApp,
        claudeFileChangeEvent({
          requestId: 'req-blank-write',
          tabId,
          title: 'Write file',
          change: { kind: 'write', content: '\n' },
        }),
      );
      await expect(window.getByTestId('approval-file-change-blank')).toHaveText(
        'Blank line',
      );
      await window.getByTestId('tool-approval-deny').click();
      const context = 'c'.repeat(201);
      await injectApprovalRequestEvent(
        electronApp,
        claudeFileChangeEvent({
          requestId: 'req-context-edit',
          tabId,
          title: 'Edit file',
          change: {
            kind: 'edit',
            oldText: `${context}\nold`,
            newText: `${context}\nnew`,
          },
        }),
      );
      const expand = window.getByTestId('approval-file-change-expand');
      await expect(expand).toHaveText('View full change');
      await expand.focus();
      await window.keyboard.press('Enter');
      const modal = window.getByTestId('tool-approval-content-modal');
      await expect(modal).toContainText(context);
      await window.screenshot({
        path: testInfo.outputPath('file-change-context-modal.png'),
      });
      // Resolution while open removes the portaled content with its card.
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'approval:cancelled',
          { requestId: 'req-context-edit' },
        );
      });
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expect(modal).toHaveCount(0);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-5165: a capped change warns in the card and the modal and never claims to show the full change', async ({}, testInfo) => {
    const TAB_ID = 'file-change-capped';
    const LINES = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeFileChangeEvent({
          requestId: 'req-file-change-capped',
          tabId: TAB_ID,
          title: 'Write file',
          change: { kind: 'write', content: LINES.join('\n'), truncated: true },
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(
        card.getByTestId('approval-file-change-source-truncated'),
      ).toBeVisible();
      const expand = window.getByTestId('approval-file-change-expand');
      await expect(expand).toHaveText('View available change');
      await expand.click();

      const modal = window.getByTestId('tool-approval-content-modal');
      await expect(modal).toContainText('Available change');
      await expect(modal).not.toContainText('Full change');
      await expect(
        modal.getByTestId('approval-file-change-source-truncated'),
      ).toBeVisible();
      await expect(modal).toContainText('row 30');

      await window.screenshot({
        path: testInfo.outputPath('file-change-capped-modal.png'),
      });

      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await window.getByTestId('tool-approval-deny').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('a live approval:request event pauses the turn timer; synthetic respond does not resume it (hardened contract)', async ({}, testInfo) => {
    const TAB_ID = 'turn-timer-live';
    const COMMAND = 'npm run migrate';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        activeTabId: TAB_ID,
        tabs: [{ id: TAB_ID, title: 'Turn Timer Live' }],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);

      const startedAt = Date.now();
      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        data: {
          type: 'claude_terminal_transcript_sync',
          importedEventCount: 2,
          messages: [
            {
              id: 'turn-timer-call-message-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'turn-timer-call-1',
                  toolName: 'Bash',
                  input: JSON.stringify({ command: COMMAND }),
                },
              ],
              timestamp: startedAt,
            },
            {
              id: 'turn-timer-message-1',
              role: 'system',
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt,
                  completedAt: null,
                },
              ],
              timestamp: startedAt,
            },
          ],
        },
      });

      const timer = window.getByTestId('turn-timer');
      // Give the lazy-loaded ChatMessageList time to mount the live-injected
      // transcript before asserting its initial (pre-injection) state.
      await expect(timer).toHaveAttribute('data-state', 'live', {
        timeout: 15_000,
      });

      await injectApprovalRequestEvent(electronApp, {
        requestId: 'req-turn-timer-live',
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        provider: 'claude',
        title: 'Run shell command',
        details: { kind: 'command', command: COMMAND },
        suggestedTarget: { kind: 'command', pattern: COMMAND },
        // Claude omits toolUseId; matches the tab's single unresolved block.
      });

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(COMMAND);
      await expect(timer).toHaveAttribute('data-state', 'paused');

      await window.screenshot({
        path: testInfo.outputPath('turn-timer-paused.png'),
      });

      // Commit c4585cb7b ("fix: harden tool approval policy") made
      // `approval:respond` return the main-side `resolveApproval` boolean,
      // and the renderer slice (`respondToApproval`/`dismissApproval` in
      // `stores/chat/slices/approvals.ts`) now gates
      // `resumeApprovalTurnTimer` on that result being `true`. Card removal
      // stays unconditional either way. This event was injected via
      // `injectApprovalRequestEvent` — a synthetic renderer-side event with
      // no corresponding main-process `createPendingApproval` entry — so
      // `resolveApproval` for its `requestId` is a no-op that resolves
      // `false`: the card clears (the renderer definitely called
      // `respond`), but the timer intentionally does NOT resume. That is
      // the hardened contract working as intended (a forged/stale
      // `requestId` must not be treated as a real resolution); it is not a
      // regression. Real-path resume (a genuine `createApprovalSession(...)
      // .check(...)` pending entry) is covered by
      // `tool-approvals-claude-live.spec.mjs` and by the unit test "resumes
      // the paused turn timer when respondToApproval is called".
      await window.getByTestId('tool-approval-allow').click();
      await expect(card).toHaveCount(0);
      await expect(timer).toHaveAttribute('data-state', 'paused');
      // Assert the paused state is stable (not a transient flip mid-toggle)
      // by re-checking after the card has fully settled away.
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
      await expect(timer).toHaveAttribute('data-state', 'paused');
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-3083: an approval:auto-resolved event clears the dock without a click, resumes the timer, and renders the receipt', async ({}, testInfo) => {
    const TAB_ID = 'auto-resolve-live';
    const COMMAND = 'ls apps/web/src/app/';
    const REQUEST_ID = 'req-auto-resolve-live';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        activeTabId: TAB_ID,
        tabs: [{ id: TAB_ID, title: 'Auto Resolve Live' }],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();
      await dismissApprovalsUpgradeNoticeIfPresent(window);

      const startedAt = Date.now();
      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        data: {
          type: 'claude_terminal_transcript_sync',
          importedEventCount: 2,
          messages: [
            {
              id: 'auto-resolve-call-message-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'auto-resolve-call-1',
                  toolName: 'Bash',
                  input: JSON.stringify({ command: COMMAND }),
                },
              ],
              timestamp: startedAt,
            },
            {
              id: 'auto-resolve-timer-message-1',
              role: 'system',
              blocks: [{ type: 'turn_timer', startedAt, completedAt: null }],
              timestamp: startedAt,
            },
          ],
        },
      });

      const timer = window.getByTestId('turn-timer');
      await expect(timer).toHaveAttribute('data-state', 'live', {
        timeout: 15_000,
      });

      await injectApprovalRequestEvent(electronApp, {
        requestId: REQUEST_ID,
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        provider: 'claude',
        title: 'Run shell command',
        details: { kind: 'command', command: COMMAND },
        suggestedTarget: { kind: 'command', pattern: COMMAND },
      });

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(COMMAND);
      await expect(timer).toHaveAttribute('data-state', 'paused');

      // The user widens the mode in the composer. Main re-evaluates the
      // standing request, finds the new mode would not have asked, resolves it
      // as approved and tells the renderer. Nothing below clicks the card.
      //
      // Unlike the synthetic-respond path in the turn-timer test above, the
      // timer DOES resume here: for this event resume is renderer-owned (main
      // has already settled the request), so it is not gated on a main-side
      // `resolveApproval` boolean that a synthetic requestId cannot satisfy.
      await injectApprovalAutoResolvedEvent(electronApp, {
        requestId: REQUEST_ID,
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: TAB_ID,
        reason: 'mode-change',
        mode: 'full-access',
        previousMode: 'ask',
        resolutionMessage: {
          id: 'auto-resolve-receipt-1',
          role: 'system',
          timestamp: Date.now(),
          blocks: [
            {
              type: 'approval_resolution_info',
              timestamp: Date.now(),
              resolvedBy: 'mode-change',
              mode: 'full-access',
              previousMode: 'ask',
              titles: [COMMAND],
            },
          ],
        },
      });

      await expect(card).toHaveCount(0);
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
      await expect(timer).toHaveAttribute('data-state', 'live');

      await expect(
        window.getByText('Approved by switching to Full access'),
      ).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('approval-auto-resolved.png'),
      });
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('Settings > Approvals: adding global and project rules persists to disk and survives relaunch', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

    const first = await launchCanopy({ userDataDir });
    try {
      const window = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();

      // Global rule.
      await window
        .getByTestId('approval-add-rule-global-value')
        .fill('npm run deploy*');
      await window.getByTestId('approval-add-rule-global').click();
      await expect(window.getByTestId('approval-rules-table')).toContainText(
        'npm run deploy*',
      );

      // Project rule (workspace selector defaults to the only seeded demo
      // workspace). The behavior/kind `<select>`s in `AddRuleForm` carry no
      // `data-testid` (only the pattern input and submit button do), so this
      // leaves both at their defaults (allow / command) rather than risking
      // an ambiguous `getByLabel` match across the global and project forms.
      await expect(
        window.getByTestId('approval-project-workspace'),
      ).toHaveAttribute('data-value', WORKSPACE_ID);
      await window
        .getByTestId('approval-add-rule-project-value')
        .fill('git push --force*');
      await window.getByTestId('approval-add-rule-project').click();
      await expect(
        window.getByTestId('approval-project-rules-table'),
      ).toContainText('git push --force*');

      await window.screenshot({
        path: testInfo.outputPath('settings-approvals-rules-added.png'),
      });

      await expect
        .poll(() => readGlobalApprovalRules(userDataDir))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              behavior: 'allow',
              target: { kind: 'command', pattern: 'npm run deploy*' },
              origin: 'settings',
            }),
          ]),
        );
      await expect
        .poll(
          () =>
            readWorkspaceApprovalsFile(userDataDir, WORKSPACE_ID)?.rules ?? [],
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              behavior: 'allow',
              target: { kind: 'command', pattern: 'git push --force*' },
              origin: 'settings',
            }),
          ]),
        );
    } finally {
      await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    }

    const second = await launchCanopy({ userDataDir });
    try {
      const window = await second.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();

      await expect(window.getByTestId('approval-rules-table')).toContainText(
        'npm run deploy*',
      );
      await expect(
        window.getByTestId('approval-project-rules-table'),
      ).toContainText('git push --force*');

      await window.screenshot({
        path: testInfo.outputPath('settings-approvals-rules-persisted.png'),
      });
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  });

  test('Settings > Approvals: a rule pre-seeded via seedWorkspaceApprovals renders in the project table at launch', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        rules: [
          buildApprovalRule({
            behavior: 'deny',
            target: { kind: 'command', pattern: 'rm -rf *' },
            id: 'seeded-deny-rm',
            origin: 'settings',
          }),
        ],
      });

      const launched = await launchCanopy({ userDataDir });
      electronApp = launched.electronApp;
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();

      // The group also holds the new-rule form, whose behavior dropdown
      // names Deny too, so read the seeded rule's own row.
      const seededRule = window
        .getByTestId('approval-project-rules-table')
        .locator('[data-testid^="approval-rule-row-"]')
        .filter({ hasText: 'rm -rf *' });
      await expect(seededRule).toContainText('Deny');

      await window.screenshot({
        path: testInfo.outputPath('settings-approvals-seeded-rule.png'),
      });
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  // Task 19 — subagent approval attribution (`ApprovalRequestEvent.subagentId`,
  // rendered by `ToolApprovalCard.tsx`'s "Subagent request" badge). Since
  // Task 20 this card renders inside `ToolApprovalDock.tsx` rather than the
  // transcript — assert the dock wrapper too, not just the card.
  test('a pending approval with subagentId set renders the subagent attribution badge', async ({}, testInfo) => {
    const TAB_ID = 'codex-subagent-approval';
    const COMMAND = 'echo from-subagent';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: {
          ...codexCommandEvent({
            requestId: 'req-codex-subagent',
            tabId: TAB_ID,
            command: COMMAND,
            toolUseId: 'codex-sub-item-1',
          }),
          subagentId: 'sub-thread-1',
        },
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      await expect(window.getByTestId('tool-approval-dock')).toBeVisible();
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(
        window.getByTestId('tool-approval-subagent-badge'),
      ).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('subagent-approval-badge.png'),
      });

      await window.getByTestId('tool-approval-allow').click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expect(window.getByTestId('tool-approval-dock')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  // -------------------------------------------------------------------------
  // CAN-3001 — approval content and menu reachability.
  //
  // Two reports from the same Slack thread: (1) the allow/deny dropdowns were
  // clipped behind the composer and the bottom of the window, and (2) with a
  // large inline script in the approval, the options were not reachable at
  // all. Root causes, both in `ToolApprovalCard.tsx`: the menus were
  // `absolute top-full` popovers opening DOWNWARD from a card docked at the
  // window bottom, and the card rendered the full command unbounded while
  // repeating the suggested rule target under every menu row. The fix moves
  // both menus onto the shared portaled `FloatingMenu`, bounds the in-card
  // preview, shows the rule target once (truncated) in the menu header, and
  // offers the full text through a scrollable `DialogModal`.
  // -------------------------------------------------------------------------

  test('CAN-3001: a large inline script keeps the actions reachable, keeps the menus to their options, and opens the full script in a scrollable modal', async ({}, testInfo) => {
    const TAB_ID = 'claude-large-script';
    const SCRIPT_LINES = Array.from(
      { length: 200 },
      (_, i) => `print("script line ${i + 1}")`,
    );
    // Inline interpreter payloads keep the complete command as the suggested
    // rule pattern (`suggestedCommandPattern`), so the menu target is just as
    // large as the command itself — exactly the reported shape.
    const COMMAND = `python3 -c '${SCRIPT_LINES.join('\n')}'`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeCommandEvent({
          requestId: 'req-claude-large-script',
          tabId: TAB_ID,
          command: COMMAND,
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('script line 1');
      // The in-card preview is bounded: the tail of the script is only in
      // the modal, and the action row is fully on screen.
      await expect(card).not.toContainText('script line 200');
      await expect(window.getByTestId('tool-approval-allow')).toBeInViewport({
        ratio: 1,
      });
      await expect(window.getByTestId('tool-approval-deny')).toBeInViewport({
        ratio: 1,
      });

      // Card → full-content modal with a scroll container.
      await window.getByTestId('tool-approval-content-view-full').click();
      const modal = window.getByTestId('tool-approval-content-modal');
      await expect(modal).toBeVisible();
      const modalBody = window.getByTestId('tool-approval-content-modal-body');
      await expect(modalBody).toContainText('script line 200');
      expect(await modalBody.evaluate(isInsideScrollableOverflow)).toBe(true);
      await window.screenshot({
        path: testInfo.outputPath('large-script-modal.png'),
      });
      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
      await expect(card).toBeVisible();

      // Allow menu: every option on screen, the target shown once and
      // truncated in the header, never repeated under the rows.
      await window.getByLabel('More allow options').click();
      const allowMenu = window.getByTestId('tool-approval-allow-menu');
      await expect(allowMenu).toBeVisible();
      await expect(allowMenu).toBeInViewport({ ratio: 1 });
      await expect(allowMenu).not.toContainText('script line 200');
      await expect(
        allowMenu.getByTestId('tool-approval-allow-menu-target'),
      ).toContainText('python3 -c');
      for (const name of [
        'Allow for this chat',
        'Always in this project',
        'Always everywhere',
      ]) {
        await expect(
          allowMenu.getByRole('menuitem', { name, exact: true }),
        ).toBeInViewport({ ratio: 1 });
      }
      await window.screenshot({
        path: testInfo.outputPath('large-script-allow-menu.png'),
      });
      await allowMenu.getByTestId('tool-approval-allow-menu-view-full').click();
      await expect(modal).toBeVisible();
      await expect(window.getByTestId('tool-approval-allow-menu')).toHaveCount(
        0,
      );
      await expect(modalBody).toContainText('script line 200');
      await window.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);

      // Deny menu: same contract.
      await window.getByLabel('More deny options').click();
      const denyMenu = window.getByTestId('tool-approval-deny-menu');
      await expect(denyMenu).toBeVisible();
      await expect(denyMenu).toBeInViewport({ ratio: 1 });
      await expect(denyMenu).not.toContainText('script line 200');
      for (const name of [
        'Never in this project',
        'Never everywhere',
        'Deny and stop',
      ]) {
        await expect(
          denyMenu.getByRole('menuitem', { name, exact: true }),
        ).toBeInViewport({ ratio: 1 });
      }
      await window.keyboard.press('Escape');
      await expect(denyMenu).toHaveCount(0);

      // The scoped options still resolve the approval.
      await window.getByLabel('More allow options').click();
      await window
        .getByRole('menuitem', { name: 'Always in this project', exact: true })
        .click();
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('CAN-3001: allow and deny menus open above their triggers in a short window', async ({}, testInfo) => {
    const TAB_ID = 'claude-short-window';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        viewportSize: { width: 1100, height: 600 },
        event: claudeCommandEvent({
          requestId: 'req-claude-short-window',
          tabId: TAB_ID,
          command: 'npm run build',
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      await expect(window.getByTestId('tool-approval-card')).toBeVisible();

      await window.getByLabel('More allow options').click();
      const allowMenu = window.getByTestId('tool-approval-allow-menu');
      await expect(allowMenu).toBeVisible();
      await expect(allowMenu).toBeInViewport({ ratio: 1 });
      const allowTriggerBox = await window
        .getByLabel('More allow options')
        .boundingBox();
      const allowMenuBox = await allowMenu.boundingBox();
      expect(allowTriggerBox).not.toBeNull();
      expect(allowMenuBox).not.toBeNull();
      expect(allowMenuBox.y + allowMenuBox.height).toBeLessThanOrEqual(
        allowTriggerBox.y,
      );
      const allowItems = allowMenu.getByRole('menuitem');
      await expect(allowItems).toHaveCount(3);
      for (let i = 0; i < 3; i += 1) {
        await expect(allowItems.nth(i)).toBeInViewport({ ratio: 1 });
      }
      await window.screenshot({
        path: testInfo.outputPath('short-window-allow-menu.png'),
      });
      await window.getByLabel('More allow options').click();
      await expect(allowMenu).toHaveCount(0);

      await window.getByLabel('More deny options').click();
      const denyMenu = window.getByTestId('tool-approval-deny-menu');
      await expect(denyMenu).toBeVisible();
      await expect(denyMenu).toBeInViewport({ ratio: 1 });
      const denyTriggerBox = await window
        .getByLabel('More deny options')
        .boundingBox();
      const denyMenuBox = await denyMenu.boundingBox();
      expect(denyTriggerBox).not.toBeNull();
      expect(denyMenuBox).not.toBeNull();
      expect(denyMenuBox.y + denyMenuBox.height).toBeLessThanOrEqual(
        denyTriggerBox.y,
      );
      const denyItems = denyMenu.getByRole('menuitem');
      await expect(denyItems).toHaveCount(3);
      for (let i = 0; i < 3; i += 1) {
        await expect(denyItems.nth(i)).toBeInViewport({ ratio: 1 });
      }
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });

  test('approval menus close on Escape independently of placement geometry', async () => {
    const TAB_ID = 'claude-menu-escape';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-approval-interactions-'),
    );
    let electronApp;
    try {
      const launched = await launchWithSeededApproval({
        userDataDir,
        tabId: TAB_ID,
        event: claudeCommandEvent({
          requestId: 'req-claude-menu-escape',
          tabId: TAB_ID,
          command: 'npm run build',
        }),
      });
      electronApp = launched.electronApp;
      const { window } = launched;

      await window.getByLabel('More allow options').click();
      const allowMenu = window.getByTestId('tool-approval-allow-menu');
      await expect(allowMenu).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(allowMenu).toHaveCount(0);
    } finally {
      if (electronApp) {
        await closeCanopy(electronApp, userDataDir);
      } else {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Known gap (documented, not silently skipped): session-scope rule
// persistence ("Allow for this chat" -> `sessionApprovalRules` landing on the
// tab file) cannot be exercised synthetically. It is created only by
// `persistScopedRule('session', ...)` inside a real
// `createApprovalSession(...).check(...)` call, which pushes the rule onto
// the live session's in-memory `ctx.sessionRules` and emits
// `approval:rule-added` — there is no seed file or injectable event for
// "this session already granted rule X." The "Remaining scoped menu
// actions..." test above proves the session-scope menu item is reachable and
// clears the card; true end-to-end coverage of the persisted-and-survives-
// relaunch contract needs a live agent turn (covered by
// `tool-approvals-claude-live.spec.mjs`; see that spec's header for why the
// equivalent Codex live turn is not currently automatable).
// ---------------------------------------------------------------------------

// CAN-4997: settled destinations and native keyboard activation, without live agents.
test.describe('CAN-4997 approval keyboard focus', () => {
  let electronApp;
  let window;
  let userDataDir;
  const tabId = 'keyboard-approvals';
  const event = (id, command = `echo ${id}`) =>
    claudeCommandEvent({ requestId: id, tabId, command });
  const editor = () =>
    window.locator('[data-chat-textarea][contenteditable="true"]');
  const card = () => window.getByTestId('tool-approval-card');
  const primary = () => window.getByTestId('tool-approval-allow');

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-keyboard-approvals-'),
    );
    const launched = await launchWithSeededApproval({
      userDataDir,
      tabId,
      event: event('unused'),
      injectOnLaunch: false,
    });
    electronApp = launched.electronApp;
    window = launched.window;
    await expect(editor()).toBeVisible();
    await editor().focus();
    await expect(editor()).toBeFocused();
  });

  test.afterEach(async () => {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
    electronApp = undefined;
  });

  test('three approvals need one native Enter each, then restore the composer and placeholder', async () => {
    for (const id of ['first', 'second', 'third'])
      await injectApprovalRequestEvent(electronApp, event(id));
    await expect(window.locator('[data-slate-placeholder]')).toHaveText(
      'Answer the approval above first',
    );
    for (const id of ['first', 'second', 'third']) {
      await expect(card().locator('code')).toHaveText(`echo ${id}`);
      await expect(primary()).toBeFocused();
      await window.keyboard.press('Enter');
    }
    await expect(card()).toHaveCount(0);
    await expect(editor()).toBeFocused();
    await expect(window.locator('[data-slate-placeholder]')).not.toHaveText(
      'Answer the approval above first',
    );
  });

  test('draft and another editor keep focus while arrivals are announced', async () => {
    await editor().fill('wip');
    await injectApprovalRequestEvent(electronApp, event('draft'));
    await expect(card()).toBeVisible();
    await expect(editor()).toBeFocused();
    await expect(editor()).toHaveText('wip');
    await expect(window.getByTestId('tool-approval-announcer')).toContainText(
      'echo draft',
    );
    // A second editable surface outside the composer uses the same real guard.
    await window.evaluate(() => {
      const field = document.createElement('textarea');
      field.dataset.testid = 'other-editable';
      document.body.append(field);
      field.focus();
    });
    await injectApprovalAutoResolvedEvent(electronApp, {
      requestId: 'draft',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: tabId,
      reason: 'mode-change',
      mode: 'full-access',
      previousMode: 'ask',
    });
    await injectApprovalRequestEvent(electronApp, event('other-editor'));
    await expect(card().locator('code')).toHaveText('echo other-editor');
    await expect(window.getByTestId('other-editable')).toBeFocused();
    await expect(editor()).toHaveText('wip');
  });

  test('Tab reaches the labelled reason field and the platform chord denies then hands off', async () => {
    await injectApprovalRequestEvent(electronApp, event('deny-first'));
    await injectApprovalRequestEvent(electronApp, event('allow-next'));
    await expect(primary()).toBeFocused();
    const toggle = window.getByTestId('tool-approval-reason-toggle');
    for (
      let step = 0;
      step < 8 &&
      !(await toggle.evaluate((el) => el === document.activeElement));
      step += 1
    ) {
      await window.keyboard.press('Tab');
    }
    await expect(toggle).toBeFocused();
    await window.keyboard.press('Enter');
    const reason = window.getByTestId('tool-approval-reason');
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAccessibleName('Reason for denying');
    await window.keyboard.type('Please use the safer command');
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter',
    );
    await expect(card().locator('code')).toHaveText('echo allow-next');
    await expect(primary()).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(card()).toHaveCount(0);
    await expect(editor()).toBeFocused();
  });

  test('external removal preserves a still-enabled navigation button, then repairs a disappearing one', async () => {
    for (const id of ['one', 'two', 'three', 'four'])
      await injectApprovalRequestEvent(electronApp, event(id));
    const next = window.getByTestId('tool-approval-nav-next');
    await next.focus();
    await window.keyboard.press('Enter');
    await expect(card().locator('code')).toHaveText('echo two');
    await expect(next).toBeFocused();
    for (const id of ['two', 'four', 'one']) {
      await injectApprovalAutoResolvedEvent(electronApp, {
        requestId: id,
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: tabId,
        reason: 'mode-change',
        mode: 'full-access',
        previousMode: 'ask',
      });
      await expect(card().locator('code')).toHaveText('echo three');
      if (id === 'two') await expect(next).toBeFocused();
    }
    await expect(primary()).toBeFocused();
  });

  test('external removal of the displayed middle approval repairs a disabled navigation button', async () => {
    for (const id of ['one', 'two', 'three'])
      await injectApprovalRequestEvent(electronApp, event(id));
    const next = window.getByTestId('tool-approval-nav-next');
    await next.focus();
    await window.keyboard.press('Enter');
    await expect(card().locator('code')).toHaveText('echo two');
    await expect(next).toBeFocused();

    await injectApprovalAutoResolvedEvent(electronApp, {
      requestId: 'two',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: tabId,
      reason: 'mode-change',
      mode: 'full-access',
      previousMode: 'ask',
    });

    await expect(card().locator('code')).toHaveText('echo three');
    await expect(next).toBeDisabled();
    await expect(primary()).toBeFocused();
  });

  test('deferred startup focus cannot undo an approval arrival handoff', async () => {
    await window.evaluate(() => {
      const raf = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      const callbacks = new Map();
      let next = 1;
      window.requestAnimationFrame = (callback) => {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        callbacks.delete(id);
      };
      window.__releaseApprovalStartupFrames = () => {
        window.requestAnimationFrame = raf;
        window.cancelAnimationFrame = cancel;
        for (const callback of callbacks.values()) callback(performance.now());
        callbacks.clear();
      };
    });
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const activeRoot = window
      .locator('[data-chat-composer-root]')
      .filter({ has: editor() });
    await expect(activeRoot).not.toHaveAttribute(
      'data-chat-composer-tab-id',
      tabId,
    );
    const activeChat = await activeRoot.getAttribute(
      'data-chat-composer-tab-id',
    );
    await editor().focus();
    await injectApprovalRequestEvent(electronApp, {
      ...event('startup'),
      chatId: activeChat,
    });
    await expect(primary()).toBeFocused();
    await window.evaluate(() => window.__releaseApprovalStartupFrames());
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(card().locator('code')).toHaveText('echo startup');
    await expect(primary()).toBeFocused();
  });

  test('menu and full-content modal close restore live targets and removal hands off', async () => {
    await injectApprovalRequestEvent(
      electronApp,
      event('long', 'echo ' + 'x'.repeat(900)),
    );
    await injectApprovalRequestEvent(electronApp, event('next'));
    const menuTrigger = window.getByLabel('More allow options', {
      exact: true,
    });
    await menuTrigger.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('tool-approval-allow-menu')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menuTrigger).toBeFocused();
    const view = window.getByTestId('tool-approval-content-view-full');
    await view.focus();
    await window.keyboard.press('Enter');
    await expect(
      window.getByTestId('tool-approval-content-modal'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(view).toBeFocused();
    await window.keyboard.press('Enter');
    await injectApprovalAutoResolvedEvent(electronApp, {
      requestId: 'long',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: tabId,
      reason: 'mode-change',
      mode: 'full-access',
      previousMode: 'ask',
    });
    await expect(card().locator('code')).toHaveText('echo next');
    await expect(primary()).toBeFocused();
  });

  test('browser-file requests focus Choose files and Decline restores the composer', async () => {
    await injectApprovalRequestEvent(electronApp, {
      ...event('files'),
      title: 'Choose upload files',
      suggestedTarget: undefined,
      details: {
        kind: 'browser-file-request',
        origin: 'https://upload.example',
        multiple: true,
      },
    });
    const choose = window.getByTestId('tool-approval-choose-files');
    await expect(choose).toBeFocused();
    // Real picker cancellation is covered in browser-files.spec.mjs. Synthetic
    // requests have no picker callback; assert only the reachable Decline path.
    await expect(choose).toBeEnabled();
    await window.getByTestId('tool-approval-decline-files').click();
    await expect(card()).toHaveCount(0);
    await expect(editor()).toBeFocused();
  });
});
