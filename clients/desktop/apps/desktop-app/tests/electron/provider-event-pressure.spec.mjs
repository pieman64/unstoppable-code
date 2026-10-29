// Real provider → canonical V2 transcript → renderer pressure flow. The fake
// Codex server emits a deterministic burst, while one assistant payload write
// is held immediately before the durable publication boundary. The same
// fixture runs on Code worktree and Cowork scopes.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
  readChatStorageMutationIds,
} from './readChatStorage.mjs';
import { seedCoworkWorkspace, seedWorktreeChat } from './seeders/index.mjs';
import { holdProviderTranscriptWrite } from './seeders/holdProviderTranscriptWrite.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

const FIRST_MARKER = 'CANOPY-EVENT-PRESSURE-00';
const LAST_MARKER = 'CANOPY-EVENT-PRESSURE-47';
const PRESSURE_ITEMS = 48;
// Plan updates after the burst change only runtime activity, so they must not
// add one durable commit each.
const PLAN_UPDATES = 32;

function emittedPlanUpdateCount(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.direction === 'server' &&
        entry.message?.method === 'turn/plan/updated',
    ).length;
}

function emittedPressureItemCount(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.direction === 'server' &&
        entry.message?.method === 'item/completed' &&
        entry.message?.params?.item?.text?.includes('CANOPY-EVENT-PRESSURE-'),
    ).length;
}

for (const surface of ['code', 'cowork']) {
  test(`${surface} chat drains a real provider burst after its first durable assistant write resumes`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-${surface}-event-pressure-`),
    );
    const fixture = createFixture('event-pressure');
    const workspaceId =
      surface === 'code' ? 'demo-ts-pnpm-vite' : 'event-pressure-cowork';
    const chatId = 'event-pressure-chat';
    // The seeded Cowork sidebar row is a Work Entry whose stable ID is chatId.
    // Its legacy home.json is only an input to entry migration, not the live
    // selected scope that receives provider commits.
    const scopeId = surface === 'code' ? 'demo-main' : chatId;
    seedPreferences(userDataDir);
    if (surface === 'code') {
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId,
        worktreeId: scopeId,
        providerType: 'codex',
        tabs: [
          {
            id: chatId,
            title: 'Event pressure chat',
            providerType: 'codex',
            model: 'gpt-6-sol',
          },
        ],
      });
    } else {
      seedCoworkWorkspace({
        userDataDir,
        workspaceId,
        chatId,
        collapsed: false,
      });
    }

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...fixture.env,
        CANOPY_E2E_CODEX_PRESSURE_PLAN_UPDATES: String(PLAN_UPDATES),
      },
    });
    let barrier;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      if (surface === 'code') {
        await app.openMainPage();
        await app.selectWorktree(scopeId);
      } else {
        const toggle = window.getByTestId(
          `sidebar-cowork-project-${workspaceId}-toggle`,
        );
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
          await toggle.click();
        }
        await window.getByTestId(`sidebar-work-entry-${chatId}`).click();
      }
      const panel = window
        .locator('[data-testid="panel-content-chat"]:visible')
        .first();
      await expect(panel).toBeVisible();
      barrier = await holdProviderTranscriptWrite(electronApp, {
        userDataDir,
        workspaceId,
        scopeId,
        marker: FIRST_MARKER,
      });
      const composerRoot = panel.locator('[data-chat-composer-root]');
      await expect(composerRoot).toBeVisible();
      await composerRoot.getByRole('textbox').fill('Report pressure status.');
      await composerRoot.getByRole('button', { name: 'Send message' }).click();

      await expect
        .poll(async () => (await barrier.read())?.reached, {
          timeout: 45_000,
        })
        .toBe(true);
      const heldPressure = [];
      for (const delayMs of [200, 400]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const routePressure = await window.evaluate(
          (target) =>
            window.electron.ipcRenderer.invoke(
              '__CANOPY_E2E_PROVIDER_EVENT_PRESSURE__',
              target,
            ),
          { projectId: workspaceId, worktreeId: scopeId, chatId },
        );
        heldPressure.push(routePressure);
        expect(routePressure.routeCount).toBeGreaterThanOrEqual(1);
        expect(
          routePressure.activeCount + routePressure.waitingCount,
        ).toBeGreaterThan(0);
        expect(routePressure.estimatedChargedBytes).toBeGreaterThan(0);
        // Chat storage group-commits, so the route holds up to 256 KiB of
        // this chat's events in flight while the canonical write stays held
        // (GROUP_COMMIT_EVENT_PRESSURE_LIMITS), and the Codex lane delivers
        // at most 64 notifications ahead of their admission
        // (GROUP_COMMIT_OWNER_ADMISSION_BUDGET).
        expect(routePressure.estimatedChargedBytes).toBeLessThanOrEqual(
          256 * 1024,
        );
        expect(routePressure.waitingCount).toBeLessThanOrEqual(64);
        expect(routePressure.oldestAgeMs).toBeGreaterThanOrEqual(0);
        expect(routePressure.activeUncertainCount).toBe(0);
        expect(routePressure.waitingUncertainCount).toBe(0);
        console.log(
          JSON.stringify({
            surface,
            phase: 'sink_held',
            delayMs,
            routePressure,
          }),
        );
      }
      const emittedWhileHeld = emittedPressureItemCount(fixture.logPath);
      expect(emittedWhileHeld).toBeGreaterThanOrEqual(1);
      console.log(
        JSON.stringify({
          surface,
          phase: 'sink_held',
          emittedWhileHeld,
          heldPressure,
        }),
      );
      await expect(panel.getByText(LAST_MARKER, { exact: false })).toHaveCount(
        0,
      );
      await barrier.release();
      await expect(
        panel.getByText(LAST_MARKER, { exact: false }).first(),
      ).toBeVisible({
        timeout: 90_000,
      });
      await expect
        .poll(() => emittedPressureItemCount(fixture.logPath), {
          timeout: 30_000,
        })
        .toBe(PRESSURE_ITEMS);
      await expect(composerIdleAction(composerRoot)).toBeVisible({
        timeout: 30_000,
      });

      const messages = readChatStorageMessages(
        path.join(userDataDir, 'workspaces', workspaceId),
        scopeId,
        chatId,
      );
      const pressureRows = messages
        .map((message) => ({
          id: message.id,
          markers: (message.blocks ?? [])
            .filter((block) => block.type === 'text')
            .flatMap((block) =>
              Array.from(
                block.text.matchAll(/CANOPY-EVENT-PRESSURE-\d{2}/g),
                (match) => match[0],
              ),
            ),
        }))
        .filter((row) => row.markers.length > 0);
      expect(pressureRows).toHaveLength(48);
      expect(new Set(pressureRows.map((row) => row.id)).size).toBe(48);
      expect(pressureRows.map((row) => row.markers)).toEqual(
        Array.from({ length: 48 }, (_, index) => [
          `CANOPY-EVENT-PRESSURE-${String(index).padStart(2, '0')}`,
        ]),
      );
      const { live } = readChatStorageIndexes(
        path.join(userDataDir, 'workspaces', workspaceId),
        scopeId,
      );
      expect(live.runtimeByChatId[chatId]?.status).toBe('completed');
      expect(emittedPlanUpdateCount(fixture.logPath)).toBe(PLAN_UPDATES);
      // Each pressure item is its own commit; the plan updates ride on those
      // commits instead of adding one each. The margin covers turn-boundary
      // commits while staying well below one commit per plan update.
      const providerCommits = readChatStorageMutationIds(
        path.join(userDataDir, 'workspaces', workspaceId),
        scopeId,
      ).filter(
        (id) => id.startsWith(`${chatId}:`) && id.includes(':provider:'),
      ).length;
      console.log(
        JSON.stringify({ surface, phase: 'committed', providerCommits }),
      );
      expect(providerCommits).toBeGreaterThanOrEqual(PRESSURE_ITEMS);
      expect(providerCommits).toBeLessThan(PRESSURE_ITEMS + PLAN_UPDATES / 2);

      await window.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = new CanopyAppDriver(window);
      await reloaded.waitForShell({ timeout: 30_000 });
      if (surface === 'code') {
        await reloaded.openMainPage();
        await reloaded.selectWorktree(scopeId);
      } else {
        const toggle = window.getByTestId(
          `sidebar-cowork-project-${workspaceId}-toggle`,
        );
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
          await toggle.click();
        }
        await window.getByTestId(`sidebar-work-entry-${chatId}`).click();
      }
      await expect(
        window
          .locator('[data-testid="panel-content-chat"]:visible')
          .first()
          .getByText(LAST_MARKER, { exact: false })
          .first(),
      ).toBeVisible({ timeout: 45_000 });
    } finally {
      try {
        await barrier?.stop();
      } finally {
        await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
      }
    }
  });
}
