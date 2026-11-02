import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { prepareStreamFixture } from './seeders/delegationStreamFixture.mjs';
import {
  seedWorktreeChat,
  seedWorkspaceApprovals,
  writeJson,
} from './seeders/index.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import {
  baseManagedDelegationPreferences,
  retainedDelegationRuns,
} from './fixtures/delegation-capabilities/helpers.mjs';
import { createStreamSmokeScript } from './fixtures/delegation-stream-script.mjs';

const PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE = 'demo-main';
const SCOPE = { projectId: PROJECT, worktreeId: WORKTREE };

async function openChat(window, chatId) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE);
  const tab = window.locator(`[data-chat-id="${chatId}"]`).first();
  if (await tab.count()) await tab.click();
  return window.getByTestId('panel-content-chat');
}

async function openCard(panel, delegationId) {
  const card = panel.locator(
    `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
  );
  await expect(async () => {
    const collapsed = panel.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await collapsed.count())
      await collapsed.first().click({ timeout: 2000 });
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const expand = card.getByRole('button', { name: 'Expand delegated task' });
  if (await expand.count()) await expand.click();
  return card;
}

// Instrument the real legacy IPC wrapper; do not fabricate its reply. Lives
// in main so the count survives renderer reloads. Pattern: activity-states-page.
async function countLegacyCalls(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const channel = 'managed-delegation:transcript';
    const original = ipcMain._invokeHandlers.get(channel);
    if (!original) throw new Error('Legacy transcript handler missing');
    globalThis.__streamLegacyCalls = 0;
    ipcMain._invokeHandlers.set(channel, (event, ...args) => {
      globalThis.__streamLegacyCalls++;
      return original(event, ...args);
    });
  });
}

async function assertFixture(window, fixture) {
  const receipt = JSON.parse(
    readFileSync(`${fixture.specPath}.result.json`, 'utf8'),
  );
  expect(receipt.rowCount).toBe(501);
  expect(receipt.status).toBe('settled');
  expect(receipt.cursor).toEqual(expect.any(String));
  expect(receipt.fullOutputRef.byteLength).toBeGreaterThan(65_536);
  expect(receipt.secondPageLength).toBeGreaterThan(0);
  expect(receipt.blocks).toMatchObject({
    messageId: 'blocks-row-1',
    omittedBlockCount: 46,
    storedOrdinal: 42,
  });
  expect(receipt.blocks.storedByteLength).toBeGreaterThan(65_536);
  expect(receipt.primary.storedByteLength).toBeGreaterThan(65_536);
  expect(receipt.primary.inlineLength).toBeGreaterThan(4_000);
  expect(receipt.live).toMatchObject({
    status: 'open',
    pagedMessageId: 'live-row-1',
    omittedBlockCount: 42,
    newestRowIds: ['live-row-1'],
  });
  const pages = await window.evaluate(
    async ({ scope, chatId, target }) => {
      const parent = await window.api.chat.getTranscriptPage({
        ...scope,
        chatId,
      });
      // Child pages are read through the core relay, as the shared reader does.
      const reply = await window.canopyCore.invoke({
        kind: 'request',
        method: 'core.chat.transcript.page',
        params: {
          scope: {
            workspaceId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId,
          },
          target,
        },
      });
      if (!reply.ok) throw new Error(reply.error.message);
      return { parent, child: reply.value };
    },
    { scope: SCOPE, chatId: fixture.chatId, target: receipt.target },
  );
  const card = pages.parent.messages
    .flatMap((row) => row.blocks)
    .find((block) => block.type === 'delegated_agent_call');
  expect(card).toMatchObject({
    transcriptStore: 'chat-stream-v2',
    status: 'completed',
    runGeneration: 1,
  });
  expect(pages.child.cursor).toEqual(expect.any(String));
  expect(pages.child.messages.map((row) => row.id)).toContain('stream-row-500');
  const output = pages.child.messages
    .flatMap((row) => row.blocks)
    .find((block) => block.type === 'tool_result');
  expect(output.fullOutputRef.byteLength).toBeGreaterThan(65_536);
}

// A tool card outside every delegation card, in the primary transcript.
function primaryTool(panel, toolName) {
  return panel
    .locator(
      `[data-tool-name="${toolName}"]:not([data-testid="chat-delegated-agent"] *)`,
    )
    .first();
}

async function expandPrimaryTool(panel, toolName) {
  const tool = primaryTool(panel, toolName);
  await expect(async () => {
    const collapsed = panel.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await collapsed.count())
      await collapsed.first().click({ timeout: 2000 });
    await expect(tool).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await tool.getByRole('button').first().click();
  return tool;
}

// A row larger than a child page arrives without blocks; its blocks open on
// demand, one bounded page at a time, and its stored bodies open as usual.
async function assertPagedBlocks(window, panel, fixture) {
  const card = await openCard(panel, fixture.blocksDelegationId);
  // The oversized row fills the newest page on its own.
  const row = card.locator('[data-child-row-id="blocks-row-1"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Causal red before the block reader: the omitted row offers no blocks.
  const show = row.getByRole('button', { name: 'Show message', exact: true });
  await expect(show).toBeVisible({ timeout: 10_000 });
  await show.click();
  await expect(row.getByText('paged block first sentinel')).toBeVisible();
  await expect(async () => {
    const more = row.getByRole('button', { name: 'Show more', exact: true });
    if (await more.count()) await more.click({ timeout: 2000 });
    await expect(row.getByText('paged block last sentinel')).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 60_000 });
  // Every long filler block has its own body viewer; open the stored Read
  // result's at its absolute ordinal.
  const stored = row.locator('[data-block-ordinal="42"]');
  await stored.getByTestId('chat-tool-output-open').click();
  await stored.getByTestId('chat-tool-output-next').click();
  await expect(
    window.getByText('paged stored tail sentinel', { exact: false }).last(),
  ).toBeVisible();
}

// Control: desktop already reads primary stored bodies and shows long inline
// results in full; the Portal flow asserts the same results.
async function assertPrimaryOutput(window, panel) {
  const read = await expandPrimaryTool(panel, 'Read');
  await read.getByTestId('chat-tool-output-open').click();
  await window.getByTestId('chat-tool-output-next').click();
  await expect(
    window.getByText('primary stored tail sentinel', { exact: false }).last(),
  ).toBeVisible();
  const grep = await expandPrimaryTool(panel, 'Grep');
  await expect(
    grep.getByText('primary inline tail sentinel', { exact: false }),
  ).toBeVisible();
}

// The E2E fixture's release control appends one row to the open live run and
// publishes its committed card update, through the production methods.
function releaseLive(electronApp, label) {
  return electronApp.evaluate(
    (_electron, value) => globalThis.__CANOPY_E2E_STREAM_LIVE_RELEASE__(value),
    label,
  );
}

// At the newest page, a committed card event refreshes the mounted card in
// place: the new row appears, and the open paged row stays open and focused.
async function assertLiveRefresh(electronApp, panel, fixture) {
  // A running card is also listed with the agent activity; read the transcript's.
  const card = await openCard(
    panel.getByTestId('chat-message-list-content'),
    fixture.liveDelegationId,
  );
  const row = card.locator('[data-child-row-id="live-row-1"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: 'Show message', exact: true }).click();
  await expect(row.getByText('live block first sentinel')).toBeVisible();
  const hide = row.getByRole('button', { name: 'Hide message', exact: true });
  await hide.focus();
  const receipt = await releaseLive(electronApp, 'refresh');
  expect(receipt.after.streamRevision).toBeGreaterThan(
    receipt.before.streamRevision,
  );
  expect(receipt.after.cardRevision).toBeGreaterThan(
    receipt.before.cardRevision,
  );
  await expect(
    card.locator('[data-child-row-id="live-release-refresh"]'),
  ).toBeVisible({ timeout: 15_000 });
  // Causal red before 16d: the refresh replaces the window with the newest
  // page alone, so the paged row the user had open disappears.
  await expect(row.getByText('live block first sentinel')).toBeVisible();
  await expect(hide).toBeFocused();
}

// With earlier pages loaded, the window stays where the user is reading and
// offers the newest messages instead of jumping to them.
async function assertLiveHistory(electronApp, panel, fixture) {
  // A running card is also listed with the agent activity; read the transcript's.
  const card = await openCard(
    panel.getByTestId('chat-message-list-content'),
    fixture.liveDelegationId,
  );
  await expect(card.locator('[data-child-row-id="live-row-1"]')).toBeVisible({
    timeout: 10_000,
  });
  await card
    .getByRole('button', { name: 'Load earlier messages', exact: true })
    .click();
  await expect(card.locator('[data-child-row-id="live-row-0"]')).toBeVisible();
  await releaseLive(electronApp, 'history');
  const latest = card.getByRole('button', { name: 'Show latest', exact: true });
  // Causal red before 16d: the window jumps to the newest page instead.
  await expect(latest).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText('New messages', { exact: true })).toBeVisible();
  await expect(card.locator('[data-child-row-id="live-row-0"]')).toBeVisible();
  await latest.click();
  await expect(
    card.locator('[data-child-row-id="live-release-history"]'),
  ).toBeVisible();
}

// Independent cases: before S2 each must reach the same behavioral row
// assertion, rather than skipping the later behaviors after the first red.
for (const behavior of [
  'newest page',
  'earlier page',
  'full output',
  'reload',
  'option off',
  'paged blocks',
  'primary output',
  'live refresh',
  'live history',
]) {
  test(`stream-backed delegation: ${behavior}`, async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-stream-'));
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const fixture = prepareStreamFixture({ userDataDir });
    let { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.extraEnv,
    });
    try {
      await countLegacyCalls(electronApp);
      let window = await electronApp.firstWindow();
      await openChat(window, fixture.chatId);
      await assertFixture(window, fixture);
      if (behavior === 'option off') {
        expect(
          await electronApp.evaluate(() => globalThis.__streamLegacyCalls),
        ).toBe(0);
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        // Keep the spec path for idempotence, but unset the write switch.
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: {
            CANOPY_E2E_CHAT_FORMAT4: undefined,
            CANOPY_E2E_SEED_STREAM_FIXTURE: fixture.specPath,
          },
        }));
        await countLegacyCalls(electronApp);
        window = await electronApp.firstWindow();
        await openChat(window, fixture.chatId);
        await assertFixture(window, fixture);
      }
      const panel = window.getByTestId('panel-content-chat');
      if (behavior === 'reload') {
        await window.reload();
        await openChat(window, fixture.chatId);
      }
      if (behavior === 'paged blocks') {
        await assertPagedBlocks(window, panel, fixture);
        return;
      }
      if (behavior === 'primary output') {
        await assertPrimaryOutput(window, panel);
        return;
      }
      if (behavior === 'live refresh') {
        await assertLiveRefresh(electronApp, panel, fixture);
        return;
      }
      if (behavior === 'live history') {
        await assertLiveHistory(electronApp, panel, fixture);
        return;
      }
      const card = await openCard(panel, fixture.delegationId);
      await expect(card).not.toContainText('stale inline child sentinel');
      // Causal red on consolidation: the seeded row is missing, not a missing
      // export, launch error or fixture-precondition failure.
      await expect(
        card.locator('[data-child-row-id="stream-row-500"]'),
      ).toBeVisible({ timeout: 10_000 });
      await expect(card.getByTestId('delegation-child-pages')).toBeVisible();
      if (behavior === 'earlier page') {
        await expect(
          card.locator('[data-child-row-id="stream-row-0"]'),
        ).toHaveCount(0);
        await card
          .getByRole('button', { name: 'Load earlier messages', exact: true })
          .click();
        await expect(
          card.locator('[data-child-row-id="stream-row-0"]'),
        ).toBeVisible();
      }
      if (behavior === 'full output') {
        // The child Read call's body, like a primary one, opens on demand.
        await card
          .locator(
            '[data-child-row-id="stream-row-500"] [data-tool-name="Read"]',
          )
          .getByRole('button')
          .first()
          .click();
        await card.getByTestId('chat-tool-output-open').click();
        await window.getByTestId('chat-tool-output-next').click();
        await expect(
          window
            .getByText('second content page sentinel', { exact: false })
            .last(),
        ).toBeVisible();
      }
      if (behavior === 'reload') {
        await window.reload();
        await openChat(window, fixture.chatId);
        const remounted = await openCard(
          window.getByTestId('panel-content-chat'),
          fixture.delegationId,
        );
        await expect(
          remounted.locator('[data-child-row-id="stream-row-500"]'),
        ).toBeVisible();
        await expect(remounted).not.toContainText(
          'stale inline child sentinel',
        );
      }
      expect(
        await electronApp.evaluate(() => globalThis.__streamLegacyCalls),
      ).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('live fake-provider capture writes a stream-backed card and child rows', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-stream-live-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: PROJECT,
    defaultMode: 'full-access',
  });
  writeJson(
    path.join(userDataDir, 'preferences.json'),
    baseManagedDelegationPreferences(),
  );
  const chatId = 'stream-live-parent';
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
    tabs: [
      {
        id: chatId,
        title: 'Live stream smoke',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
      },
    ],
  });
  const inference = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'foreground',
    caseId: 'stream-smoke',
    script: createStreamSmokeScript(),
  });
  writeFileSync(
    path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
    `// ${inference.canary}\nexport const streamSmoke = true;\n`,
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CHAT_FORMAT4: '1',
      CANOPY_MOCK_LLM_BASE_URL: inference.url,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await openChat(window, chatId);
    await window
      .getByRole('textbox')
      .first()
      .fill(
        `[${inference.parentMarker}] Ask a delegate to inspect delegation-evidence.txt.`,
      );
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        () =>
          retainedDelegationRuns({
            userDataDir,
            workspaceId: PROJECT,
            worktreeId: WORKTREE,
          }).filter((run) => run.state.status === 'completed').length,
        { timeout: 180_000 },
      )
      .toBe(1);
    const parent = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...SCOPE, chatId },
    );
    const card = parent.messages
      .flatMap((row) => row.blocks)
      .find((block) => block.type === 'delegated_agent_call');
    expect(card).toMatchObject({
      transcriptStore: 'chat-stream-v2',
      status: 'completed',
    });
    const child = await window.evaluate(
      async (params) => {
        const reply = await window.canopyCore.invoke({
          kind: 'request',
          method: 'core.chat.transcript.page',
          params,
        });
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.value;
      },
      {
        scope: {
          workspaceId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
          chatId,
        },
        target: {
          kind: 'delegation',
          chatId,
          delegationId: card.delegationId,
          runGeneration: card.runGeneration,
        },
      },
    );
    expect(child.messages.length).toBeGreaterThan(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await inference.close();
  }
});
