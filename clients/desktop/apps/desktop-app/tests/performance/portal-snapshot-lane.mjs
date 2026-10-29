// CAN-3104: paired scheduler experiment using the retained serial fallback.
// node scripts/run-guarded-dev-script.mjs --suite performance -- node --import tsx apps/desktop-app/tests/performance/portal-snapshot-lane.mjs <output.json>
// This isolates queueing under fixed local disk/Git/projection work. It is not
// a production relay/database benchmark or a replacement for Electron runs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { require as tsRequire } from 'tsx/cjs/api';
const { createPortalSnapshotLane } = tsRequire(
  '../../src/main/portal/portal-snapshot-lane.ts',
  import.meta.url,
);

const exec = promisify(execFile);
const output = path.resolve(
  process.argv[2] ?? '.playwright/can-3104/scheduler-load.json',
);
const root = await mkdtemp(path.join(os.tmpdir(), 'portal-snapshot-load-'));
const samples = [];
const fixture = JSON.stringify(
  Array.from({ length: 256 }, (_, i) => ({ id: i, text: 'x'.repeat(8192) })),
);
await writeFile(path.join(root, 'fixture.json'), fixture);
await exec('git', ['init', '-q', root]);

async function sample(mode, repetition) {
  const outbox = [];
  let builds = 0;
  let active = 0;
  let maxActive = 0;
  let maxQueueDepth = 0;
  let foregroundMs;
  let fileReadBytes = 0;
  let projectionMs = 0;
  let subprocesses = 0;
  const delays = monitorEventLoopDelay({ resolution: 10 });
  delays.enable();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const lane = createPortalSnapshotLane({
    mode: () => mode,
    now: () => performance.now(),
    recordScheduling: (event) => {
      maxQueueDepth = Math.max(maxQueueDepth, event.queueDepth);
    },
    execute: async (command, context, request) => {
      builds += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const bytes = await readFile(path.join(root, 'fixture.json'), 'utf8');
        fileReadBytes += Buffer.byteLength(bytes);
        subprocesses += 1;
        await exec('git', ['-C', root, 'status', '--porcelain']);
        const projectedAt = performance.now();
        const entities = JSON.parse(bytes).map((value) => ({
          entityType: 'chat_summary',
          localId: String(value.id),
          payload: value,
        }));
        projectionMs += performance.now() - projectedAt;
        context.enqueueEvent({
          type: 'portal.state.snapshot',
          commandId: command.id,
          eventId: `snapshot-${command.id}`,
          occurredAt: new Date().toISOString(),
          payload: { scope: request.scope, target: request.target, entities },
        });
        context.enqueueEvent({
          type: 'portal.command.completed',
          commandId: command.id,
          eventId: `done-${command.id}`,
          occurredAt: new Date().toISOString(),
          payload: { commandId: command.id },
        });
      } finally {
        active -= 1;
      }
    },
    enqueueEvent: (event) => {
      outbox.push(event);
      return event;
    },
    flushOutbox: async () => {
      // Serialize one bounded group at a time, retaining continuation pressure.
      const events = outbox.splice(0, 2);
      const mark = performance.now();
      JSON.stringify(events);
      projectionMs += performance.now() - mark;
      await new Promise((resolve) => setImmediate(resolve));
    },
    persistCompletedCommand: async () => {},
    outboxDepth: () => outbox.length,
    isCommandGroupQueued: (id) =>
      outbox.some(
        (event) =>
          event.commandId === id &&
          event.type !== 'portal.command.completed' &&
          event.type !== 'portal.command.failed',
      ),
    droppedCommandGroup: () => undefined,
    recordTiming: ({ commandId, elapsedMs }) => {
      if (commandId === 'foreground') foregroundMs = elapsedMs;
    },
    buildFailureEvent: () => {
      throw new Error('Unexpected fixture failure');
    },
    onError: (error) => {
      throw error;
    },
  });
  for (const [index, id] of [
    'running',
    'duplicate',
    'duplicate',
    'tree-b',
    'tree-c',
    'foreground',
  ].entries()) {
    const commandId = id === 'foreground' ? id : `${id}-${index}`;
    const request = {
      scope: id === 'foreground' ? 'chat' : 'scripts',
      target: { workspaceLocalId: 'workspace', worktreeLocalId: id },
    };
    lane.enqueue({
      command: {
        id: commandId,
        sequence: index + 1,
        type: 'portal.state.request',
        status: 'pending',
        payload: request,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
      request,
      receivedAtPerf: performance.now(),
    });
  }
  await lane.idle();
  delays.disable();
  const used = process.cpuUsage(cpu);
  return {
    mode,
    repetition,
    foregroundMs,
    elapsedMs: performance.now() - start,
    builds,
    maxActive,
    maxQueueDepth,
    subprocesses,
    fileReadBytes,
    projectionMs,
    cpuMs: (used.user + used.system) / 1000,
    eventLoopP99Ms: delays.percentile(99) / 1e6,
    rssBytes: process.memoryUsage().rss,
  };
}
try {
  await sample('serial', -1);
  await sample('keyed', -1);
  for (let i = 0; i < 20; i += 1) {
    for (const mode of i % 2 === 0 ? ['serial', 'keyed'] : ['keyed', 'serial'])
      samples.push(await sample(mode, i));
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        kind: 'scheduler-isolation-experiment',
        fixtureBytes: Buffer.byteLength(fixture),
        samples,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `Saved ${samples.length} matched samples to ${output}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
