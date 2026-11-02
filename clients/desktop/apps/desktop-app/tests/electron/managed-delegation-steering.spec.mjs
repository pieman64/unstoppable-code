// A delegate's steering request (RequestSteering) to its Claude root chat.
// The request steers into a running root turn on arrival; otherwise it waits
// as a hidden internal queue row and is delivered later. It never shows while
// it waits, and once sent the root chat shows it as a user row under the
// trusted sender marker "Sent by <delegate>" (D15), never the text-derived
// steering-request title, never the hidden wrapper and never with an
// automation banner. The first case steers into a busy root and checks
// that the turn it starts is owned like any other: its reply reaches the
// chat, the chat queue is released when it ends, and the next message sends
// instead of waiting behind it.
// See managed-delegation.spec.mjs for the wider parent/child case matrix and
// delegationRuntime.mjs for the shared mock inference harness (its
// `request-steering` actions and `script` hook).
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect as baseExpect, test } from '@playwright/test';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat, seedWorkspaceApprovals } from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';
import { readChatStorageMessages } from './readChatStorage.mjs';

// Windows qualification runs under emulation, where native provider turns
// take several times longer than on macOS. Mirrors managed-delegation.spec.mjs.
const hostPlatform = hostOperatingSystem();
const TIMEOUT_SCALE = hostPlatform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
// The child's task description the parent's DelegateTask call names, as the
// host records it for the message's trusted sender.
const SENDER_MARKER = 'Sent by Independent error handling review';
const WRAPPER_TEXT =
  /system_instruction|subordinate_request|requested steering from its direct parent/;

// The delegate's message as recorded in the parent chat's transcript.
function recordedSteeringMessages(userDataDir, steering) {
  try {
    return readChatStorageMessages(
      path.join(userDataDir, 'workspaces', workspaceId),
      worktreeId,
      'delegating-parent',
    )
      .filter(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.blocks).includes(steering),
      )
      .map((message) => ({ hidden: message.hidden === true }));
  } catch {
    // Storage is written as the chat runs; read it again on the next poll.
    return [];
  }
}

function lastUserText(body) {
  const lastUser = (body.messages ?? body.input ?? [])
    .filter((item) => item.role === 'user')
    .at(-1);
  return JSON.stringify(lastUser?.content ?? '');
}

function requestSteeringTool(body) {
  return (body.tools ?? []).find((tool) =>
    /(?:^|__)RequestSteering$/.test(tool.name ?? ''),
  )?.name;
}

// Records every moment the request shows in a queued bubble, or the hidden
// wrapper shows anywhere in the window, from now until the test reads it.
async function watchForSteeringLeaks(window, request) {
  await window.evaluate(
    ({ request, wrapper }) => {
      const leaks = [];
      globalThis.__steeringLeaks = leaks;
      const pattern = new RegExp(wrapper);
      const check = () => {
        if (leaks.length > 20) return;
        for (const bubble of document.querySelectorAll(
          '[data-testid="queued-message-bubble"]',
        ))
          if (bubble.textContent?.includes(request))
            leaks.push(`queued bubble: ${bubble.textContent}`);
        if (pattern.test(document.body.textContent ?? ''))
          leaks.push('hidden wrapper text');
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },
    { request, wrapper: WRAPPER_TEXT.source },
  );
}
const steeringLeaks = (window) =>
  window.evaluate(() => globalThis.__steeringLeaks);

// Once sent, the request is one user row under its trusted sender marker.
async function expectSentSteeringRow(panel, request) {
  const row = panel.locator('[data-role="user"]').filter({ hasText: request });
  await expect(row).toHaveCount(1, { timeout: scaled(30_000) });
  await expect(row.getByTestId('agent-sent-marker-name')).toHaveText(
    SENDER_MARKER,
  );
  await expect(row.getByTestId('agent-sent-marker-unverified')).toHaveCount(0);
  await expect(row.getByTestId('steering-request-title')).toHaveCount(0);
  await expect(row).not.toContainText(WRAPPER_TEXT);
  await expect(panel.getByTestId('chat-automation-info')).toHaveCount(0);
}

// The parent spawns one background child, then holds its next model call
// until the child's steering request has been admitted, and ends that turn.
// The child requests steering only once that parent call is in flight.
function steeringScript(markers, observed) {
  let releaseParentCall;
  const parentCallInFlight = new Promise((resolve) => {
    releaseParentCall = resolve;
  });
  let releaseSteeringAdmitted;
  const steeringAdmitted = new Promise((resolve) => {
    releaseSteeringAdmitted = resolve;
  });
  let parentTurnHeld = false;
  return async (ctx) => {
    const latest = lastUserText(ctx.body);
    if (ctx.role === 'child') {
      if (!ctx.results) {
        await parentCallInFlight;
        const name = requestSteeringTool(ctx.body);
        if (!name) throw new Error('The child was not offered RequestSteering');
        return ctx.reply({
          toolCalls: [{ name, input: { message: markers.steering } }],
          stopReason: 'tool_use',
        });
      }
      observed.childSteeringResult = ctx.results;
      releaseSteeringAdmitted();
      return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
    }
    if (ctx.role !== 'parent') return undefined;
    if (latest.includes(markers.followUp))
      return ctx.reply({ text: markers.followUpReply, stopReason: 'end_turn' });
    if (latest.includes(markers.steering)) {
      observed.steeredParentCalls += 1;
      return ctx.reply({ text: markers.steeringReply, stopReason: 'end_turn' });
    }
    if (!ctx.results)
      return ctx.reply({
        toolCalls: [{ name: ctx.spawnTool, input: ctx.spawnInput }],
        stopReason: 'tool_use',
      });
    if (!parentTurnHeld) {
      parentTurnHeld = true;
      releaseParentCall();
      await steeringAdmitted;
      return ctx.reply({ text: markers.parentDone, stopReason: 'end_turn' });
    }
    return undefined;
  };
}

// Seeds one Claude root chat with managed delegation, launches the app on the
// scripted inference, opens the chat and runs `body`. Keeps the user data when
// the test fails.
async function runSteeringCase(testInfo, inference, body) {
  test.setTimeout(scaled(240_000));
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-steering-'),
  );
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'background',
    ...inference,
  });
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeFileSync(
    path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
    `// ${fixture.canary}\n`,
  );
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId,
    defaultMode: 'full-access',
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        managedDelegationMode: 'explicit-only',
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
        codexMultiAgentWorktreeChatsEnabled: false,
      },
    }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: 'delegating-parent',
        title: 'Delegating parent',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  let assertionsCompleted = false;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(worktreeId);
    const panel = window.getByTestId('panel-content-chat');
    const send = async (text) => {
      await window.getByRole('textbox').first().fill(text);
      await window.getByRole('button', { name: 'Send message' }).click();
    };
    await body({ fixture, window, panel, send, userDataDir });
    expect(fixture.errors).toEqual([]);
    assertionsCompleted = true;
  } finally {
    if (!assertionsCompleted)
      await testInfo.attach('failure-user-data-directory', {
        body: userDataDir,
        contentType: 'text/plain',
      });
    await closeCanopy(electronApp, userDataDir, {
      keepUserData: !assertionsCompleted,
    });
    await fixture.close();
    if (assertionsCompleted) cleanupDemoWorkspaces(demo);
  }
}

test('a delegate steering request that starts its own root turn leaves the chat queue free', async ({}, testInfo) => {
  const caseId = 'steering-starts-turn';
  const markers = {
    steering: `DELEGATE_STEERING_REQUEST_${caseId}`,
    steeringReply: `Answered the delegate steering request for ${caseId}`,
    parentDone: `Parent turn finished for ${caseId}`,
    followUp: `FOLLOW_UP_${caseId}`,
    followUpReply: `Answered the follow-up for ${caseId}`,
  };
  const observed = { steeredParentCalls: 0, childSteeringResult: undefined };
  await runSteeringCase(
    testInfo,
    { caseId, script: steeringScript(markers, observed) },
    async ({ fixture, window, panel, send, userDataDir }) => {
      await watchForSteeringLeaks(window, markers.steering);
      await send(`[${fixture.parentMarker}] Delegate a background review.`);

      // The steered message reaches the parent as its own model call, and the
      // reply to it is shown in the chat.
      await expect
        .poll(() => observed.steeredParentCalls, { timeout: scaled(120_000) })
        .toBeGreaterThan(0);
      expect(observed.childSteeringResult).toContain('accepted');
      await expect(
        panel.getByText(markers.steeringReply, { exact: true }),
      ).toBeVisible({ timeout: scaled(60_000) });

      // Once sent, the delegate's message is recorded and shown as its steering
      // request, never listed as a pending delivery.
      await expect
        .poll(() => recordedSteeringMessages(userDataDir, markers.steering))
        .toEqual([{ hidden: false }]);
      await expectSentSteeringRow(panel, markers.steering);
      await expect(panel.getByTestId('input-delivery-row')).toHaveCount(0);

      // The chat queue is free: the next message sends instead of waiting.
      await send(`[${fixture.parentMarker}] ${markers.followUp}`);
      await expect(
        panel.getByText(markers.followUpReply, { exact: true }),
      ).toBeVisible({ timeout: scaled(60_000) });
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      expect(await steeringLeaks(window)).toEqual([]);
    },
  );
});

const childSteeringResult = (fixture) =>
  fixture.requests
    .filter((request) => request.role === 'child')
    .map((request) => request.results)
    .join('\n');

// The root turn ended before the child asks, so the request is sent as its
// own root turn.
test('a delegate steering request to an idle root chat is sent as its own turn', async ({}, testInfo) => {
  await runSteeringCase(
    testInfo,
    { caseId: 'steering-idle-root', action: 'request-steering' },
    async ({ fixture, window, panel, send, userDataDir }) => {
      await watchForSteeringLeaks(window, fixture.steeringRequest);
      await send(`[${fixture.parentMarker}] Delegate a background review.`);
      await expect(
        panel.getByText(fixture.continued, { exact: true }),
      ).toBeVisible({ timeout: scaled(120_000) });
      await expect(panel.getByTestId('chat-stop-generation')).toHaveCount(0);

      fixture.releaseChild();
      await expect(
        panel.getByText(fixture.steeringReply, { exact: true }),
      ).toBeVisible({ timeout: scaled(120_000) });
      expect(childSteeringResult(fixture)).toContain('accepted');
      await expect
        .poll(() =>
          recordedSteeringMessages(userDataDir, fixture.steeringRequest),
        )
        .toEqual([{ hidden: false }]);
      await expectSentSteeringRow(panel, fixture.steeringRequest);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      expect(await steeringLeaks(window)).toEqual([]);
    },
  );
});

// A user message already waits behind the running root turn, so the request
// waits as a hidden row behind it: only the user's message shows as queued.
// After the root turn ends it is delivered, steered into the follow-up's turn
// or sent as its own depending on timing, and either way shows under its
// sender marker.
test('a delegate steering request queued behind a user message stays hidden until delivered', async ({}, testInfo) => {
  const followUp = 'STEERING_QUEUED_FOLLOW_UP';
  await runSteeringCase(
    testInfo,
    { caseId: 'steering-queued', action: 'request-steering-queued' },
    async ({ fixture, window, panel, send }) => {
      await watchForSteeringLeaks(window, fixture.steeringRequest);
      await send(`[${fixture.parentMarker}] Delegate a background review.`);
      // The parent's call after its spawn is held, so its turn keeps running.
      await expect
        .poll(
          () =>
            fixture.requests.some(
              (request) =>
                request.role === 'parent' &&
                request.results.includes('delegationId'),
            ) && fixture.requests.some((request) => request.role === 'child'),
          { timeout: scaled(120_000) },
        )
        .toBe(true);
      const composer = window.getByRole('textbox').first();
      await composer.fill(`[${fixture.parentMarker}] ${followUp}`);
      await composer.press('Enter');
      const queued = panel.getByTestId('queued-message-bubble');
      await expect(queued).toHaveCount(1);
      await expect(queued).toContainText(followUp);

      fixture.releaseChild();
      await expect
        .poll(() => childSteeringResult(fixture), { timeout: scaled(60_000) })
        .toContain('accepted');
      await expect(queued).toHaveCount(1);
      await expect(queued).not.toContainText(fixture.steeringRequest);
      // The delegate's card says it waits on the parent while its request is
      // queued, and the queued row it waits behind keeps its own controls.
      await expect(
        panel
          .getByTestId('chat-delegated-agent')
          .first()
          .getByTestId('delegated-agent-waiting-on-parent'),
      ).toHaveText('Waiting for the parent');
      await queued.getByTestId('queued-message-more').click();
      await expect(window.getByTestId('queued-message-edit')).toBeVisible();
      await expect(window.getByTestId('queued-message-cancel')).toBeVisible();
      await window.keyboard.press('Escape');

      fixture.releaseParentTurn();
      await expect(
        panel.getByText(fixture.steeringReply, { exact: true }),
      ).toBeVisible({ timeout: scaled(120_000) });
      await expect(queued).toHaveCount(0);
      await expect(
        panel.locator('[data-role="user"]').filter({ hasText: followUp }),
      ).toHaveCount(1);
      await expectSentSteeringRow(panel, fixture.steeringRequest);
      expect(await steeringLeaks(window)).toEqual([]);
    },
  );
});
