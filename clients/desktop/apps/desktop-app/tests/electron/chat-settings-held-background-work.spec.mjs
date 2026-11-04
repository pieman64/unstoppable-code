// Real stream-json provider lifecycle: settings wait for native background work,
// but an unchanged-settings follow-up reuses the live provider process.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectModelOption } from './model-selection-fixture.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SESSION_ID = `${WORKSPACE_ID}/${WORKTREE_ID}/t1`;
const TASK_ID = 'settings-hold-agent';
const INITIAL_MODEL = 'claude-haiku-4-5-20251001';
const NEXT_MODEL = 'claude-sonnet-5';
const DISPATCH_TIMEOUT = 60_000;
const FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-settings-hold-cli.mjs', import.meta.url),
);
const BACKGROUND_REASON =
  '[data-testid="queued-message-waiting-reason"][data-waiting-reason="background_work"]';

function providerLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function prompts(entries, text) {
  return entries.filter(
    (entry) =>
      entry.type === 'user' &&
      entry.sessionId === SESSION_ID &&
      entry.text.includes(text),
  );
}

// Description/title helpers can launch one-shot auxiliary sessions. Exclude
// only processes positively identified as auxiliary, never an unexplained new
// spawn (which could be the premature restart this regression guards against).
// Only processes that received a root-chat prompt count: capability probes
// and one-shot helper sessions (branch naming, summaries) spawn the CLI too.
function rootSpawns(entries) {
  const rootPids = new Set(
    entries
      .filter(
        (entry) => entry.type === 'user' && entry.sessionId === SESSION_ID,
      )
      .map((entry) => entry.pid),
  );
  return entries.filter(
    (entry) => entry.type === 'spawn' && rootPids.has(entry.pid),
  );
}

// The Claude Agent SDK passes `--model=<id>` (0.3.310+) or `--model <id>`.
function modelArg(spawn) {
  const joined = spawn.argv.find((arg) => arg.startsWith('--model='));
  if (joined) return joined.slice('--model='.length);
  expect(spawn.argv).toContain('--model');
  return spawn.argv[spawn.argv.indexOf('--model') + 1];
}

async function send(panel, text) {
  const composer = panel.getByRole('textbox').last();
  await composer.fill(text);
  // Retry only an intact draft: an earlier submission may still be releasing
  // the composer's async guard, and retrying an accepted draft would duplicate.
  await expect
    .poll(
      async () => {
        const draft = await composer.evaluate((element) => {
          const content = element.cloneNode(true);
          content
            .querySelectorAll('[data-slate-placeholder]')
            .forEach((placeholder) => placeholder.remove());
          return (content.textContent ?? '').replaceAll('\uFEFF', '').trim();
        });
        if (draft !== '') await composer.press('Enter');
        return draft;
      },
      { timeout: 15_000 },
    )
    .toBe('');
}

async function selectNextModel(window, panel, log) {
  const picker = panel.getByTestId('chat-model-picker');
  await picker.click();
  await selectModelOption(window, NEXT_MODEL);
  await expect(picker).toHaveText(/Sonnet 5(?!\.5)/);
  await expect
    .poll(() =>
      window.evaluate(
        async ({ workspaceId, worktreeId }) => {
          const tabs = await window.api.chat.loadTabs({
            projectId: workspaceId,
            worktreeId,
          });
          return tabs.tabs.find((tab) => tab.id === 't1')?.model;
        },
        { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      ),
    )
    .toBe(NEXT_MODEL);
  expect(
    rootSpawns(log()),
    'model selection must not restart the provider',
  ).toHaveLength(1);
}

async function withBackgroundChat(testInfo, run) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-settings-hold-'),
  );
  const fakeCliPath = path.join(
    userDataDir,
    'fake-claude-settings-hold-cli.mjs',
  );
  const logPath = path.join(userDataDir, 'settings-hold-provider.jsonl');
  copyFileSync(FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 't1',
        title: 'Settings hold lifecycle',
        providerType: 'claude',
        model: INITIAL_MODEL,
      },
    ],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_SETTINGS_HOLD_LOG: logPath,
      },
    }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    const log = () => providerLog(logPath);
    await send(panel, 'start background agent');
    await expect(
      panel.getByText('settings hold root reply', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
    // The live background agent is a row in the composer's background drawer.
    const agent = (await openBackgroundDrawer(panel))
      .getByTestId('background-tray-agent')
      .filter({ hasText: 'Settings hold background agent' });
    const stop = agent.getByTestId('background-tray-agent-stop');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(stop).toHaveAccessibleName('Stop agent');
    await expect.poll(() => rootSpawns(log()).length).toBe(1);
    const initialSpawn = rootSpawns(log())[0];
    expect(modelArg(initialSpawn)).toBe(INITIAL_MODEL);
    expect(prompts(log(), 'start background agent')).toHaveLength(1);
    await run({ window, panel, stop, log, initialSpawn });
  } finally {
    try {
      if (existsSync(logPath)) {
        await testInfo.attach('settings-hold-provider.jsonl', {
          body: readFileSync(logPath),
          contentType: 'application/x-ndjson',
        });
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
}

test('changed settings hold a follow-up until native background work is stopped', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await withBackgroundChat(
    testInfo,
    async ({ window, panel, stop, log, initialSpawn }) => {
      const beforeChange = log().length;
      const picker = panel.getByTestId('chat-model-picker');
      await picker.click();
      await selectModelOption(window, NEXT_MODEL);
      await expect(picker).toHaveText(/Sonnet 5(?!\.5)/);
      await expect
        .poll(() =>
          window.evaluate(
            async ({ workspaceId, worktreeId }) => {
              const tabs = await window.api.chat.loadTabs({
                projectId: workspaceId,
                worktreeId,
              });
              return tabs.tabs.find((tab) => tab.id === 't1')?.model;
            },
            { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
          ),
        )
        .toBe(NEXT_MODEL);
      expect(
        rootSpawns(log()),
        'model selection must not restart the provider',
      ).toHaveLength(1);
      expect(
        log()
          .slice(beforeChange)
          .filter(
            (entry) =>
              entry.pid === initialSpawn.pid &&
              entry.type === 'control_request' &&
              ['set_model', 'apply_flag_settings'].includes(entry.subtype),
          ),
        'model selection must not patch the live provider',
      ).toHaveLength(0);
      await expect(stop).toBeVisible();
      await expect(stop).toBeEnabled();

      const followup = 'held follow-up uses the selected model';
      await send(panel, followup);
      const bubble = panel
        .getByTestId('queued-message-bubble')
        .filter({ hasText: followup });
      await expect(bubble.locator(BACKGROUND_REASON)).toBeVisible({
        timeout: 15_000,
      });
      // The held row explains itself in place of a composer banner; its
      // Run now stops nothing, so it carries no warning.
      await expect(
        bubble.getByTestId('queued-message-settings-held-warning'),
      ).toHaveCount(0);
      expect(
        prompts(log(), followup),
        'held message must not reach the provider',
      ).toHaveLength(0);
      expect(
        rootSpawns(log()),
        'held message must not restart the provider',
      ).toHaveLength(1);
      await expect(stop).toBeEnabled();
      await stop.click();
      await expect
        .poll(
          () =>
            log().filter(
              (entry) =>
                entry.type === 'control_request' &&
                entry.subtype === 'stop_task' &&
                entry.taskId === TASK_ID &&
                entry.pid === initialSpawn.pid,
            ).length,
        )
        .toBe(1);
      await expect
        .poll(() => prompts(log(), followup).length, {
          timeout: DISPATCH_TIMEOUT,
        })
        .toBe(1);
      await expect(bubble).toHaveCount(0, { timeout: 30_000 });
      await expect(
        panel.getByText(`settings hold reply: ${followup}`, { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(composerIdleAction(panel)).toBeVisible();
      const entries = log();
      const spawns = rootSpawns(entries);
      expect(spawns).toHaveLength(2);
      expect(spawns[1].pid).not.toBe(initialSpawn.pid);
      expect(modelArg(spawns[1])).toBe(NEXT_MODEL);
      expect(prompts(entries, followup)).toHaveLength(1);
      expect(prompts(entries, followup)[0].pid).toBe(spawns[1].pid);
      const stoppedIndex = entries.findIndex(
        (entry) =>
          entry.type === 'system' &&
          entry.subtype === 'task_notification' &&
          entry.task_id === TASK_ID &&
          entry.status === 'stopped',
      );
      expect(stoppedIndex).toBeGreaterThan(-1);
      expect(entries.indexOf(spawns[1])).toBeGreaterThan(stoppedIndex);
    },
  );
});

test('a held compact row truncates its long reason before More actions and keeps the full text in its tooltip', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await withBackgroundChat(testInfo, async ({ window, panel, log }) => {
    await selectNextModel(window, panel, log);
    const followup = 'held row with a long reason';
    await send(panel, followup);
    const drawer = await openBackgroundDrawer(panel);
    const row = drawer
      .getByTestId('queued-message-bubble')
      .filter({ hasText: followup });
    const reason = row.locator(BACKGROUND_REASON);
    await expect(reason).toBeVisible({ timeout: 15_000 });
    const more = row.getByTestId('queued-message-more');
    await expect(more).toBeVisible();

    // The reason ends before the row's actions and is cut, not overflowing.
    const reasonBox = await reason.boundingBox();
    const moreBox = await more.boundingBox();
    expect(reasonBox).not.toBeNull();
    expect(moreBox).not.toBeNull();
    expect(reasonBox.x + reasonBox.width).toBeLessThanOrEqual(moreBox.x);
    expect(
      await reason.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);

    // The full text is one hover away.
    await reason.hover();
    await expect(window.getByRole('tooltip')).toHaveText(
      'Sends when background work finishes, so your new settings can apply. Run now sends it without them.',
    );
  });
});

test('a message queued behind a reply warns what Interrupt does while new settings wait', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await withBackgroundChat(testInfo, async ({ window, panel, stop, log }) => {
    // Unchanged settings: this reply runs on the live provider at once.
    await send(panel, 'keep replying');
    await expect(
      panel.getByText('settings hold reply in progress', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await selectNextModel(window, panel, log);

    const followup = 'queued behind the running reply';
    await send(panel, followup);
    const bubble = panel
      .getByTestId('queued-message-bubble')
      .filter({ hasText: followup });
    const warning = bubble.getByTestId('queued-message-settings-held-warning');
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toHaveAccessibleName('New settings are waiting');
    await expect(warning).toHaveAttribute(
      'aria-description',
      /^Changed: model\. Background work is still running, so these changes wait until it finishes\..*Interrupt stops the (current )?reply, but this message still waits for the background work\.$/,
    );
    // Not held yet, and no composer banner: the row carries the warning.
    await expect(panel.locator(BACKGROUND_REASON)).toHaveCount(0);
    await expect(panel.getByText(/If you send now/)).toHaveCount(0);
    expect(prompts(log(), followup)).toHaveLength(0);
    await expect(stop).toBeEnabled();
  });
});

test('D3: unchanged settings send to the same provider while native background work runs', async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withBackgroundChat(
    testInfo,
    async ({ window, panel, stop, log, initialSpawn }) => {
      // Observe the entire send, not just its final DOM: a transient background
      // reason would incorrectly present an unchanged-settings send as held.
      await window.evaluate((selector) => {
        const probe = { seen: Boolean(document.querySelector(selector)) };
        const containsReason = (node) =>
          node instanceof Element &&
          (node.matches(selector) || Boolean(node.querySelector(selector)));
        const observer = new MutationObserver((records) => {
          if (
            document.querySelector(selector) ||
            records.some(
              (record) =>
                (record.type === 'attributes' &&
                  record.oldValue === 'background_work') ||
                [...record.addedNodes].some(containsReason),
            )
          )
            probe.seen = true;
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-waiting-reason'],
          attributeOldValue: true,
        });
        globalThis.__settingsHoldReasonProbe = { probe, observer };
      }, BACKGROUND_REASON);
      const followup = 'unchanged-settings follow-up';
      await send(panel, followup);
      await expect
        .poll(() => prompts(log(), followup).length, {
          timeout: DISPATCH_TIMEOUT,
        })
        .toBe(1);
      await expect(
        panel.getByText(`settings hold reply: ${followup}`, { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(composerIdleAction(panel)).toBeVisible();
      expect(prompts(log(), followup)[0].pid).toBe(initialSpawn.pid);
      expect(rootSpawns(log())).toHaveLength(1);
      await expect(panel.locator(BACKGROUND_REASON)).toHaveCount(0);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      await expect(stop).toBeVisible();
      expect(
        await window.evaluate(() => {
          const { probe, observer } = globalThis.__settingsHoldReasonProbe;
          observer.disconnect();
          return probe.seen;
        }),
      ).toBe(false);
    },
  );
});
