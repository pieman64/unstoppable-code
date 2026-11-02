/**
 * Shared fixture, inference script, and observability helpers for the
 * headless delegation/storage-pressure Electron workload.
 *
 * The main-process rename observer is an exact count of successful
 * `node:fs/promises.rename` replacements of the target JSONL file; its byte
 * size is sampled from the rename source immediately before publication. A
 * recorded prefix clone means `copyFile(..., COPYFILE_FICLONE)` created the
 * staging file, while work-counter `written.transcript.bytes` remains logical
 * serialized work and does not include bytes copied from the existing
 * transcript. Work counters are process-wide logical-byte counts, not physical
 * disk traffic. The renderer collector sees snapshots published to the parent
 * chat after `DelegationCardPublisher` cadence (published to canonical
 * ingestion); `offered` is the pre-cadence main counter, not this collector.
 * The test-process inode
 * poller is supporting evidence only: it counts observed inode transitions and
 * is therefore a lower bound on replacements.
 */

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { seedWorkspaceApprovals } from './seeders/seedWorkspaceApprovals.mjs';
import { buildStressTranscriptMessages } from './stress-transcript-fixture.mjs';
import { evaluateMainWithRetry } from '../performance/monitor.mjs';

export const TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;
export const scaled = (ms) => ms * TIMEOUT_SCALE;

export const WORKLOAD = Object.freeze({
  workspaceId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'delegating-parent',
  stressTurns: 35,
  minTranscriptBytes: 45_000_000,
  maxTranscriptBytes: 60_000_000,
  maxConcurrent: 8,
});

export const turnMarker = (turn) => `STORAGE-TURN-${turn}`;
export const slotMarker = (slot) => `STORAGE-SLOT-${slot}`;
export const progressMarker = (slot, step) =>
  `STORAGE-PROGRESS-${slot}-${step}`;
export const finalMarker = (slot) => `STORAGE-FINAL-${slot}`;

const DELEGATION_EVENTS_KEY = '__CANOPY_E2E_DELEGATION_EVENTS__';
const TRANSCRIPT_RESETS_KEY = '__CANOPY_E2E_TRANSCRIPT_RESETS__';
const TRANSCRIPT_PAGE_GATE_KEY = '__CANOPY_E2E_TRANSCRIPT_PAGE_GATE__';
const STORAGE_MARKER_PATTERN = /STORAGE-(?:PROGRESS-\d+-\d+|FINAL-\d+)/g;

export function workloadPaths(userDataDir) {
  const workspaceRoot = path.join(
    userDataDir,
    'workspaces',
    WORKLOAD.workspaceId,
  );
  const scopeDirectory = path.join(
    workspaceRoot,
    'chat-storage-v2',
    WORKLOAD.worktreeId,
  );
  const transcriptsDirectory = path.join(scopeDirectory, 'transcripts');
  return {
    workspaceRoot,
    scopeDirectory,
    transcriptsDirectory,
    transcriptPath: path.join(transcriptsDirectory, `${WORKLOAD.chatId}.jsonl`),
    activePath: path.join(
      transcriptsDirectory,
      `${WORKLOAD.chatId}.active.json`,
    ),
    runsDirectory: path.join(
      workspaceRoot,
      'worktree-data',
      WORKLOAD.worktreeId,
      'delegation',
      'runs',
    ),
  };
}

/**
 * Seed a real demo worktree and its canonical V2 transcript with large,
 * committed stress history. The returned byte lengths are measured from both
 * the JSONL file and its descriptor; callers own range assertions.
 */
export async function seedDelegationStorageWorkload({
  userDataDir,
  fixture,
  progressSteps,
  stressTurns = WORKLOAD.stressTurns,
  stressBatches = 160,
  stressFinalBytes = 26_000,
  maxConcurrent = WORKLOAD.maxConcurrent,
}) {
  const startedAt = Date.now();
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    // Keep partial seeding artifacts inside the caller-owned cleanup root.
    fixturesDir: path.join(userDataDir, 'demo-fixtures'),
  });
  const workspace = demo.workspaces?.find(
    (entry) => entry.id === WORKLOAD.workspaceId,
  );
  if (!workspace?.worktreePath) {
    throw new Error(
      `Expected seeded worktree for workspace ${WORKLOAD.workspaceId}`,
    );
  }
  if (!fixture?.canary) {
    throw new Error('Delegation storage workload requires fixture.canary');
  }
  if (!Number.isSafeInteger(progressSteps) || progressSteps < 0) {
    throw new Error('progressSteps must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(stressTurns) || stressTurns < 0) {
    throw new Error('stressTurns must be a non-negative safe integer');
  }

  writeFileSync(
    path.join(workspace.worktreePath, 'delegation-evidence.txt'),
    `// ${fixture.canary}\n`,
  );
  for (let step = 0; step < progressSteps; step += 1) {
    const body = [
      `Storage evidence file for progress step ${step}.`,
      `Fixture canary: ${fixture.canary}`,
      ...Array.from(
        { length: 16 },
        (_, index) =>
          `Step ${step}, evidence ${index + 1}: preserve committed storage identity while reviewing delegation progress and transcript publication.`,
      ),
    ].join('\n');
    writeFileSync(
      path.join(workspace.worktreePath, `storage-evidence-${step}.txt`),
      `${body}\n`,
    );
  }

  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKLOAD.workspaceId,
    defaultMode: 'full-access',
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        managedDelegationMode: 'explicit-only',
        managedDelegationMaxConcurrent: maxConcurrent,
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
        codexMultiAgentWorktreeChatsEnabled: false,
      },
    }),
  );
  // Migrate the tab exactly as `seedWorktreeChat` normalized it, as
  // transcript-storage-fixture.mjs does. The normalized tab carries the
  // required `createdAt` (and `kind`); without it the app's `chat:get-state`
  // result fails validation, the renderer gets no tabs, and the worktree
  // opens with an empty chat group.
  const { file: legacyChats } = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKLOAD.workspaceId,
    worktreeId: WORKLOAD.worktreeId,
    activeTabId: WORKLOAD.chatId,
    tabs: [
      {
        id: WORKLOAD.chatId,
        title: 'Delegating parent',
        kind: 'chat',
        createdAt: '2026-09-01T12:00:00.000Z',
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full-access',
      },
    ],
  });
  const tab = legacyChats.tabs.find((entry) => entry.id === WORKLOAD.chatId);
  if (!tab || typeof tab.createdAt !== 'string' || !tab.title) {
    throw new Error(`Seeded chat tab ${WORKLOAD.chatId} lacks required fields`);
  }

  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(
    path.join(userDataDir, 'workspaces', WORKLOAD.workspaceId),
    WORKLOAD.worktreeId,
  );
  const messages = buildStressTranscriptMessages({
    turns: stressTurns,
    batches: stressBatches,
    finalBytes: stressFinalBytes,
  });
  await storage.migrate(async () => ({
    revision: 1,
    index: { activeTabId: WORKLOAD.chatId, runtimeByChatId: {} },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      const { messages: _messages, ...metadata } = tab;
      yield {
        metadata,
        messages: (async function* () {
          yield* messages;
        })(),
      };
    })(),
  }));

  const paths = workloadPaths(userDataDir);
  const indexes = await storage.indexes();
  const descriptor = indexes.live.tabs.find(
    (entry) => entry.id === WORKLOAD.chatId,
  )?.transcript;
  if (!descriptor) {
    throw new Error(`Missing V2 transcript descriptor for ${WORKLOAD.chatId}`);
  }
  const committedBytes = statSync(paths.transcriptPath).size;
  const descriptorBytes = descriptor.committedByteLength;
  if (committedBytes !== descriptorBytes) {
    throw new Error(
      `Seeded transcript size ${committedBytes} does not match descriptor ${descriptorBytes}`,
    );
  }

  return {
    demo,
    paths,
    seeded: {
      stressTurns,
      messageCount: messages.length,
      messageIds: messages.map((message) => message.id),
      lastMessageId: messages.at(-1)?.id ?? null,
      committedBytes,
      descriptorBytes,
      seedMs: Date.now() - startedAt,
    },
  };
}

export function parentMessage(fixture, turn, slots) {
  return `[${fixture.parentMarker}] ${turnMarker(turn)} Delegate ${slots.length} independent background reviews.`;
}

function firstUserContent(ctx) {
  const input = ctx.body?.messages ?? ctx.body?.input ?? [];
  if (!Array.isArray(input)) return '';
  const firstUser = input.find((entry) => entry?.role === 'user');
  const content = firstUser?.content ?? '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return String(content);
  }
}

function createGates() {
  const gates = new Map();
  let allReleased = false;

  function get(key) {
    let current = gates.get(key);
    if (!current) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      current = { promise, resolve, released: false };
      gates.set(key, current);
      if (allReleased) {
        current.released = true;
        current.resolve();
      }
    }
    return current;
  }

  return {
    wait(key) {
      return get(key).promise;
    },
    release(key) {
      const current = get(key);
      if (current.released) return;
      current.released = true;
      current.resolve();
    },
    releaseAll() {
      if (allReleased) return;
      allReleased = true;
      for (const current of gates.values()) {
        if (current.released) continue;
        current.released = true;
        current.resolve();
      }
    },
    isReleased(key) {
      return allReleased || get(key).released;
    },
  };
}

export function createWorkloadInference({ turns, progressSteps }) {
  const gates = createGates();
  const requestedChildSteps = new Set();
  const childRequests = new Map();
  const parentRequests = new Map();
  const spawnedTurns = new Set();
  const parentFinalRequests = new Set();
  const completedParentFinals = new Set();
  const finalSteps = new Map();
  const errors = [];

  const script = async (ctx) => {
    try {
      if (ctx.role === 'grandchild' || ctx.role === 'helper') return undefined;

      const userContent = firstUserContent(ctx);
      if (ctx.markers?.child && userContent.includes(ctx.markers.child)) {
        const slotMatch = /STORAGE-SLOT-(\d+)/.exec(userContent);
        if (!slotMatch) {
          throw new Error('Child request is missing its storage slot marker');
        }
        const slot = Number(slotMatch[1]);
        const step = ctx.resultEntries?.length ?? 0;
        requestedChildSteps.add(`${slot}:${step}`);
        childRequests.set(slot, Math.max(childRequests.get(slot) ?? -1, step));
        await gates.wait(`child:${slot}:${step}`);

        if (step < (finalSteps.get(slot) ?? progressSteps)) {
          const prose =
            'The distinct evidence file confirms that committed transcript storage remains the source of truth while live delegate updates are published. This deterministic review keeps each progress turn independent, records the visible evidence, and continues without changing the seeded history. '.repeat(
              2,
            );
          return ctx.reply({
            text: `${progressMarker(slot, step)} Reviewed storage evidence step ${step} for slot ${slot}. ${prose}`,
            toolCalls: [ctx.nativeRead(`storage-evidence-${step}.txt`)],
            stopReason: 'tool_use',
          });
        }
        return ctx.reply({
          text: `${finalMarker(slot)} ${ctx.finding}`,
          stopReason: 'end_turn',
        });
      }

      // The child check above used the first user message. A parent whose
      // later history quotes a child prompt may be labelled 'child' by the
      // shared runtime, so the parent marker decides too.
      if (
        ctx.role !== 'parent' &&
        !String(ctx.text ?? '').includes(ctx.markers?.parent ?? '\0')
      )
        return undefined;
      const turnMatches = Array.from(
        String(ctx.text ?? '').matchAll(/STORAGE-TURN-(\d+)/g),
        (match) => Number(match[1]),
      );
      if (turnMatches.length === 0) {
        return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
      }
      const turn = Math.max(...turnMatches);
      const plan = turns?.[turn] ?? turns?.[String(turn)];
      const requestCount = parentRequests.get(turn) ?? 0;
      parentRequests.set(turn, requestCount + 1);

      if (!plan) {
        return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
      }
      // Stateless: a request whose history already carries this turn's spawn
      // calls (their slot markers) is past the spawn step. Any unrelated
      // request that quotes the parent prompt cannot consume the spawn.
      const history = String(ctx.context ?? '');
      if (!plan.slots.some((slot) => history.includes(slotMarker(slot)))) {
        spawnedTurns.add(turn);
        const original = ctx.spawnInput ?? {};
        return ctx.reply({
          toolCalls: plan.slots.map((slot) => {
            const promptField = Object.hasOwn(original, 'message')
              ? 'message'
              : 'prompt';
            const spawnInput = {
              ...original,
              [promptField]: `${original[promptField] ?? ''} ${slotMarker(slot)}`,
            };
            if (ctx.harness === 'codex') {
              spawnInput.task_name = `storage_slot_${slot}`;
            } else {
              spawnInput.description = `Storage slot ${slot}`;
            }
            return { name: ctx.spawnTool, input: spawnInput };
          }),
          stopReason: 'tool_use',
        });
      }

      const finalGate = `parent:${turn}`;
      if (plan.holdFinal) {
        if (!completedParentFinals.has(turn)) {
          parentFinalRequests.add(turn);
          await gates.wait(finalGate);
          completedParentFinals.add(turn);
        }
        // A delegate completion notice steered into the held turn resamples
        // it and replaces the held reply, so later replies stay final too.
        return ctx.reply({
          text: `STORAGE-PARENT-FINAL-${turn} ${ctx.continued}`,
          stopReason: 'end_turn',
        });
      }
      return ctx.reply({
        text: `STORAGE-PARENT-DONE-${turn} ${ctx.continued}`,
        stopReason: 'end_turn',
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    script,
    releaseChildStep(step, slots) {
      for (const slot of slots) gates.release(`child:${slot}:${step}`);
    },
    finishChild(slot) {
      const step = childRequests.get(slot);
      if (step === undefined) throw new Error(`Missing child slot ${slot}`);
      finalSteps.set(slot, step);
      gates.release(`child:${slot}:${step}`);
    },
    releaseParentFinal(turn) {
      gates.release(`parent:${turn}`);
    },
    releaseAll() {
      gates.releaseAll();
    },
    childStepRequested(slot, step) {
      return requestedChildSteps.has(`${slot}:${step}`);
    },
    parentFinalRequested(turn) {
      return parentFinalRequests.has(turn);
    },
    parentSpawned(turn) {
      return spawnedTurns.has(turn);
    },
    snapshot() {
      return {
        childRequests: Object.fromEntries(childRequests),
        parentRequests: Object.fromEntries(parentRequests),
        parentFinalRequested: Object.fromEntries(
          Array.from(parentRequests.keys(), (turn) => [
            turn,
            parentFinalRequests.has(turn),
          ]),
        ),
        errors: [...errors],
      };
    },
  };
}

/** Install an idempotent main-process observer for target transcript renames. */
export async function installTranscriptRewriteObserver(
  electronApp,
  transcriptPath,
) {
  return evaluateMainWithRetry(() =>
    electronApp.evaluate((_electron, requestedPath) => {
      globalThis.setImmediate?.(() => {});
      const { createRequire, syncBuiltinESMExports } =
        process.getBuiltinModule('node:module');
      const require = createRequire(`${process.cwd()}/package.json`);
      const fsPromises = require('node:fs/promises');
      const path = require('node:path');
      const target = path.resolve(requestedPath);
      const existing = globalThis.__CANOPY_E2E_TRANSCRIPT_REWRITE_OBSERVER__;
      if (existing && existing.transcriptPath === target && !existing.stopped) {
        return existing.read();
      }
      if (existing && existing.transcriptPath !== target && !existing.stopped) {
        throw new Error(
          'A transcript rewrite observer is already installed for another path',
        );
      }

      const directory = path.dirname(target);
      const chatId = path.basename(target, '.jsonl');
      const copyFileDestinations = new Set();
      const events = [];
      const otherRenames = Object.create(null);
      const original = {
        rename: fsPromises.rename,
        copyFile: fsPromises.copyFile,
      };
      let activeOperations = 0;
      let stopped = false;
      let finalRead;

      const normalizedPath = (value) => {
        if (typeof value === 'string') return path.resolve(value);
        if (value instanceof URL) return path.resolve(value.pathname);
        return null;
      };
      const isWithinTargetDirectory = (value) => {
        const resolved = normalizedPath(value);
        return Boolean(
          resolved &&
          (resolved === directory ||
            resolved.startsWith(`${directory}${path.sep}`)),
        );
      };
      const rewriteTemp = (value) => {
        const resolved = normalizedPath(value);
        if (!resolved || path.dirname(resolved) !== directory) return false;
        const basename = path.basename(resolved);
        return (
          basename.startsWith(`${chatId}.`) && basename.endsWith('.rewrite.tmp')
        );
      };
      const renameClass = (value) => {
        const resolved = normalizedPath(value);
        if (!resolved) return 'other-transcript-file';
        const basename = path.basename(resolved);
        if (resolved === target) return 'target-jsonl';
        if (basename === `${chatId}.index.json`) return 'target-index';
        if (basename === `${chatId}.turns.json`) return 'target-turns';
        if (basename === `${chatId}.active.json`) return 'target-active';
        if (resolved === path.join(directory, 'message-index', chatId)) {
          return 'target-message-index';
        }
        return 'other-transcript-file';
      };
      const addRename = (destination) => {
        if (!isWithinTargetDirectory(destination)) return;
        const key = renameClass(destination);
        otherRenames[key] = (otherRenames[key] ?? 0) + 1;
      };
      const read = () =>
        finalRead ?? {
          transcriptPath: target,
          targetReplacements: events.length,
          replacementBytes: events.reduce(
            (total, event) => total + (event.bytes ?? 0),
            0,
          ),
          events: events.map((event) => ({ ...event })),
          otherRenames: { ...otherRenames },
          activeOperations,
        };
      const runTracked = async (tracked, work) => {
        if (tracked) activeOperations += 1;
        try {
          return await work();
        } finally {
          if (tracked) activeOperations -= 1;
        }
      };

      fsPromises.rename = async (from, to, ...args) => {
        const source = normalizedPath(from);
        const destination = normalizedPath(to);
        const tracked =
          isWithinTargetDirectory(from) || isWithinTargetDirectory(to);
        return runTracked(tracked, async () => {
          let bytes = null;
          const replacesTarget = destination === target;
          if (replacesTarget) {
            try {
              bytes = (await fsPromises.stat(from)).size;
            } catch {
              bytes = null;
            }
          }
          const result = await original.rename(from, to, ...args);
          addRename(to);
          if (replacesTarget) {
            events.push({
              seq: events.length + 1,
              at: Date.now(),
              kind: copyFileDestinations.has(source) ? 'prefix-clone' : 'full',
              bytes,
              from: path.basename(source ?? String(from)),
            });
            copyFileDestinations.delete(source);
          }
          return result;
        });
      };
      fsPromises.copyFile = async (source, destination, ...args) => {
        const tracked =
          isWithinTargetDirectory(source) ||
          isWithinTargetDirectory(destination);
        return runTracked(tracked, async () => {
          const result = await original.copyFile(source, destination, ...args);
          if (rewriteTemp(destination)) {
            copyFileDestinations.add(normalizedPath(destination));
          }
          return result;
        });
      };
      syncBuiltinESMExports();

      const observer = {
        transcriptPath: target,
        read,
        stop() {
          if (!stopped) {
            Object.assign(fsPromises, original);
            syncBuiltinESMExports();
            stopped = true;
            finalRead = read();
          }
          return {
            ...finalRead,
            events: finalRead.events.map((event) => ({ ...event })),
          };
        },
        get stopped() {
          return stopped;
        },
      };
      globalThis.__CANOPY_E2E_TRANSCRIPT_REWRITE_OBSERVER__ = observer;
      return observer.read();
    }, transcriptPath),
  );
}

export async function readTranscriptRewriteObserver(electronApp) {
  return evaluateMainWithRetry(() =>
    electronApp.evaluate(() => {
      globalThis.setImmediate?.(() => {});
      const observer = globalThis.__CANOPY_E2E_TRANSCRIPT_REWRITE_OBSERVER__;
      if (!observer) {
        throw new Error('Transcript rewrite observer is not installed');
      }
      return observer.read();
    }),
  );
}

export async function stopTranscriptRewriteObserver(electronApp) {
  return evaluateMainWithRetry(() =>
    electronApp.evaluate(() => {
      globalThis.setImmediate?.(() => {});
      const observer = globalThis.__CANOPY_E2E_TRANSCRIPT_REWRITE_OBSERVER__;
      if (!observer) {
        throw new Error('Transcript rewrite observer is not installed');
      }
      return observer.stop();
    }),
  );
}

/** Sample the canonical transcript inode in the test process; transitions are a lower bound. */
export function startTranscriptIdentityPoller(
  transcriptPath,
  { intervalMs = 20 } = {},
) {
  let ino = null;
  let size = null;
  let transitions = 0;
  let samples = 0;
  let stopped = false;
  let previousIno = null;

  const sample = () => {
    if (stopped) return;
    try {
      const stats = statSync(transcriptPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!stats) return;
      const nextIno = stats.ino.toString();
      if (previousIno !== null && nextIno !== previousIno) transitions += 1;
      previousIno = nextIno;
      ino = nextIno;
      size = Number(stats.size);
      samples += 1;
    } catch {
      // Best-effort supporting evidence; a transient stat failure is not an
      // observed successful sample and must not break the workload.
    }
  };

  sample();
  const timer = setInterval(sample, intervalMs);
  // Never keep the Playwright worker alive if a failure skips `stop()`.
  timer.unref?.();
  return {
    read() {
      return { ino, size, transitions, samples };
    },
    stop() {
      if (stopped) return this.read();
      stopped = true;
      clearInterval(timer);
      return this.read();
    },
  };
}

export async function resetWorkCounters(electronApp) {
  const result = await evaluateMainWithRetry(() =>
    electronApp.evaluate(() => {
      globalThis.setImmediate?.(() => {});
      const query = globalThis.__CANOPY_WORK_COUNTERS__;
      if (!query) {
        throw new Error(
          'Work counters are unavailable; this is not an E2E Electron build',
        );
      }
      return query.reset({
        estimateIpcBytes: true,
        estimateDelegationBytes: true,
      });
    }),
  );
  if (!result) {
    throw new Error(
      'Work counters are unavailable; this is not an E2E Electron build',
    );
  }
  return result;
}

export async function snapshotWorkCounters(electronApp) {
  const result = await evaluateMainWithRetry(() =>
    electronApp.evaluate(() => {
      globalThis.setImmediate?.(() => {});
      const query = globalThis.__CANOPY_WORK_COUNTERS__;
      if (!query) {
        throw new Error(
          'Work counters are unavailable; this is not an E2E Electron build',
        );
      }
      return query.snapshot();
    }),
  );
  if (!result) {
    throw new Error(
      'Work counters are unavailable; this is not an E2E Electron build',
    );
  }
  return result;
}

const WORK_COUNTER_CLASSES = [
  'transcript',
  'activeSidecar',
  'payload',
  'appendStaging',
  'artifact',
  'journal',
  'deltaJournal',
  'liveIndex',
  'archiveIndex',
  'recoveryIndex',
  'transcriptIndex',
  'turnIndex',
  'messageIndex',
  'manifest',
  'other',
];

function emptyByteTotals() {
  return Object.fromEntries([
    ...WORK_COUNTER_CLASSES.map((name) => [name, 0]),
    ['total', 0],
  ]);
}

function counterDeltas(before = {}, after = {}) {
  return Object.fromEntries(
    Array.from(
      new Set([...Object.keys(before), ...Object.keys(after)]),
      (key) => [key, (after[key] ?? 0) - (before[key] ?? 0)],
    ),
  );
}

function byteTotals(deltas, prefix) {
  const totals = emptyByteTotals();
  for (const [key, value] of Object.entries(deltas)) {
    const match = new RegExp(`^${prefix}\\.(.+)\\.bytes$`).exec(key);
    if (!match) continue;
    const className = match[1];
    totals.total += value;
    if (WORK_COUNTER_CLASSES.includes(className)) {
      totals[className] += value;
    } else {
      totals.other += value;
    }
  }
  return totals;
}

export function summarizeWorkCounterDelta(before, after) {
  const chatStorageDeltas = counterDeltas(
    before?.chatStorage,
    after?.chatStorage,
  );
  const providerDeltas = counterDeltas(before?.provider, after?.provider);
  const ipcDeltas = counterDeltas(before?.ipc, after?.ipc);
  const scalar = (key) => chatStorageDeltas[key] ?? 0;
  const chatEventKeys = Object.entries(ipcDeltas).filter(([key]) =>
    /^send\.chat:event\..+\.(?:messages|bytes)$/.test(key),
  );

  return {
    generationStable: before?.generation === after?.generation,
    writtenBytes: byteTotals(chatStorageDeltas, 'written'),
    serializedBytes: byteTotals(chatStorageDeltas, 'serialized'),
    commits: scalar('commits'),
    mutations: scalar('mutations'),
    atomicReplacements: scalar('atomicReplacements'),
    fileSyncs: scalar('syncs.file'),
    directorySyncs: scalar('syncs.directory'),
    deltaJournalSyncs: scalar('syncs.file.deltaJournal'),
    indexSerializations: scalar('indexSerializations'),
    payloadReads: scalar('payloadReads'),
    artifactsPublished: scalar('artifactsPublished'),
    provider: {
      eventsIngested: providerDeltas.eventsIngested ?? 0,
      eventsApplied: providerDeltas.eventsApplied ?? 0,
      delegationSnapshots: Object.fromEntries(
        ['offered', 'published', 'admitted'].map((stage) => {
          const key = `delegationSnapshots.${stage}`;
          return [
            stage,
            {
              count: Object.hasOwn(after?.provider ?? {}, key)
                ? (providerDeltas[key] ?? 0)
                : null,
              bytes: Object.hasOwn(after?.provider ?? {}, `${key}.bytes`)
                ? (providerDeltas[`${key}.bytes`] ?? 0)
                : null,
            },
          ];
        }),
      ),
    },
    ipc: {
      transcriptPageRequests: ipcDeltas['invoke.chat:get-transcript-page'] ?? 0,
      chatEventMessages: chatEventKeys.reduce(
        (total, [key, value]) =>
          key.endsWith('.messages') ? total + value : total,
        0,
      ),
      chatEventBytes: chatEventKeys.reduce(
        (total, [key, value]) =>
          key.endsWith('.bytes') ? total + value : total,
        0,
      ),
    },
    raw: {
      chatStorage: { deltas: chatStorageDeltas },
      provider: { deltas: providerDeltas },
      ipc: { deltas: ipcDeltas },
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForStorageQuiet(
  electronApp,
  { quietMs = 1000, timeoutMs = scaled(60_000), pollMs = 100 } = {},
) {
  const startedAt = Date.now();
  let lastSignature;
  let stableSince = null;
  let lastRead;

  while (Date.now() - startedAt <= timeoutMs) {
    lastRead = await evaluateMainWithRetry(() =>
      electronApp.evaluate(() => {
        globalThis.setImmediate?.(() => {});
        const counters = globalThis.__CANOPY_WORK_COUNTERS__?.snapshot();
        if (!counters) {
          throw new Error(
            'Work counters are unavailable; this is not an E2E Electron build',
          );
        }
        const chatStorage = counters.chatStorage ?? {};
        const observer = globalThis.__CANOPY_E2E_TRANSCRIPT_REWRITE_OBSERVER__;
        const observerRead = observer?.read?.();
        const writtenBytes = Object.entries(chatStorage).reduce(
          (total, [key, value]) =>
            /^written\..+\.bytes$/.test(key) ? total + value : total,
          0,
        );
        const signature = {
          commits: chatStorage.commits ?? 0,
          syncs:
            (chatStorage['syncs.file'] ?? 0) +
            (chatStorage['syncs.directory'] ?? 0),
          atomicReplacements: chatStorage.atomicReplacements ?? 0,
          writtenBytes,
          providerEventsIngested: counters.provider?.eventsIngested ?? 0,
          rewriteEvents: observerRead?.events?.length ?? 0,
          rewriteActiveOperations: observerRead?.activeOperations ?? 0,
          pendingFs: process
            .getActiveResourcesInfo()
            .filter((name) => name.startsWith('FSReq')).length,
        };
        return { signature, pendingFs: signature.pendingFs };
      }),
    );

    const serializedSignature = JSON.stringify(lastRead.signature);
    const isIdle =
      lastRead.pendingFs === 0 &&
      lastRead.signature.rewriteActiveOperations === 0;
    if (serializedSignature !== lastSignature || !isIdle) {
      lastSignature = serializedSignature;
      stableSince = isIdle ? Date.now() : null;
    } else if (stableSince === null) {
      stableSince = Date.now();
    }
    if (stableSince !== null && Date.now() - stableSince >= quietMs) {
      return { waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(pollMs);
  }

  throw new Error(
    `Timed out waiting for chat storage to become quiet after ${timeoutMs}ms; last signature: ${JSON.stringify(lastRead?.signature ?? null)}`,
  );
}

export async function installDelegationEventCollector(page, { chatId }) {
  return page.evaluate(
    ({ key, expectedChatId }) => {
      const existing = globalThis[key];
      if (existing) return;

      const collector = { entries: [], marks: {} };
      globalThis[key] = collector;
      window.api.chat.onChatEvent((event) => {
        if (
          event.chatId !== expectedChatId ||
          event.data?.type !== 'canopy_delegation'
        ) {
          return;
        }
        const delegation = event.data.delegation;
        if (!delegation) return;
        const transcript = Array.isArray(delegation.transcript)
          ? delegation.transcript
          : [];
        const markers = new Set();
        const collectMarkers = (value) => {
          if (typeof value !== 'string') return;
          for (const match of value.matchAll(
            /STORAGE-(?:PROGRESS-\d+-\d+|FINAL-\d+)/g,
          )) {
            markers.add(match[0]);
          }
        };
        for (const item of transcript) {
          collectMarkers(item.text);
          collectMarkers(item.output);
          collectMarkers(item.input);
        }
        collectMarkers(delegation.snapshot?.finalText);
        const slotMatch = /STORAGE-SLOT-(\d+)/.exec(
          delegation.task?.prompt ?? '',
        );
        collector.entries.push({
          index: collector.entries.length,
          at: Date.now(),
          delegationId: delegation.delegationId,
          runGeneration: delegation.runGeneration,
          sequence: delegation.sequence,
          status: delegation.snapshot?.status,
          transcriptMode: delegation.transcriptMode ?? 'full',
          itemCount: transcript.length,
          slot: slotMatch ? Number(slotMatch[1]) : null,
          markers: [...markers],
          bytes: new TextEncoder().encode(JSON.stringify(event.data)).length,
          snapshotBytes: new TextEncoder().encode(JSON.stringify(delegation))
            .length,
        });
      });
    },
    { key: DELEGATION_EVENTS_KEY, expectedChatId: chatId },
  );
}

export async function markDelegationEvents(page, label) {
  await page.evaluate(
    ({ key, mark }) => {
      const collector = globalThis[key];
      if (!collector) {
        throw new Error('Delegation event collector is not installed');
      }
      collector.marks[mark] = collector.entries.length;
    },
    { key: DELEGATION_EVENTS_KEY, mark: label },
  );
}

export async function readDelegationEvents(page) {
  return page.evaluate((key) => {
    const collector = globalThis[key];
    if (!collector) {
      throw new Error('Delegation event collector is not installed');
    }
    return {
      entries: collector.entries.map((entry) => ({ ...entry })),
      marks: { ...collector.marks },
    };
  }, DELEGATION_EVENTS_KEY);
}

/** Collect structural transcript resets for one chat from the real state API. */
export async function installTranscriptResetCollector(page, { chatId }) {
  return page.evaluate(
    ({ key, expectedChatId }) => {
      if (globalThis[key]) return;
      const collector = { events: [] };
      globalThis[key] = collector;
      window.api.chat.onStateChanged((event) => {
        for (const change of event.changes ?? []) {
          if (
            change.type !== 'transcript.updated' ||
            change.chatId !== expectedChatId ||
            change.reset !== true
          ) {
            continue;
          }
          collector.events.push({
            eventId: event.eventId,
            revision: event.revision,
            transcriptRevision: change.transcript?.transcriptRevision ?? null,
            at: Date.now(),
          });
        }
      });
    },
    { key: TRANSCRIPT_RESETS_KEY, expectedChatId: chatId },
  );
}

export async function readTranscriptResetEvents(page) {
  return page.evaluate((key) => {
    const collector = globalThis[key];
    if (!collector)
      throw new Error('Transcript reset collector is not installed');
    return collector.events.map((event) => ({ ...event }));
  }, TRANSCRIPT_RESETS_KEY);
}

/**
 * Hold the next transcript-page response after main has computed it. This
 * lets a live structural reset race a real older-page request deterministically.
 */
export async function installTranscriptPageGate(electronApp, { chatId }) {
  return electronApp.evaluate(
    ({ ipcMain }, { gateKey, chatId: targetChatId }) => {
      const channel = 'chat:get-transcript-page';
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function')
        throw new Error(`Missing ${channel} IPC handler`);
      if (globalThis[gateKey])
        throw new Error('Transcript page gate is already installed');
      const gate = {
        requests: 0,
        returned: 0,
        holds: 0,
        holdsGeneration: 0,
        holdNextOlder: true,
        held: false,
        heldRequestNumber: null,
        heldRequestKind: null,
        heldGeneration: null,
        release: null,
        pages: [],
      };
      gate.chatId = targetChatId;
      globalThis[gateKey] = gate;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const requestNumber = ++gate.requests;
        const requestKind = request?.before !== undefined ? 'older' : 'newest';
        const page = await original(event, request);
        gate.returned += 1;
        gate.pages.push({
          requestNumber,
          requestKind,
          chatId: request?.chatId ?? null,
          held: false,
          holdGeneration: null,
          before: request?.before ?? null,
          requestedTranscriptRevision: request?.transcriptRevision ?? null,
          messageIds: Array.isArray(page?.messages)
            ? page.messages.map((message) => message.id)
            : [],
          transcriptRevision: page?.transcriptRevision ?? null,
          beforeCursor: page?.before ?? null,
        });
        if (
          gate.holdNextOlder &&
          requestKind === 'older' &&
          request?.chatId === targetChatId
        ) {
          gate.holdNextOlder = false;
          gate.held = true;
          gate.heldRequestNumber = requestNumber;
          gate.heldRequestKind = requestKind;
          gate.holds += 1;
          gate.holdsGeneration += 1;
          gate.heldGeneration = gate.holdsGeneration;
          const heldPage = gate.pages.find(
            (candidate) => candidate.requestNumber === requestNumber,
          );
          if (heldPage) {
            heldPage.held = true;
            heldPage.holdGeneration = gate.heldGeneration;
          }
          await new Promise((resolve) => {
            gate.release = resolve;
          });
          gate.held = false;
          gate.heldRequestNumber = null;
          gate.heldRequestKind = null;
          gate.heldGeneration = null;
          gate.release = null;
        }
        return page;
      });
      return true;
    },
    { gateKey: TRANSCRIPT_PAGE_GATE_KEY, chatId },
  );
}

export async function readTranscriptPageGate(electronApp) {
  return electronApp.evaluate((_electronModules, gateKey) => {
    const gate = globalThis[gateKey];
    if (!gate) throw new Error('Transcript page gate is not installed');
    return {
      requests: gate.requests,
      returned: gate.returned,
      holds: gate.holds,
      holdsGeneration: gate.holdsGeneration,
      holdNextOlder: gate.holdNextOlder,
      chatId: gate.chatId,
      held: gate.held,
      heldRequestNumber: gate.heldRequestNumber,
      heldRequestKind: gate.heldRequestKind,
      heldGeneration: gate.heldGeneration,
      pages: gate.pages.map((page) => ({
        ...page,
        messageIds: [...page.messageIds],
      })),
    };
  }, TRANSCRIPT_PAGE_GATE_KEY);
}

export async function holdNextTranscriptPageGate(electronApp) {
  return electronApp.evaluate((_electronModules, gateKey) => {
    const gate = globalThis[gateKey];
    if (!gate) throw new Error('Transcript page gate is not installed');
    gate.holdNextOlder = true;
    return true;
  }, TRANSCRIPT_PAGE_GATE_KEY);
}

export async function releaseTranscriptPageGate(electronApp) {
  return electronApp.evaluate((_electronModules, gateKey) => {
    const gate = globalThis[gateKey];
    if (!gate?.held || typeof gate.release !== 'function') return false;
    gate.release();
    return true;
  }, TRANSCRIPT_PAGE_GATE_KEY);
}

export function summarizeDelegationEvents(read, fromLabel, toLabel) {
  const start = read.marks[fromLabel];
  if (!Number.isSafeInteger(start)) {
    throw new Error(`Unknown delegation event mark: ${fromLabel}`);
  }
  const end = toLabel === undefined ? Infinity : read.marks[toLabel];
  if (toLabel !== undefined && !Number.isSafeInteger(end)) {
    throw new Error(`Unknown delegation event mark: ${toLabel}`);
  }
  const events = read.entries.filter(
    (entry) => entry.index >= start && entry.index < end,
  );
  const byDelegation = {};
  for (const entry of events) {
    const aggregate = (byDelegation[entry.delegationId] ??= {
      slot: entry.slot,
      events: 0,
      bytes: 0,
      snapshotBytes: 0,
      firstSequence: entry.sequence,
      lastSequence: entry.sequence,
      distinctSequences: 0,
      statuses: [],
      markers: [],
      _sequences: new Set(),
    });
    aggregate.slot ??= entry.slot;
    aggregate.events += 1;
    aggregate.bytes += entry.bytes ?? 0;
    aggregate.snapshotBytes += entry.snapshotBytes ?? 0;
    aggregate.lastSequence = entry.sequence;
    aggregate._sequences.add(entry.sequence);
    if (
      typeof entry.status === 'string' &&
      !aggregate.statuses.includes(entry.status)
    ) {
      aggregate.statuses.push(entry.status);
    }
    for (const marker of entry.markers ?? []) {
      if (!aggregate.markers.includes(marker)) aggregate.markers.push(marker);
    }
  }
  for (const aggregate of Object.values(byDelegation)) {
    aggregate.distinctSequences = aggregate._sequences.size;
    delete aggregate._sequences;
  }
  return {
    events: events.length,
    bytes: events.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    byDelegation,
  };
}

export function delegationIdsBySlot(read) {
  const bySlot = {};
  for (const entry of read.entries) {
    if (entry.slot !== null && entry.slot !== undefined) {
      bySlot[entry.slot] = entry.delegationId;
    }
  }
  return bySlot;
}

export function delegationMarkersById(read) {
  const markers = new Map();
  for (const entry of read.entries) {
    const current = markers.get(entry.delegationId) ?? new Set();
    for (const marker of entry.markers ?? []) current.add(marker);
    markers.set(entry.delegationId, current);
  }
  return Object.fromEntries(
    Array.from(markers, ([id, values]) => [id, [...values].sort()]),
  );
}

function markersForBlocks(blocks) {
  const markers = new Set();
  for (const block of blocks ?? []) {
    for (const value of [block.text, block.output, block.input]) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(STORAGE_MARKER_PATTERN)) {
        markers.add(match[0]);
      }
    }
  }
  return [...markers];
}

async function lastByteIsNewline(transcriptPath, size) {
  if (size === 0) return false;
  const handle = await open(transcriptPath, 'r');
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, size - 1);
    return bytesRead === 1 && byte[0] === 10;
  } finally {
    await handle.close();
  }
}

/** Read-only byte identity, optionally of an old committed prefix after settlement. */
export async function readTranscriptByteIdentity(transcriptPath, prefixBytes) {
  const sizeBytes = statSync(transcriptPath).size;
  const digest = createHash('sha256');
  const stream = createReadStream(
    transcriptPath,
    prefixBytes === undefined ? {} : { end: prefixBytes - 1 },
  );
  for await (const chunk of stream) digest.update(chunk);
  return { sizeBytes, sha256: digest.digest('hex') };
}

/** Stream committed JSONL only; the active sidecar is deliberately not read. */
export async function readCommittedDelegationRows(transcriptPath) {
  const initialStats = statSync(transcriptPath, { bigint: true });
  const sizeBytes = Number(initialStats.size);
  const finalRowHasSeparator = await lastByteIsNewline(
    transcriptPath,
    sizeBytes,
  );
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const digest = createHash('sha256');
  stream.on('data', (chunk) => digest.update(chunk, 'utf8'));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const cards = {};
  const cardOccurrencesByDelegation = {};
  const children = [];
  const rowIds = [];
  const parentRows = [];
  let rowCount = 0;
  let rowIndex = 0;
  let pendingLine;
  let hasPendingLine = false;

  const consumeLine = (line, hasSeparator, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (!hasSeparator) return;
      throw error;
    }
    rowIds.push(row.id);
    const parentMarkers = (row.blocks ?? []).flatMap((block) =>
      typeof block.text === 'string'
        ? Array.from(
            block.text.matchAll(/STORAGE-(?:TURN|PARENT-(?:DONE|FINAL))-\d+/g),
            (match) => match[0],
          )
        : [],
    );
    if (parentMarkers.length)
      parentRows.push({ id: row.id, index, markers: parentMarkers });
    rowCount += 1;
    const rowBytes = Buffer.byteLength(line, 'utf8') + (hasSeparator ? 1 : 0);
    if (!row || !Array.isArray(row.blocks)) return;

    for (const block of row.blocks) {
      if (block?.type === 'delegated_agent_call') {
        cardOccurrencesByDelegation[block.delegationId] =
          (cardOccurrencesByDelegation[block.delegationId] ?? 0) + 1;
        cards[block.delegationId] = {
          index,
          id: row.id,
          sequence: block.sequence,
          status: block.status,
          runGeneration: block.runGeneration,
          finalText: block.finalText,
          rowBytes,
        };
      }
    }
    if (
      typeof row.parentBlockId === 'string' &&
      row.parentBlockId.startsWith('delegated-agent-')
    ) {
      children.push({
        index,
        id: row.id,
        parentBlockId: row.parentBlockId,
        delegationSequence: row.delegationSequence,
        markers: markersForBlocks(row.blocks),
      });
    }
  };

  for await (const line of lines) {
    if (hasPendingLine) {
      rowIndex += 1;
      consumeLine(pendingLine, true, rowIndex - 1);
    }
    pendingLine = line;
    hasPendingLine = true;
  }
  if (hasPendingLine) {
    rowIndex += 1;
    consumeLine(pendingLine, finalRowHasSeparator, rowIndex - 1);
  }

  const finalStats = statSync(transcriptPath, { bigint: true });
  return {
    sizeBytes: Number(finalStats.size),
    ino: finalStats.ino.toString(),
    rowCount,
    rowIds,
    parentRows,
    cards,
    cardOccurrencesByDelegation,
    children,
    sha256: digest.digest('hex'),
  };
}

const DELEGATION_ROW_PATTERN =
  /"delegated_agent_call"|"parentBlockId":"delegated-agent-/;

function textMarkers(values) {
  const markers = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(STORAGE_MARKER_PATTERN))
      markers.add(match[0]);
  }
  return markers;
}

/** Complete JSONL rows from `start`; a torn trailing row is ignored. */
async function delegationRowsFrom(transcriptPath, start) {
  const rows = [];
  const stream = createReadStream(transcriptPath, { start, encoding: 'utf8' });
  let pending = '';
  let bytesRead = 0;
  for await (const chunk of stream) {
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      // The committed spawning tool row is an ordinary row, not a delegate.
      // Retain it too so settled-parent ordering has a real predecessor oracle.
      if (
        DELEGATION_ROW_PATTERN.test(line) ||
        line.includes('"type":"tool_use"')
      )
        rows.push(JSON.parse(line));
      newline = pending.indexOf('\n');
    }
  }
  return { rows, bytesRead };
}

/**
 * Whether the committed log still ends its seeded history at `prefixBytes`
 * with `lastMessageId`, so delegation rows can only follow that offset. Chat
 * storage rewrites preserve an unchanged prefix byte-for-byte.
 */
async function seededPrefixIntact(transcriptPath, prefixBytes, lastMessageId) {
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 2 || !lastMessageId)
    return false;
  const handle = await open(transcriptPath, 'r');
  try {
    if ((await handle.stat()).size < prefixBytes) return false;
    const length = Math.min(prefixBytes, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      prefixBytes - length,
    );
    if (bytesRead !== length || buffer[length - 1] !== 10) return false;
    const text = buffer.toString('utf8', 0, length - 1);
    const lastLine = text.slice(text.lastIndexOf('\n') + 1);
    return lastLine.startsWith(`{"id":${JSON.stringify(lastMessageId)},`);
  } finally {
    await handle.close();
  }
}

function activeSidecarRecords(activePath) {
  if (!existsSync(activePath)) return [];
  let raw;
  try {
    raw = readFileSync(activePath, 'utf8');
  } catch {
    return [];
  }
  const version = /"version"\s*:\s*(\d+)/.exec(raw.slice(0, 1024))?.[1];
  try {
    if (Number(version) === 2)
      return raw
        .trimEnd()
        .split('\n')
        .slice(1)
        .filter(
          (line) =>
            DELEGATION_ROW_PATTERN.test(line) ||
            line.includes('"type":"tool_use"'),
        )
        .map((line) => JSON.parse(line))
        .filter((record) => record?.message)
        .map((record) => ({
          message: record.message,
          anchor: record.anchor,
        }));
    return (JSON.parse(raw).messages ?? [])
      .filter(
        (message) =>
          DELEGATION_ROW_PATTERN.test(JSON.stringify(message)) ||
          (message.blocks ?? []).some((block) => block?.type === 'tool_use'),
      )
      .map((message) => ({ message, anchor: undefined }));
  } catch {
    // The sidecar is replaced atomically; a parse failure is a torn read of a
    // file being rewritten by another writer and is retried by the caller.
    return [];
  }
}

/**
 * A run's delegate log (`ChatDelegationLogs.path`): D4 keeps a card's child
 * transcript here, beside the parent chat's transcript, not in its JSONL.
 */
export function delegationLogPath(paths, delegationId, runGeneration) {
  const name = createHash('sha256')
    .update(delegationId)
    .digest('hex')
    .slice(0, 32);
  return path.join(
    paths.transcriptsDirectory,
    'delegations',
    WORKLOAD.chatId,
    `${name}.${runGeneration}.jsonl`,
  );
}

/** Newest version of each logged item, in delegate order; skips torn lines. */
export function readDelegationLogItems(logPath) {
  if (!existsSync(logPath)) return [];
  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    // Compaction renames a new log into place; the caller polls again.
    return [];
  }
  const items = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.v === 1 && typeof parsed.item?.id === 'string')
        items.set(parsed.item.id, parsed.item);
    } catch {
      // A torn final line while the log is being appended.
    }
  }
  return [...items.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Delegate cards and their child rows as chat storage holds them durably:
 * committed JSONL rows plus the active sidecar, where a sidecar row replaces
 * the committed row with the same id (the same projection the chat state
 * reader applies). A card whose `transcriptStore` is `chat-log-v1` (every
 * D4 card) takes its children from its run's delegate log instead, with
 * source `delegate-log` and the row ids `delegationChildMessages` gives them.
 * Reads only the bytes after the seeded history when that prefix is intact,
 * so it is cheap to poll against a 50 MB log.
 * → { cards: { [delegationId]: { rowId, order, slot, sequence, status,
 *       source, transcriptStore, logPath } },
 *     markersById: { [delegationId]: string[] }, idsBySlot: { [slot]: id },
 *     childCountById, childRowsById, bytesRead, prefixSkipped }
 */
export async function readDurableDelegationState(
  paths,
  { prefixBytes, lastMessageId } = {},
) {
  const prefixSkipped = await seededPrefixIntact(
    paths.transcriptPath,
    prefixBytes,
    lastMessageId,
  );
  const { rows, bytesRead } = await delegationRowsFrom(
    paths.transcriptPath,
    prefixSkipped ? prefixBytes : 0,
  );
  const byId = new Map(
    rows.map((row) => [row.id, { row, source: 'jsonl', anchor: undefined }]),
  );
  for (const { message, anchor } of activeSidecarRecords(paths.activePath))
    byId.set(message.id, { row: message, source: 'active', anchor });

  const cards = {};
  const cardIdByRowId = new Map();
  const anchorsById = {};
  let order = 0;
  for (const { row, source, anchor } of byId.values()) {
    if (anchor) anchorsById[row.id] = anchor;
    for (const block of row.blocks ?? []) {
      if (block?.type !== 'delegated_agent_call') continue;
      const slot = /STORAGE-SLOT-(\d+)/.exec(block.prompt ?? '')?.[1];
      cards[block.delegationId] = {
        rowId: row.id,
        // Relative position among the rows read, in committed order.
        order,
        parentToolCallId: block.parentToolCallId ?? null,
        slot: slot === undefined ? null : Number(slot),
        sequence: block.sequence,
        status: block.status,
        runGeneration: block.runGeneration,
        finalText: block.finalText,
        source,
        transcriptStore: block.transcriptStore ?? null,
        agentBlockId: block.agentBlockId ?? row.id,
        anchor,
        markers: textMarkers([block.partialText, block.finalText]),
      };
      cardIdByRowId.set(row.id, block.delegationId);
    }
    order += 1;
  }
  const childCountById = {};
  const childRowsById = {};
  const addChild = (delegationId, child) => {
    childCountById[delegationId] = (childCountById[delegationId] ?? 0) + 1;
    (childRowsById[delegationId] ??= []).push(child);
    for (const marker of child.markers) cards[delegationId].markers.add(marker);
  };
  for (const [delegationId, card] of Object.entries(cards)) {
    if (card.transcriptStore !== 'chat-log-v1') continue;
    card.logPath = delegationLogPath(paths, delegationId, card.runGeneration);
    for (const item of readDelegationLogItems(card.logPath))
      addChild(delegationId, {
        rowId: `${card.agentBlockId}:${item.id}`,
        sequence: item.sequence,
        source: 'delegate-log',
        anchor: undefined,
        parentBlockId: card.agentBlockId,
        markers: [...textMarkers([item.text, item.input, item.output])].sort(),
      });
  }
  for (const { row, source, anchor } of byId.values()) {
    const delegationId = cardIdByRowId.get(row.parentBlockId);
    // Inline rows of a logged card are still reported (source `jsonl`), so a
    // caller can assert that none were committed to the parent transcript.
    if (!delegationId) continue;
    const markers = textMarkers(
      (row.blocks ?? []).flatMap((block) => [
        block.text,
        block.output,
        block.input,
      ]),
    );
    addChild(delegationId, {
      rowId: row.id,
      sequence: row.delegationSequence,
      source,
      anchor,
      parentBlockId: row.parentBlockId,
      markers: [...markers].sort(),
    });
  }
  for (const childRows of Object.values(childRowsById))
    childRows.sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
    );
  const markersById = {};
  const idsBySlot = {};
  for (const [delegationId, card] of Object.entries(cards)) {
    markersById[delegationId] = [...card.markers].sort();
    delete card.markers;
    if (card.slot !== null) idsBySlot[card.slot] = delegationId;
  }
  return {
    cards,
    markersById,
    idsBySlot,
    childCountById,
    childRowsById,
    anchorsById,
    bytesRead,
    prefixSkipped,
  };
}

/**
 * Progress markers that belong to another slot. The shared mock inference
 * server registers a Claude reply under a marker every delegate shares, so
 * two delegates answered concurrently can swap replies; a nonempty result
 * means the workload, not the app, produced the wrong content.
 */
export function foreignSlotMarkers(markersById, idsBySlot) {
  const foreign = {};
  for (const [slot, id] of Object.entries(idsBySlot)) {
    const wrong = (markersById[id] ?? []).filter(
      (marker) =>
        !marker.startsWith(`STORAGE-PROGRESS-${slot}-`) &&
        marker !== finalMarker(slot),
    );
    if (wrong.length) foreign[slot] = wrong;
  }
  return foreign;
}

/**
 * Final storage oracle shared by the pressure and paging flows. D4 commits
 * each card to the parent JSONL (`transcriptStore: 'chat-log-v1'`) and keeps
 * its children in the run's delegate log, through settlement: no child row
 * is ever committed to the parent transcript, and the settled card replaces
 * its live row in place.
 */
export function assertSettledDelegationTranscript({
  committed,
  durable,
  live,
  runs,
  seeded,
  slots,
  progressSteps,
  progressStepsBySlot = {},
}) {
  expect(
    committed.rowIds.slice(0, seeded.messageCount),
    'seeded history is complete and in its original order',
  ).toEqual(seeded.messageIds);
  expect(
    new Set(committed.rowIds).size,
    'no committed row id is duplicated',
  ).toBe(committed.rowCount);
  for (const slot of slots) {
    const id = live.idsBySlot[slot];
    const card = committed.cards[id];
    const durableCard = durable.cards[id];
    const run = runs.find((candidate) => candidate.state.delegationId === id);
    expect(run?.state.status, `slot ${slot} settled successfully`).toBe(
      'completed',
    );
    expect(card, `slot ${slot} committed its final card`).toBeTruthy();
    expect(
      committed.cardOccurrencesByDelegation[id],
      `slot ${slot} card appears exactly once`,
    ).toBe(1);
    expect(card.status).toBe('completed');
    expect(card.finalText).toBe(run.state.finalText);
    expect(card.finalText).toContain(finalMarker(slot));
    expect(card.sequence).toBe(durableCard?.sequence);
    expect(card.runGeneration).toBe(durableCard?.runGeneration);
    expect(durableCard?.source).toBe('jsonl');
    expect(
      durableCard?.transcriptStore,
      `slot ${slot} card keeps its children in the delegate log`,
    ).toBe('chat-log-v1');
    expect(
      card.id,
      `slot ${slot} settled card replaces its live row in place`,
    ).toBe(live.cards[id]?.rowId);
    expect(
      card.index,
      `slot ${slot} card follows the seeded history`,
    ).toBeGreaterThanOrEqual(seeded.messageCount);
    expect(
      committed.children.filter(
        (child) => child.parentBlockId === durableCard.agentBlockId,
      ),
      `slot ${slot} commits no child row to the parent transcript`,
    ).toEqual([]);
    const children = durable.childRowsById[id] ?? [];
    expect(children.length).toBeGreaterThan(0);
    const finalTranscript = [...run.state.transcript].sort(
      (left, right) => left.sequence - right.sequence,
    );
    expect(
      children.map((child) => child.rowId),
      'every final registry transcript item is logged once in final sequence order',
    ).toEqual(
      finalTranscript.map((item) => `${durableCard.agentBlockId}:${item.id}`),
    );
    expect(children.map((child) => child.sequence)).toEqual(
      finalTranscript.map((item) => item.sequence),
    );
    for (const child of children) {
      expect(child.source).toBe('delegate-log');
      expect(child.parentBlockId).toBe(durableCard.agentBlockId);
      expect(
        committed.rowIds.includes(child.rowId),
        `child ${child.rowId} is absent from the parent transcript`,
      ).toBe(false);
    }
    for (const child of live.childRowsById[id] ?? [])
      expect(
        children.map((row) => row.rowId),
        `live child ${child.rowId} survived settlement`,
      ).toContain(child.rowId);
    const markers = children.flatMap((child) => child.markers);
    let previous = -1;
    for (const marker of [
      ...Array.from(
        { length: progressStepsBySlot[slot] ?? progressSteps },
        (_, step) => progressMarker(slot, step),
      ),
      finalMarker(slot),
    ]) {
      const index = markers.indexOf(marker);
      expect(
        index,
        `${marker} is logged after the previous progress/final item`,
      ).toBeGreaterThan(previous);
      previous = index;
    }
  }
  // Settlement rewrites each card where it was committed live: cards keep
  // their committed order instead of drifting to the transcript tail.
  const byLiveOrder = [...slots].sort(
    (left, right) =>
      live.cards[live.idsBySlot[left]].order -
      live.cards[live.idsBySlot[right]].order,
  );
  const bySettledIndex = [...slots].sort(
    (left, right) =>
      committed.cards[live.idsBySlot[left]].index -
      committed.cards[live.idsBySlot[right]].index,
  );
  expect(bySettledIndex, 'cards keep their live committed order').toEqual(
    byLiveOrder,
  );
}

/** Rejects after `ms` so teardown steps can never hang the worker. */
export async function withTimeout(label, ms, work) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills the Electron process Playwright launched if it outlived
 * `closeCanopy`. Playwright's worker teardown waits for every launched
 * process to exit, so a survivor turns into a worker teardown timeout.
 */
export function killIfAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export function readDelegationRuns(userDataDir) {
  const { runsDirectory } = workloadPaths(userDataDir);
  if (!existsSync(runsDirectory)) return [];
  return readdirSync(runsDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      JSON.parse(readFileSync(path.join(runsDirectory, name), 'utf8')),
    );
}

export function delegatedCardLocator(surface, delegationId) {
  return surface.locator(
    `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
  );
}

export async function readDelegatedCardDiagnostics(
  panel,
  delegationId,
  expectedMarker,
) {
  const cards = await delegatedCardLocator(panel, delegationId).evaluateAll(
    (elements, marker) =>
      elements.map((element, index) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const text = element.textContent ?? '';
        const expandControl = element.querySelector(
          'button[aria-label="Expand delegated task"], button[aria-label="Collapse delegated task"]',
        );
        // AgentBlockCard renders subBlocks directly in this scroll container,
        // not as outer ChatMessageItem rows with data-chat-message-id hooks.
        const childRows = element.querySelector(
          ':scope > [data-testid="agent-block-shared"] > div > .max-h-125',
        );
        const messageRow = element.closest('[data-chat-message-id]');
        return {
          index,
          visible:
            style.visibility !== 'hidden' &&
            style.visibility !== 'collapse' &&
            bounds.width > 0 &&
            bounds.height > 0,
          nearestAncestorTestId:
            element.parentElement
              ?.closest('[data-testid]')
              ?.getAttribute('data-testid') ?? null,
          insideMessageListRow: messageRow !== null,
          messageId: messageRow?.getAttribute('data-chat-message-id') ?? null,
          activityTestId:
            element
              .closest('[data-testid^="agent-activity-"]')
              ?.getAttribute('data-testid') ?? null,
          expandControl: expandControl?.getAttribute('aria-label') ?? null,
          textLength: text.length,
          textPreview: text.slice(0, 300),
          childRowCount: childRows?.childElementCount ?? 0,
          containsExpectedMarker: marker ? text.includes(marker) : null,
        };
      }),
    expectedMarker,
  );
  return { cardCount: cards.length, cards };
}

export async function openParentChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: scaled(60_000) });
  await app.openMainPage();
  await app.selectWorktree(WORKLOAD.worktreeId);
  // Select the seeded parent explicitly, as chat-transcript-storage.spec.mjs
  // does, so the panel is the parent chat even if another panel is active.
  const chatTab = window.getByTestId(`panel-tab-panel-chat-${WORKLOAD.chatId}`);
  await expect(
    chatTab,
    `the seeded chat ${WORKLOAD.chatId} has a panel tab (if not, chat:get-state likely rejected the seeded tab metadata; see logs/main.log)`,
  ).toBeVisible({ timeout: scaled(60_000) });
  await chatTab.click();
  const panel = window
    .locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${WORKLOAD.chatId}"]:visible`,
    )
    .first();
  await expect(panel).toBeVisible({ timeout: scaled(60_000) });
  return { window, app, panel };
}

export async function sendParentMessage(window, text) {
  const composer = window.getByRole('textbox').first();
  await composer.fill(text);
  await window.getByRole('button', { name: 'Send message' }).click();
}

export async function revealDelegatedCard(
  panel,
  delegationId,
  { timeout = scaled(30_000) } = {},
) {
  const card = delegatedCardLocator(panel, delegationId)
    .filter({ visible: true })
    .first();
  await expect(async () => {
    if (await card.isVisible().catch(() => false)) return;
    const newestCollapsedTurn = panel
      .locator('button[aria-label^="Agent steps"][aria-expanded="false"]')
      .last();
    if ((await newestCollapsedTurn.count()) > 0) {
      await newestCollapsedTurn.click();
    }
    const activityExpanders = await panel
      .locator('button[aria-label="Expand agent activity"]')
      .all();
    for (const expander of activityExpanders) {
      if (await expander.isVisible().catch(() => false)) await expander.click();
    }
    if (!(await card.isVisible().catch(() => false))) {
      throw new Error(`Delegated card ${delegationId} is not visible yet`);
    }
  }).toPass({ timeout, intervals: [100, 250, 500, 1_000] });
  return card;
}

export async function expandDelegatedCard(card) {
  const expand = card
    .getByRole('button', {
      name: 'Expand delegated task',
    })
    .first();
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    return;
  }
  const collapse = card
    .getByRole('button', {
      name: 'Collapse delegated task',
    })
    .first();
  if (!(await collapse.isVisible().catch(() => false))) {
    throw new Error('Delegated card is neither collapsed nor expanded');
  }
}
