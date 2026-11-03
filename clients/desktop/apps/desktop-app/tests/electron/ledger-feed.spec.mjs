// UI automation for the global Agent Ledger Feed rows (phase 14, LD03).
//
// The Feed merges this device's Ledger scopes, read through the desktop
// dispatcher, with the account's other devices and its teammates, read from
// the cloud mirror. The mock server answers the mirror's search and entry
// routes from the scenario's `cloud.ledger.feed`; entries of this device are
// added through the E2E-only Ledger hook.
//
// Global (workflow) entries, which a pipeline agent with no task records in
// its run owner's Ledger, list beside task entries with their owner's label.
//
// These flows cover the one-column Feed: its Mine, Teammates and This device
// audiences, read-only remote rows, explicit details toggles and source
// navigation, offline and new-activity notices, adding and handing off drafts,
// and a narrow-window form. They also cover independent correction drafts,
// pending titles, nested corrections and the virtualized long list retaining
// its reading position, plus fresh results starting at the top after an
// audience change.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { seedPipelineExecution, seedWorktreeChat } from './seeders/index.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  clearScenario,
  getScenarioActivity,
  registerScenario,
} from './seeders/registerScenario.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  chatPanelLocator,
  seedPanelWorktree,
} from './panelHarness.mjs';
import { waitForChatPanel } from './chatPanelReady.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const LEDGER_ON = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-ledger-enabled': true,
  }),
  CANOPY_E2E_LEDGER_SYNC_FAST: '1',
};
/** The mirror names accounts by UUID. */
const ACCOUNT = { id: '00000000-0000-4000-8000-0000000e2e11' };
const SEEDED_CHAT = {
  kind: 'chat',
  chatId: SEEDED_CHAT_TAB_ID,
  displayName: 'Parser fixes',
};

const HOUR_MS = 60 * 60 * 1000;
const DETAILS = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

/** Opens a target picker of the Feed's form and chooses one of its rows. */
async function chooseTarget(page, picker, optionId) {
  await feedRoot(page).getByTestId(picker).click();
  await page
    .locator(`[data-testid="${picker}-option"][data-option-id="${optionId}"]`)
    .click();
}

/** Adds the Ledger panel to the worktree's chat group. */
async function addLedgerPanel(page) {
  // A chat tab that arrives after the Ledger panel takes focus from it.
  await waitForChatPanel(page);
  await page.getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.chat}`).click();
  await expect(page.getByTestId('panel-add-menu')).toBeVisible();
  await page.getByTestId('panel-add-menu-item-ledger').click();
  const panel = page.getByTestId('ledger-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** A row of the mirror's search, recorded `hoursAgo` hours ago. */
function mirrorRow({ id, title, hoursAgo, source }) {
  const at = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
  const author = {
    actorId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    kind: 'user',
    authorityId: `authority-${id}`,
  };
  return {
    entryId: `00000000-0000-4000-8000-${id.padStart(12, 'a')}`,
    revision: 1,
    type: 'TASK',
    title,
    content: 'Recorded somewhere else.',
    highlights: [],
    referenceFiles: [],
    status: 'IN_PROGRESS',
    owner: author,
    author,
    attributionKind: 'user',
    createdAt: at,
    updatedAt: at,
    sourceAvailability:
      source.kind === 'mine' ? 'not_on_this_device' : 'access_denied',
    ledgerId: `00000000-0000-4000-8000-${id.padStart(12, 'b')}`,
    scopeKind: 'code_worktree',
    scopeArchived: false,
    source,
  };
}

/** The mirror's entry response for a search row, with no history. */
function mirrorEntry(row) {
  return {
    entry: {
      schemaVersion: 1,
      entryId: row.entryId,
      scope: {
        ledgerId: row.ledgerId,
        authorityId: row.author.authorityId,
        container: {
          kind: 'code_worktree',
          workspaceId: 'their-workspace',
          worktreeId: 'their-worktree',
        },
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      revision: row.revision,
      author: row.author,
      authorDetails: DETAILS,
      owner: row.owner,
      type: row.type,
      title: row.title,
      content: row.content,
      highlights: [],
      referenceFiles: [],
      status: row.status,
      origin: {
        kind: 'user',
        ledgerId: row.ledgerId,
        userActorId: row.author.actorId,
      },
      attribution: {
        kind: 'user',
        effectiveActor: row.author,
        recordedBy: row.author,
        executorDetails: DETAILS,
      },
    },
    ledgerId: row.ledgerId,
    scopeKind: row.scopeKind,
    scopeArchived: false,
    source: row.source,
    sourceAvailability: row.sourceAvailability,
    history: { mutations: [], nextBeforeRevision: null },
    actors: [
      {
        ledgerId: row.ledgerId,
        actorId: row.author.actorId,
        kind: 'user',
        displayName: 'You',
      },
    ],
  };
}

const OTHER_DEVICE_ROW = mirrorRow({
  id: '21',
  title: 'Benchmark the parser on the studio machine',
  hoursAgo: 1,
  source: { kind: 'mine', deviceId: 'device-2', deviceLabel: 'Studio Mac' },
});
const TEAMMATE_ROW = mirrorRow({
  id: '22',
  title: 'Ship the parser fix',
  hoursAgo: 2,
  source: {
    kind: 'teammate',
    teammateName: 'Ada Lovelace',
    organizationId: '00000000-0000-4000-8000-0000000e2e12',
    organizationName: 'Acme',
  },
});

/** The mirror's read side as the scenario serves it. */
const FEED = {
  mine: [OTHER_DEVICE_ROW],
  teammates: [TEAMMATE_ROW],
  actors: [OTHER_DEVICE_ROW, TEAMMATE_ROW].map((row) => ({
    ledgerId: row.ledgerId,
    actorId: row.author.actorId,
    kind: 'user',
    displayName: 'You',
  })),
  entries: {
    [OTHER_DEVICE_ROW.entryId]: mirrorEntry(OTHER_DEVICE_ROW),
    [TEAMMATE_ROW.entryId]: mirrorEntry(TEAMMATE_ROW),
  },
};

/** Adds an entry through the desktop dispatcher; resolves with the entry. */
function addLedgerEntry(electronApp, request) {
  return electronApp.evaluate(async (_electron, payload) => {
    const ledger = globalThis.__CANOPY_E2E_LEDGER__;
    if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
    return ledger.addEntry(payload);
  }, request);
}

function feedRow(feed, title) {
  return feed.getByTestId('ledger-entry-row').filter({ hasText: title });
}

function feedRoot(page) {
  return page.getByTestId('page-feed').getByTestId('ledger-feed');
}

/** Finds the plain-text root title within the Feed. */
function entryTitle(feed, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return feed
    .getByTestId('ledger-entry-row-title')
    .filter({ hasText: new RegExp(`^${escaped}$`) });
}

function feedThread(feed, title) {
  return entryTitle(feed, title).locator(
    'xpath=ancestor::*[@data-testid="ledger-entry-thread"]',
  );
}

/** A thread's root row is a direct child; its descendants contain replies. */
function rootRow(thread) {
  return thread.locator(':scope > [data-testid="ledger-entry-row"]');
}

/** A root row's own control with this test ID, never one of its replies'. */
function rootOwn(thread, testId) {
  return rootRow(thread).locator(
    `xpath=.//*[@data-testid="${testId}"][not(ancestor::*[@data-testid="ledger-entry-correction"])]`,
  );
}

function rootDetailsToggle(thread) {
  return rootOwn(thread, 'ledger-entry-details-toggle');
}

function rootAddCorrection(thread) {
  return rootOwn(thread, 'ledger-entry-add-correction');
}

function replyDetailsToggle(reply) {
  return reply.getByTestId('ledger-entry-details-toggle');
}

async function cancelEntryDraft(form) {
  const cancel = form.getByTestId('ledger-entry-form-discard');
  await expect(cancel).toHaveText('Cancel');
  await cancel.click();
}

/**
 * How long the Feed takes to look for new activity after a change on this
 * device: `LEDGER_FEED_CHANGE_DELAY_MS` (2 s), then its read.
 */
const FEED_CHANGE_LOOK_MS = 6_000;

/** Fails if `locator` becomes visible within `timeout` milliseconds. */
async function expectNotToAppear(locator, timeout) {
  const appeared = await locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );
  expect(appeared).toBe(false);
}

function boxesIntersect(first, second) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

/** Scrolls a virtualized Feed list until a row is attached inside its pane. */
async function scrollFeedListUntilRowVisible(list, row) {
  let previousScrollTop = -1;
  await expect
    .poll(
      async () => {
        if ((await row.count()) > 0) {
          const [rowBox, listBox] = await Promise.all([
            row.boundingBox(),
            list.boundingBox(),
          ]);
          if (
            rowBox !== null &&
            listBox !== null &&
            boxesIntersect(rowBox, listBox)
          ) {
            return true;
          }
        }

        const scrollTop = await list.evaluate((element) => {
          element.scrollTop = Math.min(
            element.scrollTop + element.clientHeight,
            element.scrollHeight,
          );
          return element.scrollTop;
        });
        if (scrollTop === previousScrollTop) return false;
        previousScrollTop = scrollTop;
        return false;
      },
      // One pane height per look: 130 tall rows need well over 30 looks.
      { timeout: 60_000, intervals: [100] },
    )
    .toBe(true);
}

test('Ledger Feed: Mine, Teammates and This device, a source and back, and an offline notice', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const apiKey = `csk_ledger_feed_e2e_${Date.now()}`;
  const cloud = { account: ACCOUNT, ledger: { feed: FEED } };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Parser fixes' }],
  });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    // This device's entry, in a worktree first used signed in (LD02).
    await connectMockCloudAccount(window, apiKey);
    const localEntry = await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: SEEDED_CHAT,
      params: {
        type: 'DECISION',
        title: 'Keep one parser writer',
        content: 'Two writers race on the cache.',
      },
    });

    // --- 1. Mine: this device and another device, each where it came from.
    await window.getByTestId('sidebar-nav-feed').click();
    await expect(window.getByTestId('page-feed')).toBeVisible();
    const feed = feedRoot(window);
    await expect(feed).toHaveAttribute('data-audience', 'mine');
    const local = feedRow(feed, 'Keep one parser writer');
    const localThread = feedThread(feed, 'Keep one parser writer');
    const otherDevice = feedRow(feed, OTHER_DEVICE_ROW.title);
    await expect(local).toBeVisible({ timeout: 15_000 });
    // Another device's entry comes from the mirror's read.
    await expect(otherDevice).toBeVisible({ timeout: 15_000 });
    await expect(local.getByTestId('ledger-entry-row-context')).not.toHaveText(
      '',
    );
    await expect(otherDevice).toHaveAttribute('data-origin', 'device');
    await expect(otherDevice.getByTestId('ledger-entry-row-device')).toHaveText(
      'Studio Mac',
    );
    await expect(feedRow(feed, TEAMMATE_ROW.title)).toHaveCount(0);
    await expect(local.getByTestId('ledger-entry-row-title')).toHaveClass(
      /font-bold/,
    );
    const localTime = local.locator('time').first();
    await localTime.hover();
    // Formatted in the app's own locale and time zone, not the runner's.
    const fullLocalTime = await window.evaluate(
      (iso) =>
        new Intl.DateTimeFormat(undefined, {
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(new Date(iso)),
      localEntry.updatedAt,
    );
    await expect(window.getByRole('tooltip')).toHaveText(fullLocalTime);

    // --- Newer activity waits behind "Show new activity", then shows on
    // request.
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: SEEDED_CHAT,
      params: {
        type: 'TASK',
        title: 'Retry the flaky parser test',
        content: 'It failed once on the cold cache.',
      },
    });
    const newer = feedRow(feed, 'Retry the flaky parser test');
    const showNewer = feed.getByTestId('ledger-feed-new-activity');
    await expect(showNewer).toBeVisible({ timeout: 15_000 });
    await expect(newer).toHaveCount(0);
    await showNewer.click();
    await expect(newer).toBeVisible();
    await expect(showNewer).toHaveCount(0);
    await expect(local).toBeVisible();

    // Leaving the page and entering from the sidebar shows fresh activity
    // immediately, rather than holding it behind the in-page action.
    await window.getByTestId('sidebar-nav-plugins').click();
    await expect(window.getByTestId('page-feed')).toHaveCount(0);
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: SEEDED_CHAT,
      params: {
        type: 'TASK',
        title: 'Check the parser after returning',
        content: 'Added while reading another page.',
      },
    });
    await window.getByTestId('sidebar-nav-feed').click();
    await expect(
      feedRow(feed, 'Check the parser after returning'),
    ).toBeVisible();
    await expect(showNewer).toHaveCount(0);

    // --- 2. Teammates adds a teammate's entry, under their own name.
    await feed.getByTestId('ledger-feed-audience-teammates').click();
    const teammateThread = feedThread(feed, TEAMMATE_ROW.title);
    const teammate = rootRow(teammateThread);
    await expect(teammate).toBeVisible();
    await expect(teammate).toHaveAttribute('data-origin', 'teammate');
    // Their own entry: the byline names them, the origin their organization.
    await expect(teammate.getByTestId('ledger-entry-row-teammate')).toHaveText(
      'Acme',
    );
    await expect(teammate).toContainText('Ada Lovelace');
    await expect(local).toBeVisible();
    await rootDetailsToggle(teammateThread).click();
    await expect(teammate.getByTestId('ledger-feed-read-only')).toHaveText(
      'Ada Lovelace recorded this entry. Only they can change it.',
    );
    // Their own user is the teammate in the details too, never "you".
    const teammateDetails = teammate.getByTestId('ledger-entry-details');
    await expect(teammateDetails).toContainText(/Added by\s*Ada Lovelace/);
    await expect(teammateDetails).not.toContainText(/\byou\b/i);

    // --- 3. This device narrows to this device's work, and lets go of the
    // teammate's entry it no longer lists.
    await feed.getByTestId('ledger-feed-audience-this_device').click();
    await expect(feed.getByTestId('ledger-entry-row')).toHaveCount(3);
    await expect(local).toBeVisible();
    await expect(newer).toBeVisible();
    await expect(feed.getByTestId('ledger-feed-read-only')).toHaveCount(0);
    await expect(
      feed.locator('[data-testid="ledger-entry-row"][aria-current="true"]'),
    ).toHaveCount(0);

    // --- 4. This device's entry opens its chat; Back returns to the Feed
    // with the same entry selected.
    await rootDetailsToggle(localThread).click();
    const openSource = local.getByTestId('ledger-entry-source-open').first();
    await expect(openSource).toHaveText('Open chat');
    await openSource.click();
    await expect(chatPanelLocator(window, SEEDED_CHAT_TAB_ID)).toBeVisible();
    await expect(window.getByTestId('page-feed')).toHaveCount(0);
    await window.getByTestId('nav-history-back').click();
    await expect(window.getByTestId('page-feed')).toBeVisible();
    await expect(local).toHaveAttribute('aria-current', 'true');
    await expect(local.getByTestId('ledger-entry-details')).toBeVisible();

    // --- 5. With the mirror down, a new search shows this device's work
    // and says what is missing; Try again recovers.
    await feed.getByTestId('ledger-feed-audience-mine').click();
    await expect(otherDevice).toBeVisible();
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { ...cloud, ledger: { feed: 'unavailable' } },
    });
    await feed.getByTestId('ledger-feed-search').fill('parser');
    const notice = feed.getByTestId('ledger-feed-notice');
    await expect(notice).toContainText(
      "Can't reach the cloud. Showing this device's entries.",
    );
    await expect(local).toBeVisible();
    await expect(otherDevice).toHaveCount(0);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
    await notice.getByRole('button', { name: 'Try again' }).click();
    await expect(notice).toHaveCount(0);
    await expect(otherDevice).toBeVisible();

    // --- 6. An entry gone from the cloud disappears automatically when
    // entering Feed again, without asking to show new activity.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { ...cloud, ledger: { feed: { ...FEED, mine: [] } } },
    });
    await window.getByTestId('sidebar-nav-workflows').click();
    await expect(window.getByTestId('page-feed')).toHaveCount(0);
    await window.getByTestId('sidebar-nav-feed').click();
    await expect(otherDevice).toHaveCount(0);
    await expect(showNewer).toHaveCount(0);
    await expect(local).toBeVisible();

    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity.ledgerSearch ?? 0).toBeGreaterThan(0);
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-feed-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => undefined);
  }
});

test('Ledger Feed: Add entry chooses its project and task first, keeping what was written', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-add-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-yarn-cli'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);

    // Whose entries on a row of their own; the search, the Filter dropdown
    // after it, and Add entry below them.
    const tabs = await feed
      .getByTestId('ledger-feed-audience-mine')
      .boundingBox();
    const filter = await feed
      .getByTestId('ledger-filter-trigger')
      .boundingBox();
    const search = await feed.getByTestId('ledger-feed-search').boundingBox();
    expect(filter?.y ?? 0).toBeGreaterThan(
      (tabs?.y ?? Infinity) + (tabs?.height ?? 0) - 1,
    );
    expect(filter?.x ?? -Infinity).toBeGreaterThan(search?.x ?? Infinity);
    expect(search?.height).toBe(32);
    expect(filter?.height).toBe(28);
    await expect(feed.getByTestId('ledger-filter-trigger')).toHaveText(
      'Filter',
    );

    // The form opens at once, with where the entry goes first.
    await feed.getByTestId('ledger-feed-add-entry').click();
    const form = feed.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('ledger-entry-form-content')).toBeFocused();
    await expect(feed.getByTestId('ledger-feed-add-entry')).toHaveCount(0);
    const project = feed.getByTestId('ledger-feed-target-project');
    const task = feed.getByTestId('ledger-feed-target-task');
    await expect(project).toHaveText('Choose a project');
    await expect(task).toBeDisabled();
    await expect(form.getByTestId('ledger-entry-form-save')).toBeDisabled();
    await expect(form.getByTestId('ledger-entry-form-save-blocked')).toHaveText(
      'Choose a task first.',
    );

    await form
      .getByTestId('ledger-entry-form-title')
      .fill('Ship the release notes');
    await form.getByTestId('ledger-entry-form-content').fill('Cover the Feed.');

    // One project's task, then another's: what was written stays.
    const choose = async (picker, optionId) => {
      await feed.getByTestId(picker).click();
      await window
        .locator(
          `[data-testid="${picker}-option"][data-option-id="${optionId}"]`,
        )
        .click();
    };
    await choose('ledger-feed-target-project', 'demo-ts-yarn-cli');
    await choose('ledger-feed-target-task', WORKTREE_ID);
    await expect(form.getByTestId('ledger-entry-form-save')).toBeEnabled();
    // A file of this project: it names the project's own repository.
    await form.getByTestId('ledger-file-search').fill('package');
    await form
      .getByTestId('ledger-file-search-result')
      .filter({ hasText: 'package.json' })
      .first()
      .click();
    await expect(form.getByTestId('ledger-entry-form-file')).toHaveCount(1);
    await choose('ledger-feed-target-project', WORKSPACE_ID);
    await expect(task).toHaveText('Choose a task');
    await expect(form.getByTestId('ledger-entry-form-title')).toHaveValue(
      'Ship the release notes',
    );
    // Another project's repositories are not that file's.
    await expect(form.getByTestId('ledger-entry-form-file')).toHaveCount(0);
    await choose('ledger-feed-target-task', WORKTREE_ID);
    await expect(form.getByTestId('ledger-entry-form-content')).toHaveValue(
      'Cover the Feed.',
    );

    // Saved to the task chosen: its entry shows, and the Feed lists it.
    await form.getByTestId('ledger-entry-form-save').click();
    await expect(form).toBeHidden();
    const saved = feedRow(feed, 'Ship the release notes');
    await expect(saved).toBeVisible({ timeout: 15_000 });
    const savedThread = feedThread(feed, 'Ship the release notes');
    await expect(rootDetailsToggle(savedThread)).toHaveText('Show details');
    await expect(
      feed.locator('[data-testid="ledger-entry-row"][aria-current="true"]'),
    ).toHaveCount(0);
    await expect(feed.getByTestId('ledger-feed-add-entry')).toHaveText(
      'Add a task, decision or finding',
    );
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-feed-add-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: correction drafts stay independent from the new-entry draft', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-independent-drafts-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    await addLedgerEntry(electronApp, {
      scope,
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Keep the first Feed note',
        content: 'The first thread has its own correction draft.',
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Keep the second Feed note',
        content: 'The second thread has its own correction draft.',
      },
    });

    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    const firstThread = feedThread(feed, 'Keep the first Feed note');
    const secondThread = feedThread(feed, 'Keep the second Feed note');
    await expect(rootRow(firstThread)).toBeVisible();
    await expect(rootRow(secondThread)).toBeVisible();

    await expect(rootAddCorrection(firstThread)).toBeVisible();
    await rootAddCorrection(firstThread).click();
    const firstBox = firstThread.getByTestId('ledger-correction-box');
    const firstInput = firstBox.getByTestId('ledger-correction-input');
    const firstText = 'Keep the first correction draft.';
    await firstInput.fill(firstText);

    await expect(rootAddCorrection(secondThread)).toBeVisible();
    await rootAddCorrection(secondThread).click();
    const secondBox = secondThread.getByTestId('ledger-correction-box');
    const secondInput = secondBox.getByTestId('ledger-correction-input');
    const secondText = 'Keep the second correction draft.';
    await secondInput.fill(secondText);
    await expect(feed.getByTestId('ledger-correction-box')).toHaveCount(2);
    await expect(firstInput).toHaveValue(firstText);
    await expect(secondInput).toHaveValue(secondText);

    const add = feed.getByTestId('ledger-feed-add-entry');
    // Regression: the old one-draft behavior disabled this bar without a
    // clear reason when a correction draft elsewhere held its only draft slot.
    await expect(add).toBeEnabled();
    await expect(feed.getByTestId('ledger-entry-details-toggle')).toHaveText([
      'Show details',
      'Show details',
    ]);
    await add.click();

    const form = feed.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await expect(feed.getByTestId('ledger-correction-box')).toHaveCount(2);
    const formTitle = form.getByTestId('ledger-entry-form-title');
    const formContent = form.getByTestId('ledger-entry-form-content');
    await expect(formContent).toBeFocused();
    await formTitle.fill('Keep the new entry draft too');
    await formContent.fill('The Feed keeps this draft beside corrections.');
    await chooseTarget(window, 'ledger-feed-target-project', WORKSPACE_ID);
    await chooseTarget(window, 'ledger-feed-target-task', WORKTREE_ID);
    await expect(firstInput).toHaveValue(firstText);
    await expect(secondInput).toHaveValue(secondText);

    // Saving one correction leaves the other correction and the unsaved new
    // entry where they were; neither write opens an entry's details.
    await firstBox.getByTestId('ledger-correction-save').click();
    await expect(firstBox).toHaveCount(0);
    await expect(secondInput).toHaveValue(secondText);
    await expect(formTitle).toHaveValue('Keep the new entry draft too');
    await expect(formContent).toHaveValue(
      'The Feed keeps this draft beside corrections.',
    );
    await expect(
      feed.locator(
        '[data-testid="ledger-entry-row"][aria-current="true"], [data-testid="ledger-entry-correction"][aria-current="true"]',
      ),
    ).toHaveCount(0);
    await expect(feed.getByTestId('ledger-entry-details-toggle')).toHaveText([
      'Show details',
      'Show details',
      'Show details',
    ]);
    await expect(secondBox.getByTestId('ledger-correction-discard')).toHaveText(
      'Cancel',
    );

    await secondBox.getByTestId('ledger-correction-discard').click();
    await expect(secondBox).toHaveCount(0);
    await expect(formContent).toHaveValue(
      'The Feed keeps this draft beside corrections.',
    );
    await cancelEntryDraft(form);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-independent-drafts-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: a title-less entry stays uncorrectable until its title is generated', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const titleMarker = 'Canopy-CFEEDTITLE';
  let userDataDir;
  let electronApp;
  let window;
  try {
    // The mock answers helper prompts by their fingerprint; the marker's
    // scenario overrides the chat-description helper's reply.
    const titleStep = { text: 'Feed generated title', streamMs: 8_000 };
    await registerScenario(DEFAULT_MOCK_BASE_URL, titleMarker, {
      llm: {
        steps: [titleStep],
        helperStepsById: { 'topic-summary': titleStep },
      },
    });
    userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ledger-feed-pending-title-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const launched = await seedPanelWorktree({
      userDataDir,
      seedDemoWorkspaces: false,
      env: LEDGER_ON,
    });
    electronApp = launched.electronApp;
    window = launched.window;

    await window.getByTestId('sidebar-nav-feed').click();
    const pageFeed = window.getByTestId('page-feed');
    const feed = pageFeed.getByTestId('ledger-feed');
    await feed.getByTestId('ledger-feed-add-entry').click();
    const form = feed.getByTestId('ledger-entry-form');
    const title = form.getByTestId('ledger-entry-form-title');
    const content = form.getByTestId('ledger-entry-form-content');
    await expect(form.getByText('Title (optional)')).toBeVisible();
    await expect(content).toBeFocused();
    await chooseTarget(window, 'ledger-feed-target-project', WORKSPACE_ID);
    await chooseTarget(window, 'ledger-feed-target-task', WORKTREE_ID);
    await content.fill(
      `Record this Feed note before its title is ready. [${titleMarker}]`,
    );
    await expect(title).toHaveValue('');
    await form.getByTestId('ledger-entry-form-save').click();
    await expect(form).toHaveCount(0);

    const thread = feed
      .getByTestId('ledger-entry-thread')
      .filter({ hasText: titleMarker });
    const row = rootRow(thread);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('ledger-entry-row-title')).toHaveCount(0);
    const addCorrection = rootAddCorrection(thread);
    const pendingReason = 'Its title is still being written.';
    await expect(addCorrection).toBeDisabled();
    await expect(addCorrection).toHaveAttribute(
      'aria-description',
      pendingReason,
    );
    // A disabled button takes no pointer events: the pointer lands on the
    // tooltip's wrapper, so hover that (hovering the button itself would wait
    // until it is enabled again).
    await addCorrection.locator('xpath=..').hover();
    await expect(window.getByRole('tooltip')).toHaveText(pendingReason);

    await expect(row.getByTestId('ledger-entry-row-title')).toHaveText(
      'Feed generated title',
      { timeout: 60_000 },
    );
    await expect(addCorrection).toBeEnabled();
  } catch (error) {
    if (window !== undefined) {
      await window
        .screenshot({
          path: testInfo.outputPath('ledger-feed-pending-title-failure.png'),
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    try {
      if (electronApp !== undefined && userDataDir !== undefined) {
        await closeCanopy(electronApp, userDataDir);
      }
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, titleMarker).catch(
        () => undefined,
      );
    }
  }
});

test('Ledger Feed: continues only its own draft, never one its task started', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-own-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window, app } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    const panel = await addLedgerPanel(window);
    await expect(panel.getByTestId('ledger-empty')).toBeVisible();

    // A Feed draft moved into the task, its form left open.
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    await feed.getByTestId('ledger-feed-add-entry').click();
    await feed
      .getByTestId('ledger-entry-form-title')
      .fill('Ship the release notes');
    await chooseTarget(window, 'ledger-feed-target-project', WORKSPACE_ID);
    await chooseTarget(window, 'ledger-feed-target-task', WORKTREE_ID);

    // In the task's own panel, that draft is dropped and another started.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const form = panel.getByTestId('ledger-entry-form');
    await expect(form.getByTestId('ledger-entry-form-title')).toHaveValue(
      'Ship the release notes',
    );
    await cancelEntryDraft(form);
    await panel.getByTestId('ledger-add-entry').click();
    await form.getByTestId('ledger-entry-form-title').fill('Its own');

    // Back on the Feed, its form has closed, and it never offers the task's
    // draft as its own.
    await window.getByTestId('sidebar-nav-feed').click();
    await expect(feed.getByTestId('ledger-entry-form')).toHaveCount(0);
    const add = feed.getByTestId('ledger-feed-add-entry');
    await expect(add).toHaveText('Add a task, decision or finding');
    await add.click();
    await expect(feed.getByTestId('ledger-entry-form-title')).toHaveValue('');
    // The task keeps its draft, so the Feed can't take that task.
    await chooseTarget(window, 'ledger-feed-target-project', WORKSPACE_ID);
    await feed.getByTestId('ledger-feed-target-task').click();
    const task = window.locator(
      `[data-testid="ledger-feed-target-task-option"][data-option-id="${WORKTREE_ID}"]`,
    );
    await expect(task).toBeDisabled();
    await expect(task).toContainText('Has a draft');
  } catch (error) {
    await window
      .screenshot({ path: testInfo.outputPath('ledger-feed-own-failure.png') })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("Ledger Feed: a draft dropped in its task's panel returns the Feed to its list", async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-dropped-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window, app } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Update parser recovery',
        content: 'Preserve incomplete events after reconnection.',
      },
    });
    // The task's panel shows one of its entries.
    const panel = await addLedgerPanel(window);
    const panelThread = panel
      .getByTestId('ledger-entry-thread')
      .filter({ hasText: 'Update parser recovery' });
    const panelRow = rootRow(panelThread);
    await rootDetailsToggle(panelThread).click();
    await expect(panelRow).toHaveAttribute('aria-current', 'true');

    // A Feed draft moved into that task, its form left open.
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    await feed.getByTestId('ledger-feed-add-entry').click();
    await feed
      .getByTestId('ledger-entry-form-title')
      .fill('Ship the release notes');
    await chooseTarget(window, 'ledger-feed-target-project', WORKSPACE_ID);
    await chooseTarget(window, 'ledger-feed-target-task', WORKTREE_ID);

    // The task's panel discards it.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const form = panel.getByTestId('ledger-entry-form');
    await expect(form.getByTestId('ledger-entry-form-title')).toHaveValue(
      'Ship the release notes',
    );
    await cancelEntryDraft(form);
    await expect(form).toBeHidden();

    // Back on the Feed: its list, not the entry the panel had open.
    await window.getByTestId('sidebar-nav-feed').click();
    await expect(feed.getByTestId('ledger-entry-form')).toHaveCount(0);
    await expect(
      feed.locator('[data-testid="ledger-entry-row"][aria-current="true"]'),
    ).toHaveCount(0);
    await expect(feed.getByTestId('ledger-feed-add-entry')).toHaveText(
      'Add a task, decision or finding',
    );
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-dropped-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: in a narrow window, the form opens in the column and a discarded draft leaves the prompt', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-narrow-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Keep the parser row below the composer',
        content: 'The Feed form shares its column with entries.',
      },
    });

    // A narrow Feed keeps its controls and rows in the same column as the
    // form.
    await window.setViewportSize({ width: 820, height: 900 });
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    const list = feed.getByTestId('ledger-feed-list-pane');
    const controls = feed.getByTestId('ledger-feed-controls');
    const prompt = feed.getByTestId('ledger-feed-add-entry');
    const row = feedRow(feed, 'Keep the parser row below the composer');
    await expect(list).toBeVisible();
    await expect(row).toBeVisible();
    await prompt.click();
    const form = list.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await expect(controls).toBeVisible();
    await expect(row).toBeAttached();
    await expect
      .poll(() =>
        list.evaluate((element) => {
          const composer = element.querySelector(
            '[data-testid="ledger-entry-form"]',
          );
          const entry = element.querySelector(
            '[data-testid="ledger-entry-row"]',
          );
          return Boolean(
            composer &&
            entry &&
            composer.compareDocumentPosition(entry) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      )
      .toBe(true);
    expect(
      await list.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);

    await cancelEntryDraft(form);
    await expect(form).toBeHidden();
    await expect(prompt).toHaveText('Add a task, decision or finding');
    const thread = feedThread(feed, 'Keep the parser row below the composer');
    await rootDetailsToggle(thread).click();
    await expect(row.getByTestId('ledger-entry-details')).toBeVisible();
    expect(
      await list.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-narrow-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: fresh results start at the top of the list', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-scroll-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    // Enough of this device's entries for the list to scroll.
    for (let index = 1; index <= 40; index += 1) {
      await addLedgerEntry(electronApp, {
        scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        author: { kind: 'user' },
        params: {
          type: 'TASK',
          title: `Check parser case ${String(index)}`,
          content: 'One of many.',
        },
      });
    }
    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    const list = feed.getByTestId('ledger-feed-list-pane');
    await expect(feed.getByTestId('ledger-entry-row').first()).toBeVisible({
      timeout: 15_000,
    });
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    // Another audience reads a new first page, which starts at the top.
    await feed.getByTestId('ledger-feed-audience-this_device').click();
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBe(0);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-scroll-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: the heading and the Feed share one 640px column', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-column-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: { kind: 'user' },
      params: { type: 'TASK', title: 'Line up the Feed', content: 'One edge.' },
    });
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.getByTestId('sidebar-nav-feed').click();
    const page = window.getByTestId('page-feed');
    const feed = feedRoot(window);
    await expect(feed.getByTestId('ledger-entry-row').first()).toBeVisible({
      timeout: 15_000,
    });

    const heading = await page.getByTestId('page-header').boundingBox();
    const list = await feed.boundingBox();
    expect(heading).not.toBeNull();
    expect(list).not.toBeNull();
    if (heading === null || list === null) return;
    // Title, tabs, search row and list share one left and right edge, 640px
    // apart, centered in the wide window.
    expect(Math.abs(heading.x - list.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(heading.x + heading.width - (list.x + list.width)),
    ).toBeLessThanOrEqual(1);
    expect(Math.round(list.width)).toBe(640);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-column-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: a correction of a correction, replies opened and changed in place', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-corrections-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Parser fixes' }],
  });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
    const rootEntry = await addLedgerEntry(electronApp, {
      scope,
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Ship the parser fix',
        content: 'Cover the reconnect behavior.',
      },
    });
    const correctionB = await addLedgerEntry(electronApp, {
      scope,
      author: { kind: 'user' },
      params: {
        type: 'TASK',
        title: 'Ship the parser fix',
        content: 'Also cover the reconnect path.',
        status: 'TODO',
        supersedesEntryId: rootEntry.entryId,
      },
    });
    await addLedgerEntry(electronApp, {
      scope,
      author: SEEDED_CHAT,
      params: {
        type: 'OBSERVATION',
        title: 'Ship the parser fix',
        content: 'The reconnect path already has a test.',
        supersedesEntryId: correctionB.entryId,
      },
    });

    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    const thread = feedThread(feed, 'Ship the parser fix');
    const root = rootRow(thread);
    const replies = thread.getByTestId('ledger-entry-correction');
    const replyB = replies.filter({
      hasText: 'Also cover the reconnect path.',
    });
    const replyC = replies.filter({
      hasText: 'The reconnect path already has a test.',
    });

    await expect(feed.getByTestId('ledger-entry-thread')).toHaveCount(1);
    await expect(replies).toHaveCount(2);
    await expect(
      replyC.getByTestId('ledger-entry-correction-target'),
    ).toHaveText('Corrects a reply');
    await expect(
      replyB.getByTestId('ledger-entry-correction-target'),
    ).toHaveCount(0);

    await replyDetailsToggle(replyB).click();
    await expect(replyB).toHaveAttribute('aria-current', 'true');
    await expect(replyDetailsToggle(replyB)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(rootDetailsToggle(thread)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(
      feed
        .getByTestId('ledger-entry-details-toggle')
        .filter({ hasText: 'Hide details' }),
    ).toHaveCount(1);
    await expect(replyB.getByTestId('ledger-entry-details')).toBeVisible();

    const status = replyB.getByTestId('ledger-status-control').first();
    await status.click();
    await window.getByTestId('ledger-status-option-in_progress').click();
    await expect(status).toHaveText('In progress');

    const owner = replyB.getByTestId('ledger-owner-picker').first();
    await owner.click();
    const parserFixes = window
      .getByTestId('ledger-owner-option')
      .filter({ hasText: 'Parser fixes' });
    await expect(parserFixes).toBeVisible({ timeout: 15_000 });
    await parserFixes.click();
    await expect(owner).toContainText('Parser fixes');
    await expect(status).toHaveText('In progress');

    // This device's own change updates the rows the Feed holds: its look for
    // new activity, a moment after the change, offers nothing new.
    await expectNotToAppear(
      feed.getByTestId('ledger-feed-new-activity'),
      FEED_CHANGE_LOOK_MS,
    );
    await expect(status).toHaveText('In progress');
    await expect(owner).toContainText('Parser fixes');

    // Close the inspected reply before adding a correction. Opening the
    // correction box itself must not open any entry's details.
    await replyDetailsToggle(replyB).click();
    await expect(replyDetailsToggle(replyB)).toHaveText('Show details');
    await expect(replyDetailsToggle(replyB)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(rootDetailsToggle(thread)).toHaveText('Show details');
    await expect(replyDetailsToggle(replyC)).toHaveText('Show details');
    await expect(rootAddCorrection(thread)).toHaveCount(0);
    await expect(replyB.getByTestId('ledger-entry-add-correction')).toHaveCount(
      0,
    );
    await expect(replyC.getByTestId('ledger-entry-add-correction')).toHaveCount(
      1,
    );
    await replyC.getByTestId('ledger-entry-add-correction').click();
    const correctionBox = thread.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    const correctionInput = correctionBox.getByTestId(
      'ledger-correction-input',
    );
    await expect(correctionInput).toBeFocused();
    await expect(
      correctionBox.getByTestId('ledger-correction-more'),
    ).toHaveText('More options');
    await expect(
      correctionBox.getByTestId('ledger-correction-more'),
    ).toBeVisible();
    await expect(
      correctionBox.getByTestId('ledger-correction-discard'),
    ).toHaveText('Cancel');
    await expect(
      correctionBox.getByTestId('ledger-correction-discard'),
    ).toBeVisible();
    await expect(
      correctionBox.getByTestId('ledger-correction-save'),
    ).toHaveText('Add correction');
    await expect(
      correctionBox.getByTestId('ledger-correction-save'),
    ).toBeVisible();
    await expect(rootDetailsToggle(thread)).toHaveText('Show details');
    await expect(rootDetailsToggle(thread)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(replyDetailsToggle(replyB)).toHaveText('Show details');
    await expect(replyDetailsToggle(replyC)).toHaveText('Show details');
    await expect(replyDetailsToggle(replyC)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const correctionText = 'Add a regression test for the reply.';
    await correctionInput.fill(correctionText);
    await correctionBox.getByTestId('ledger-correction-save').click();

    const replyD = thread
      .getByTestId('ledger-entry-correction')
      .filter({ hasText: correctionText });
    await expect(replyD).toBeVisible();
    await expect(
      replyD.getByTestId('ledger-entry-correction-target'),
    ).toHaveText('Corrects a reply');
    await expect(thread.getByTestId('ledger-entry-correction')).toHaveCount(3);
    await expect(rootAddCorrection(thread)).toHaveCount(0);
    await expect(replyB.getByTestId('ledger-entry-add-correction')).toHaveCount(
      0,
    );
    await expect(replyC.getByTestId('ledger-entry-add-correction')).toHaveCount(
      0,
    );
    await expect(replyD.getByTestId('ledger-entry-add-correction')).toHaveCount(
      1,
    );
    await expect(
      feed.locator(
        '[data-testid="ledger-entry-row"][aria-current="true"], [data-testid="ledger-entry-correction"][aria-current="true"]',
      ),
    ).toHaveCount(0);
    await expect(thread.getByTestId('ledger-entry-details-toggle')).toHaveText([
      'Show details',
      'Show details',
      'Show details',
      'Show details',
    ]);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-corrections-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: a long list windows its rows and keeps the reading position across a correction', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-long-list-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await electronApp.evaluate(
      async (_electron, payload) => {
        const ledger = globalThis.__CANOPY_E2E_LEDGER__;
        if (!ledger) throw new Error('The E2E Ledger seeder is unavailable');
        for (let index = 1; index <= payload.count; index += 1) {
          await ledger.addEntry({
            scope: payload.scope,
            author: payload.author,
            params: {
              type: 'TASK',
              title: `Check parser case ${index}`,
              content: 'One of many.',
              status: 'TODO',
            },
          });
        }
      },
      {
        count: 130,
        scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        author: { kind: 'user' },
      },
    );

    await window.getByTestId('sidebar-nav-feed').click();
    const feed = feedRoot(window);
    const list = feed.getByTestId('ledger-feed-list-pane');
    const entryList = feed.getByTestId('ledger-entry-list');
    await expect(entryList).toHaveAttribute('data-entry-count', '30', {
      timeout: 15_000,
    });

    while (Number(await entryList.getAttribute('data-entry-count')) < 130) {
      const previousCount = Number(
        await entryList.getAttribute('data-entry-count'),
      );
      await entryList.getByTestId('ledger-load-more').click();
      await expect
        .poll(async () =>
          Number(await entryList.getAttribute('data-entry-count')),
        )
        .toBeGreaterThan(previousCount);
    }

    await expect(entryList).toHaveAttribute('data-entry-count', '130');
    await expect(entryList).toHaveAttribute('data-virtualized', 'true');
    const rows = feed.getByTestId('ledger-entry-row');
    expect(await rows.count()).toBeLessThan(60);

    const thread = feedThread(feed, 'Check parser case 10');
    const target = rootRow(thread);
    await scrollFeedListUntilRowVisible(list, target);
    await expect(target).toBeVisible();
    await expect(rootDetailsToggle(thread)).toHaveText('Show details');
    await rootAddCorrection(thread).click();
    const correctionBox = thread.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    await expect(rootDetailsToggle(thread)).toHaveText('Show details');
    const correctionText = 'Record the slow reconnect path.';
    await correctionBox
      .getByTestId('ledger-correction-input')
      .fill(correctionText);
    await correctionBox.getByTestId('ledger-correction-save').click();

    const reply = thread
      .getByTestId('ledger-entry-correction')
      .filter({ hasText: correctionText });
    await expect(reply).toBeVisible();
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(1_000);
    await expect
      .poll(async () => {
        const [rowBox, listBox] = await Promise.all([
          target.boundingBox(),
          list.boundingBox(),
        ]);
        return (
          rowBox !== null && listBox !== null && boxesIntersect(rowBox, listBox)
        );
      })
      .toBe(true);
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-long-list-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Ledger Feed: workflow entries beside a task, changed and corrected here, and their run', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const apiKey = `csk_ledger_feed_global_e2e_${Date.now()}`;
  const cloud = {
    account: ACCOUNT,
    ledger: {
      feed: { mine: [], teammates: [], actors: [], entries: {} },
    },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ledger-feed-global-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Parser fixes' }],
  });
  // A global run: no project and no worktree. Another run was pruned.
  seedPipelineExecution({
    userDataDir,
    execution: {
      id: 'global-nightly-triage',
      pipelineName: 'Nightly triage',
      status: 'success',
      startedAt: '2026-10-20T02:00:00.000Z',
      completedAt: '2026-10-20T02:05:00.000Z',
      jobs: [
        {
          id: 'triage',
          name: 'Triage',
          steps: [{ id: 'agent', name: 'Triage failures', run: 'echo triage' }],
        },
      ],
    },
  });
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    env: LEDGER_ON,
  });

  try {
    await connectMockCloudAccount(window, apiKey);
    await addLedgerEntry(electronApp, {
      scope: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      author: SEEDED_CHAT,
      params: {
        type: 'DECISION',
        title: 'Keep one parser writer',
        content: 'Two writers race on the cache.',
      },
    });
    const triageAgent = {
      kind: 'pipeline',
      executionId: 'global-nightly-triage',
      jobId: 'triage',
      stepId: 'agent',
      displayName: 'Triage failures · Nightly triage',
    };
    await addLedgerEntry(electronApp, {
      scope: { kind: 'global', owner: { kind: 'personal' } },
      author: triageAgent,
      params: {
        type: 'TASK',
        title: 'Fix the three flaky parser specs',
        content: 'They fail on a cold cache.',
        status: 'TODO',
      },
    });
    await addLedgerEntry(electronApp, {
      scope: { kind: 'global', owner: { kind: 'personal' } },
      author: { ...triageAgent, executionId: 'global-pruned-run' },
      params: {
        type: 'OBSERVATION',
        title: 'Last week the cache warmed slowly',
        content: 'Recorded by a run this device no longer keeps.',
      },
    });

    await window.getByTestId('sidebar-nav-feed').click();
    await expect(window.getByTestId('page-feed')).toBeVisible();
    const feed = feedRoot(window);
    const task = feedRow(feed, 'Keep one parser writer');
    const workflow = feedRow(feed, 'Fix the three flaky parser specs');
    const pruned = feedRow(feed, 'Last week the cache warmed slowly');
    await expect(workflow).toBeVisible({ timeout: 15_000 });
    await expect(task).toBeVisible();
    await expect(pruned).toBeVisible();

    // Each row names its work: the task by its project, the workflow entry
    // by its run's owner.
    await expect(workflow.getByTestId('ledger-entry-row-context')).toHaveText(
      'Workflows · Personal',
    );
    await expect(task.getByTestId('ledger-entry-row-context')).not.toHaveText(
      /Workflows/,
    );
    // The composer never offers a workflow as a destination.
    await feed.getByTestId('ledger-feed-add-entry').click();
    const form = feed.getByTestId('ledger-entry-form');
    await expect(form).toBeVisible();
    await feed.getByTestId('ledger-feed-target-project').click();
    await expect(
      window.getByTestId('ledger-feed-target-project-option'),
    ).not.toHaveCount(0);
    await expect(
      window
        .getByTestId('ledger-feed-target-project-option')
        .filter({ hasText: 'Workflows' }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await cancelEntryDraft(form);

    // A workflow entry changes here like any of this device's entries.
    const thread = feedThread(feed, 'Fix the three flaky parser specs');
    await rootDetailsToggle(thread).click();
    const status = rootOwn(thread, 'ledger-status-control').first();
    await status.click();
    await window.getByTestId('ledger-status-option-in_progress').click();
    await expect(status).toHaveText('In progress');

    // Its run opens from the entry.
    const openRun = rootOwn(thread, 'ledger-entry-source-open').first();
    await expect(openRun).toHaveText('Open run');

    // A correction stays in the workflow Ledger and offers no files.
    await rootDetailsToggle(thread).click();
    await rootAddCorrection(thread).click();
    const correctionBox = thread.getByTestId('ledger-correction-box');
    await expect(correctionBox).toBeVisible();
    const correctionText = 'Only two are flaky; the third is a real bug.';
    await correctionBox
      .getByTestId('ledger-correction-input')
      .fill(correctionText);
    // More options opens the full form, which has no Files to offer.
    await correctionBox.getByTestId('ledger-correction-more').click();
    const correctionForm = thread.getByTestId('ledger-entry-form');
    await expect(correctionForm).toBeVisible();
    await expect(
      correctionForm.getByTestId('ledger-entry-form-content'),
    ).toHaveValue(correctionText);
    await expect(correctionForm.getByTestId('ledger-file-search')).toHaveCount(
      0,
    );
    await expect(
      correctionForm.getByRole('group', { name: /Files/ }),
    ).toHaveCount(0);
    await correctionForm.getByTestId('ledger-entry-form-save').click();
    const reply = thread
      .getByTestId('ledger-entry-correction')
      .filter({ hasText: correctionText });
    // It joins the workflow entry's thread, which still names its Ledger.
    await expect(reply).toBeVisible();
    await expect(workflow.getByTestId('ledger-entry-row-context')).toHaveText(
      'Workflows · Personal',
    );

    // A run this device no longer keeps has nothing to open.
    const prunedThread = feedThread(feed, 'Last week the cache warmed slowly');
    await rootDetailsToggle(prunedThread).click();
    await expect(rootOwn(prunedThread, 'ledger-entry-details')).toBeVisible();
    await expect(rootOwn(prunedThread, 'ledger-entry-source-open')).toHaveCount(
      0,
    );
    await rootDetailsToggle(prunedThread).click();

    await rootDetailsToggle(thread).click();
    await rootOwn(thread, 'ledger-entry-source-open').first().click();
    await expect(window.getByTestId('pipeline-details-nav')).toBeVisible();
    await expect(window.getByTestId('pipeline-job-view-triage')).toBeVisible();
  } catch (error) {
    await window
      .screenshot({
        path: testInfo.outputPath('ledger-feed-global-failure.png'),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
