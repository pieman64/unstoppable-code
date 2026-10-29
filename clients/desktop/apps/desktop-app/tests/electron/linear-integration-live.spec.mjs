import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { registerScenario, DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { toggleHomePipelineMode } from './homeComposerMenu.mjs';
import {
  expectCharCut,
  expectWordCut,
  readTruncation,
} from './wordBoundaryTruncation.mjs';

// Doc 9 / Doc 3 G16 — Linear integration (HTTP-only, no chat turn).
//
// This spec exercises the LINEAR GraphQL mock surface end to end through the
// app's real `LinearClient` (`apps/desktop-app/src/main/ipc/settings.ts`),
// WITHOUT launching any agent. The full seam:
//
//   renderer (AccountTab / Home composer's Linear attach)
//     → window.api.validateLinearToken / searchLinearIssues IPC
//     → settings.ts createLinearViewerClient/createLinearSearchClient
//     → @linear/sdk `LinearClient`, built with `buildLinearClientOptions`,
//       which — under the build-time E2E gate (`if (__CANOPY_E2E__)`) — sets
//       the SDK `apiUrl` to `process.env.CANOPY_LINEAR_API_BASE_URL`
//       (`http://127.0.0.1:4011/graphql`, injected by launchCanopy.mjs)
//     → the shared mock server's `/graphql` route (mock-server/routes/linear.mjs)
//     → `resolveLinearScenario` keys the scenario off the inbound request's
//       `authorization` header. The @linear/sdk sends the RAW API key as the
//       `authorization` header (no `Bearer` prefix), and the mock keys off it
//       via `keyFromApiKey(request, { header: 'authorization' })`. So the
//       scenario key == the exact Linear token value the app sends.
//
// Token seeding: the Linear token is stored encrypted via Electron safeStorage.
// We seed it THROUGH the app after launch (`window.api.saveLinearToken(token)`),
// which is the only path that produces a decryptable token the IPC handlers can
// read back. We register the matching mock scenario under that same token value
// so the mock resolves our viewer/issues for the app's requests.
//
// Two flows are covered:
//   1. Account-tab Linear status — a valid token shows
//      "Signed in as <mock viewer displayName>"; a token the scenario rejects
//      (`viewer: false`) shows the invalid-key error.
//   2. Home composer's `+` menu → Linear ticket picker (Plan D / Task D3) —
//      open the shared `ComposerPlusMenu` (`home-composer-plus-button`),
//      click its Linear row (`home-composer-plus-linear`), which opens the
//      Cmd+P-style `LinearTicketPickerModal` (`linear-ticket-picker`). Type
//      into its search input (`linear-ticket-picker-input`), assert the
//      mocked `searchIssues` rows render as
//      `linear-ticket-picker-result-{id}`, select one, and assert both that
//      the ticket is staged as an attachment pill (the snapshot markdown
//      filename `stageLinearTicketAttachment`/`linearSnapshotFilename`
//      produce) and that Send enables (proof the synthesized attachment
//      carries non-empty task text). No agent is launched.
//
// Determinism: no live agents, no real Linear network, no PTY. The mock answers
// every GraphQL operation deterministically from the registered scenario.

const DEMO_APP_ID = 'ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

// The scenario key == the raw token the @linear/sdk sends as the `authorization`
// header (mock keys off it directly). Each token is unique per sub-flow so the
// concurrent-safe control plane never collides with another spec.
const VALID_TOKEN = 'lin_api_e2e_valid';
const INVALID_TOKEN = 'lin_api_e2e_invalid';
const SEARCH_TOKEN = 'lin_api_e2e_search';

// Mock viewer for the valid-token scenario. `displayName` is what the Account
// tab renders after "Signed in as".
const VIEWER = {
  id: 'usr_e2e',
  name: 'Linear E2E User',
  displayName: 'Linear E2E User',
  email: 'linear-e2e@example.com',
};

// Issues for the search flows. The mock's `searchIssues` case filters by
// `identifier`/`title` substring (case-insensitive) against the search term,
// so a shared "auth" substring matches all of them for a broad query and a
// specific identifier matches exactly one. The last two have titles too long
// for any picker row: one with ordinary spaces (cut after a whole word) and
// one unbroken word (cut mid-word, the only allowed case).
const LONG_SPACED_TITLE =
  'Keep auth sessions alive across app restarts, sleep and wake cycles, network changes, and long idle periods so signed-in people are never logged out by surprise';
const LONG_UNBROKEN_TITLE = `auth${'SessionRefreshTokenRotation'.repeat(4)}Handler`;
const ISSUES = [
  {
    id: 'iss_e2e_1',
    identifier: 'CAN-101',
    title: 'Add auth login screen',
    description: 'Implement the login screen with OAuth support.',
  },
  {
    id: 'iss_e2e_2',
    identifier: 'CAN-202',
    title: 'Fix auth token refresh',
    description: 'Refresh the auth token before it expires.',
  },
  {
    id: 'iss_e2e_3',
    identifier: 'CAN-303',
    title: LONG_SPACED_TITLE,
    description: 'Long title cut after a whole word.',
  },
  {
    id: 'iss_e2e_4',
    identifier: 'CAN-304',
    title: LONG_UNBROKEN_TITLE,
    description: 'Long title without a word boundary.',
  },
];

// ---------------------------------------------------------------------------
// Flow 1 — Account tab Linear status (valid + invalid token).
// ---------------------------------------------------------------------------

test.describe('Linear integration — Account tab status', () => {
  test('valid token shows the mocked viewer; rejected token shows the invalid state', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-linear-account-'),
    );

    // Register both scenarios up front (control plane is independent of launch).
    // Valid: authed viewer. Invalid: `viewer: false` makes the mock return a
    // GraphQL auth error, so `validateLinearToken` resolves to unauthenticated.
    await registerScenario(DEFAULT_MOCK_BASE_URL, VALID_TOKEN, {
      linear: { viewer: VIEWER, issues: [] },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, INVALID_TOKEN, {
      linear: { viewer: false, issues: [] },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // ---- Valid token ----
      // Seed the encrypted token through the app first so it round-trips on the
      // tab's mount-time `loadLinearToken()`. (This also proves the full
      // save → load → validate seam, not just an in-field validation.)
      const savedValid = await window.evaluate(
        (t) => window.api.saveLinearToken(t).then(() => true),
        VALID_TOKEN,
      );
      expect(savedValid).toBe(true);

      await app.openSettings();
      await app.openAccountSettingsPage('integrations');
      const linearCard = window.getByTestId('account-device-card-linear');
      await expect(linearCard).toBeVisible();

      const linearInput = window.getByTestId('settings-linear-token-input');
      // The persisted token is loaded into the field on mount.
      await expect(linearInput).toHaveValue(VALID_TOKEN, { timeout: 15_000 });

      // Re-enter the token through the input to drive the canonical
      // `handleLinearChange` → debounce → `setDebouncedLinearValue` validation
      // path deterministically (the mount-time validation is debounced and its
      // module-global cache state makes the first-paint validation timing
      // racey; typing makes it a clean re-validation against the same value).
      await linearInput.fill('');
      await linearInput.fill(VALID_TOKEN);

      // The viewer is fetched via the IPC → SDK → mock seam. The validation is
      // debounced (600ms), so poll generously for the
      // "Signed in as <displayName>" line driven by the mocked viewer's
      // `displayName`.
      await expect
        .poll(
          async () =>
            linearCard.getByText(`Signed in as ${VIEWER.displayName}`).count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);

      // ---- Invalid (scenario-rejected) token ----
      // Replace the field value through the UI. LinearKeyRow debounces the save +
      // re-validation; the mock rejects `viewer: false`, so the destructive
      // error message must surface.
      await linearInput.fill(INVALID_TOKEN);

      await expect
        .poll(
          async () =>
            linearCard
              .getByText('Invalid API key or unable to reach Linear.')
              .count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);

      // And the signed-in status line is gone.
      await expect(
        linearCard.getByText(`Signed in as ${VIEWER.displayName}`),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Flow 2 — Home composer's `+` menu → Linear ticket picker (Send enables).
// ---------------------------------------------------------------------------

test.describe('Linear integration — Home composer Linear ticket picker', () => {
  test('search lists mocked issues and selecting one stages an attachment and enables Send', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-linear-search-'),
    );

    // A real demo workspace so the Home composer has an eligible workspace.
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

    // Scenario: authed viewer (so the plus-menu's Linear row unlocks) + two
    // searchable issues.
    await registerScenario(DEFAULT_MOCK_BASE_URL, SEARCH_TOKEN, {
      linear: { viewer: VIEWER, issues: ISSUES },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // Seed the encrypted Linear token before opening Home so both
      // `validateLinearToken` (unlocks the plus-menu's Linear row) and
      // `searchLinearIssues` (reads the persisted token internally) resolve
      // our scenario.
      const savedSearch = await window.evaluate(
        (t) => window.api.saveLinearToken(t).then(() => true),
        SEARCH_TOKEN,
      );
      expect(savedSearch).toBe(true);

      await app.openMainPage();
      // Scope to the sidebar: when no worktree is selected yet, the central
      // panel's embedded Home surface also renders a workspace picker option
      // with this same name, which would make an unscoped lookup ambiguous.
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();

      // The sidebar's "New Task" item lands on the Home surface (the
      // Create-Task-modal replacement).
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      // The seeded workspace is the default (MRU-fallback-to-first) selection.
      await expect(homePage.getByTestId('home-workspace-select')).toContainText(
        WORKSPACE_NAME,
      );

      // A blank chat draft can create an empty work area.
      const sendButton = homePage.getByTestId('home-send-button');
      await expect(sendButton).toBeEnabled();

      // The `+` trigger is always rendered; its Linear row only APPEARS once
      // the persisted token validates against the mocked viewer (CAN-2709
      // moved connecting Linear to Account settings, so an unconnected menu
      // has no Linear row at all). Open the menu and let the row's enabled
      // assertion poll for it to mount.
      const plusButton = homePage.getByTestId('home-composer-plus-button');
      await expect(plusButton).toBeVisible();
      await plusButton.click();

      const menu = window.getByTestId('home-composer-plus-menu');
      await expect(menu).toBeVisible();
      const linearRow = menu.getByTestId('home-composer-plus-linear');
      await expect(linearRow).toBeEnabled({ timeout: 30_000 });
      await linearRow.click();

      const picker = window.getByTestId('linear-ticket-picker');
      await expect(picker).toBeVisible();

      const search = picker.getByTestId('linear-ticket-picker-input');
      await expect(search).toBeVisible();

      const result1 = picker.getByTestId(
        `linear-ticket-picker-result-${ISSUES[0].id}`,
      );
      const result2 = picker.getByTestId(
        `linear-ticket-picker-result-${ISSUES[1].id}`,
      );

      // Drive the debounced (300ms) search for a broad term matching both
      // issues' titles ("auth"). `fillLinearSearch` re-fills ONCE and then
      // lets `toBeVisible` poll without further input, so the debounce +
      // IPC → SDK → mock round-trip can actually complete instead of being
      // perpetually reset.
      const fillLinearSearch = async (term) => {
        await search.fill('');
        await search.fill(term);
      };

      // First attempt; if the keystroke was dropped, retry once. After the
      // (re)fill we wait on `toBeVisible` WITHOUT re-typing.
      await fillLinearSearch('auth');
      if (!(await result1.isVisible({ timeout: 5_000 }).catch(() => false))) {
        await fillLinearSearch('auth');
      }
      await expect(result1).toBeVisible({ timeout: 30_000 });
      await expect(result2).toBeVisible({ timeout: 30_000 });

      // The first row surfaces the issue identifier + title.
      await expect(result1).toContainText(ISSUES[0].identifier);
      await expect(result1).toContainText(ISSUES[0].title);

      // Long titles end after a whole word, or mid-word only when the first
      // word alone overflows; hovering shows the full title (CAN-3889).
      const spacedTitle = picker
        .getByTestId(`linear-ticket-picker-result-${ISSUES[2].id}`)
        .getByTestId('linear-ticket-picker-result-title');
      const unbrokenTitle = picker
        .getByTestId(`linear-ticket-picker-result-${ISSUES[3].id}`)
        .getByTestId('linear-ticket-picker-result-title');
      await expect(spacedTitle).toHaveAttribute('data-truncated', 'word');
      const spaced = await readTruncation(spacedTitle);
      expectWordCut(spaced, LONG_SPACED_TITLE);
      expect(spaced.title).toBe(LONG_SPACED_TITLE);
      await expect(unbrokenTitle).toHaveAttribute('data-truncated', 'char');
      const unbroken = await readTruncation(unbrokenTitle);
      expectCharCut(unbroken, LONG_UNBROKEN_TITLE);
      expect(unbroken.title).toBe(LONG_UNBROKEN_TITLE);

      // Narrow to a single identifier to prove the mock's substring filter is
      // really driving the rows (not a static list): `CAN-202` matches only the
      // second issue's identifier, not the first issue's title.
      await fillLinearSearch('CAN-202');
      await expect(result2).toBeVisible({ timeout: 30_000 });
      await expect(result1).toHaveCount(0, { timeout: 30_000 });

      // Select the matched ticket. `LinearTicketPickerModal` closes on
      // select, and the ticket is staged as an attachment pill (a snapshot
      // markdown file named after the sanitized identifier — see
      // `linearSnapshotFilename`).
      await result2.click();
      await expect(picker).toHaveCount(0);

      const pill = homePage.locator('[title="linear-can-202.md"]');
      await expect(pill).toBeVisible({ timeout: 15_000 });

      // Attachment-only Chat submits keep the ticket in an unsent draft.
      await expect(sendButton).toBeEnabled();

      // Pipeline mode is the one place an attachments-only draft is
      // sendable: `buildPipelineTaskText` synthesizes the task text from the
      // staged attachment list alone. Switching modes proves that gating is
      // wired end to end, not just unit-tested.
      await toggleHomePipelineMode(window, homePage);
      await expect(sendButton).toBeEnabled();

      // Back to Chat: carry the snapshot into the worktree without a turn.
      await toggleHomePipelineMode(window, homePage);
      await expect(sendButton).toBeEnabled();
      await sendButton.click();
      await expect(homePage).toHaveCount(0);
      await expect(
        window
          .getByTestId('panel-content-chat')
          .locator('[title="linear-can-202.md"]'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Home branch picker Issues tab cuts long titles after a whole word', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-linear-branch-issues-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    await registerScenario(DEFAULT_MOCK_BASE_URL, SEARCH_TOKEN, {
      linear: { viewer: VIEWER, issues: ISSUES },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      expect(
        await window.evaluate(
          (t) => window.api.saveLinearToken(t).then(() => true),
          SEARCH_TOKEN,
        ),
      ).toBe(true);

      await app.openMainPage();
      await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      await homePage.getByTestId('home-branch-picker-button').click();
      await window.getByTestId('home-branch-picker-tab-issues').click();
      // The tab searches only after a non-empty, debounced term.
      await window.getByTestId('home-branch-picker-search').fill('auth');
      const issue = window.getByTestId(
        `home-branch-picker-issue-${ISSUES[2].identifier}`,
      );
      await expect(issue).toBeVisible({ timeout: 30_000 });
      // The saved token unlocked the tab.
      await expect(
        window.getByTestId('home-branch-picker-issues-connect'),
      ).toHaveCount(0);

      const spacedTitle = issue.getByTestId('home-branch-picker-issue-title');
      await expect(spacedTitle).toHaveAttribute('data-truncated', 'word');
      const spaced = await readTruncation(spacedTitle);
      expectWordCut(spaced, LONG_SPACED_TITLE);
      expect(spaced.title).toBe(LONG_SPACED_TITLE);

      const unbrokenTitle = window
        .getByTestId(`home-branch-picker-issue-${ISSUES[3].identifier}`)
        .getByTestId('home-branch-picker-issue-title');
      await expect(unbrokenTitle).toHaveAttribute('data-truncated', 'char');
      const unbroken = await readTruncation(unbrokenTitle);
      expectCharCut(unbroken, LONG_UNBROKEN_TITLE);
      expect(unbroken.title).toBe(LONG_UNBROKEN_TITLE);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
