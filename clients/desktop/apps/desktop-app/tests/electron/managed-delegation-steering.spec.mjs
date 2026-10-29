// A delegate's steering request to its busy Claude root chat. The child asks
// for steering while the parent's model call is in flight, so Claude Code
// queues the message; the parent then ends its turn and Claude Code starts a
// new turn for the queued message on the same query. That turn must be owned
// like any other: its reply reaches the chat, the chat queue is released when
// it ends, and the next message sends instead of waiting behind it.
// See managed-delegation.spec.mjs for the wider parent/child case matrix and
// delegationRuntime.mjs for the shared mock inference harness this file
// scripts through its `script` hook.
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect as baseExpect, test } from '@playwright/test';
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
const TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });

test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';

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

test('a delegate steering request that starts its own root turn leaves the chat queue free', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const caseId = 'steering-starts-turn';
  const markers = {
    steering: `DELEGATE_STEERING_REQUEST_${caseId}`,
    steeringReply: `Answered the delegate steering request for ${caseId}`,
    parentDone: `Parent turn finished for ${caseId}`,
    followUp: `FOLLOW_UP_${caseId}`,
    followUpReply: `Answered the follow-up for ${caseId}`,
  };
  const observed = { steeredParentCalls: 0, childSteeringResult: undefined };
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-steering-'),
  );
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'background',
    caseId,
    script: steeringScript(markers, observed),
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

    // A delegate's message is host-owned: it is recorded in the transcript but
    // neither listed as a pending delivery nor shown as a user message.
    await expect
      .poll(() => recordedSteeringMessages(userDataDir, markers.steering))
      .toEqual([{ hidden: true }]);
    await expect(panel.getByTestId('input-delivery-row')).toHaveCount(0);
    await expect(
      panel.getByText('requested steering from its direct parent'),
    ).toHaveCount(0);

    // The chat queue is free: the next message sends instead of waiting.
    await send(`[${fixture.parentMarker}] ${markers.followUp}`);
    await expect(
      panel.getByText(markers.followUpReply, { exact: true }),
    ).toBeVisible({ timeout: scaled(60_000) });
    await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
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
});
