// Shared deterministic harness for the in-process Codex pipeline runtime
// specs. Both `pipeline-codex-runtime.spec.mjs` (behavioral coverage) and
// `codex-pipeline-streaming.spec.mjs` (durable streaming coverage) drives the same
// mock app-server fixture, so the seeding, pipeline YAML, and dispatch flow
// live here instead of being duplicated per spec.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { withoutChatSummaryTraffic } from './fixtures/codex-chat-summary-traffic.mjs';

export const WORKTREE_BRANCH = 'demo-main';

export const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-app-server.mjs',
);

export function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function createFixture(mode, reply = 'done') {
  const runtimeDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-codex-runtime-'),
  );
  const canonicalHome = path.join(runtimeDir, 'canonical-home');
  const statePath = path.join(runtimeDir, 'state.json');
  const logPath = path.join(runtimeDir, 'protocol.jsonl');
  const releasePath = path.join(runtimeDir, 'release');
  const crashPath = path.join(runtimeDir, 'crash');
  mkdirSync(canonicalHome, { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} })}\n`,
  );
  return {
    logPath,
    runtimeDir,
    releasePath,
    crashPath,
    env: {
      CODEX_EXECUTABLE: FIXTURE_PATH,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
      CANOPY_E2E_CODEX_MODE: mode,
      CANOPY_E2E_CODEX_REPLY: reply,
      CANOPY_E2E_CODEX_RELEASE_PATH: releasePath,
      CANOPY_E2E_CODEX_CRASH_PATH: crashPath,
    },
  };
}

export function protocolEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Every client request the fake app-server received, including background
 * helper traffic such as the chat-summary thread. Specs that count or order a
 * conversation's turns should use `conversationRequests` instead.
 */
export function protocolRequests(logPath) {
  return protocolEntries(logPath)
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

/**
 * Client requests that belong to conversations, without the chat-summary
 * helper's thread. The first message of a chat schedules a summary that runs
 * through the same fake app-server when the summary model is Codex (the
 * default), on its own thread and at a background-dependent time.
 */
export function conversationRequests(logPath) {
  return withoutChatSummaryTraffic(protocolEntries(logPath))
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

/**
 * Maps each fake app-server thread id to the model that opened it.
 *
 * The pipeline Codex runner sends `model` on `thread/start` / `thread/resume`
 * (`execution-runtime.ts` `commonParams`), not on `turn/start`, so a spec that
 * wants the model behind a given turn has to correlate the turn's `threadId`
 * back through the opening request/response pair.
 *
 * A request that carries no `params.model` is deliberately NOT recorded: a
 * missing entry then means "this thread was never correlated", which is
 * distinguishable from a thread that really did open on the wrong model. If
 * `undefined` were stored instead, both cases would fail a spec the same way.
 */
export function threadModelsByThreadId(logPath) {
  if (!existsSync(logPath)) return new Map();
  const entries = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const pendingModelByRequestId = new Map();
  const models = new Map();
  for (const entry of entries) {
    const message = entry.message;
    if (
      entry.direction === 'client' &&
      (message?.method === 'thread/start' ||
        message?.method === 'thread/resume')
    ) {
      if (message.params?.model !== undefined) {
        pendingModelByRequestId.set(message.id, message.params.model);
      }
      continue;
    }
    if (
      entry.direction === 'server' &&
      message?.result?.thread?.id &&
      pendingModelByRequestId.has(message.id)
    ) {
      models.set(
        message.result.thread.id,
        pendingModelByRequestId.get(message.id),
      );
    }
  }
  return models;
}

export function pipelineTurnRequests(logPath) {
  const requests = conversationRequests(logPath);
  const initial = requests.find(
    (request) =>
      request.method === 'turn/start' &&
      JSON.stringify(request.params?.input).includes(
        'Exercise the in-process Codex pipeline runtime.',
      ),
  );
  return initial
    ? requests.filter(
        (request) =>
          request.method === 'turn/start' &&
          request.params?.threadId === initial.params?.threadId,
      )
    : [];
}

export function pipelineInitialTurnRequests(logPath) {
  return conversationRequests(logPath).filter(
    (request) =>
      request.method === 'turn/start' &&
      JSON.stringify(request.params?.input).includes(
        'Exercise the in-process Codex pipeline runtime.',
      ),
  );
}

export function pipelineYaml(name, options = {}) {
  return [
    `name: ${name}`,
    'on: dispatch',
    ...(options.capabilitySkill
      ? [
          'plugin_collections:',
          '  - id: e2e_capability',
          '    name: E2E capability',
          '    defaults:',
          '      - type: skill',
          '        source:',
          '          type: builtin',
          '          id: app',
          `        skill_name: ${options.capabilitySkill}`,
          '        required: true',
        ]
      : []),
    'jobs:',
    '  verify:',
    '    name: Verify Codex runtime',
    '    steps:',
    '      - id: codex',
    '        name: Run Codex',
    '        uses: builtin/agent-prompt',
    `        timeout_minutes: ${String(options.timeoutMinutes ?? 1)}`,
    '        with:',
    '          model: gpt-6-sol',
    '          permission_preset: read_only',
    `          fast_mode: ${options.fastMode ? 'true' : 'false'}`,
    '          prompt: Exercise the in-process Codex pipeline runtime.',
    ...(options.capabilitySkill
      ? ['          plugin_collection_id: e2e_capability']
      : []),
    ...(options.structured
      ? [
          '          structured_output_schema: >-',
          '            {"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}',
        ]
      : []),
    '',
  ].join('\n');
}

export async function openWorkspaceAndRun(window, pipelineName) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  await window.getByTestId('pipeline-dispatch-open').click();
  const modal = window.getByTestId('pipeline-trigger-modal-body');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: pipelineName }).first().click();
  const runButton = window.getByTestId('pipeline-trigger-modal-run');
  const initialRunLabel = (await runButton.textContent())?.trim();
  await runButton.click();
  if (initialRunLabel === 'Continue') {
    await expect(runButton).toHaveText('Run');
    await runButton.click();
  }
  const card = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: pipelineName })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

export async function closeFixture(electronApp, userDataDir, runtimeDir) {
  await closeCanopy(electronApp, userDataDir);
  rmSync(runtimeDir, { recursive: true, force: true });
}
