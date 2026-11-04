// Daemon code graph acceptance (CAN-5089) against the verified daemon artifact
// bridged into the product's lookup paths, as the Files acceptance does. With
// the daemon-code-graph Labs experiment on, a worktree generation the main
// window asks for runs in the daemon's budgeted graph hosts: they are the
// daemon's children while it builds, and the summary is ready. Turning the
// experiment off builds the same graph in process, with nothing repaired:
// no daemon graph host starts and the summary is unchanged.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  cleanupAbandonedDaemonFilesApp,
  readDescriptor,
  withDaemonFilesApp,
} from './helpers/daemon-files-panel.mjs';

const REQUEST = { workspaceId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };

test.skip(
  process.platform !== 'darwin',
  'The packaged daemon artifact and owned-child host are macOS only.',
);

test.afterEach(cleanupAbandonedDaemonFilesApp);

/** Enough TypeScript that a full build outlasts several process samples. */
function seedCorpus(worktreePath, fileCount = 600) {
  const directory = path.join(worktreePath, 'generated-graph-corpus');
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const previous = index === 0 ? fileCount - 1 : index - 1;
    writeFileSync(
      path.join(directory, `module-${index}.ts`),
      [
        `import { value${previous} } from './module-${previous}';`,
        `export const value${index} = value${previous} + ${index};`,
        `export function transform${index}(input: number): number {`,
        `  return input + value${index};`,
        '}',
        '',
      ].join('\n'),
    );
  }
}

/** Every graph host `ps` lists, with its parent. */
function graphHosts() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, args]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      entry: /--canopy-execution-host=(\S+)/.exec(args)?.[1] ?? null,
    }))
    .filter((host) => host.entry?.startsWith('code-graph-'));
}

/**
 * Runs `work` while sampling graph hosts, then keeps the entries whose
 * parent is the daemon. The daemon starts on first use, so its pid is read
 * after the work.
 */
async function sampleDaemonHosts(daemonPid, work) {
  const seen = new Map();
  let done = false;
  const sampling = (async () => {
    while (!done) {
      for (const host of graphHosts()) seen.set(host.pid, host);
      await new Promise((settle) => setTimeout(settle, 50));
    }
  })();
  let result;
  try {
    result = await work();
  } finally {
    done = true;
    await sampling;
  }
  const parent = daemonPid();
  const entries = [...seen.values()]
    .filter((host) => host.ppid === parent)
    .map((host) => host.entry);
  return { result, parent, entries: [...new Set(entries)].sort() };
}

async function setCodeGraphChoice(window, enabled) {
  const snapshot = await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'daemon-code-graph',
        enabled: value,
      }),
    enabled,
  );
  expect(snapshot.ready).toBe(true);
  expect(
    snapshot.experiments.find((entry) => entry.id === 'daemon-code-graph'),
  ).toMatchObject({
    flagKey: 'canopy-desktop-labs-daemon-code-graph',
    choice: enabled,
    enabled,
  });
}

test('builds worktree graphs in the daemon while the experiment is on', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await withDaemonFilesApp(
    testInfo,
    {
      enabled: null,
      seed: (dataRoot) => {
        const seeded = seedDemoWorkspaces({
          userDataDir: dataRoot,
          apps: ['ts-pnpm-vite'],
        });
        seedCorpus(seeded.workspaces[0].worktreePath);
        return seeded;
      },
    },
    async (context) => {
      const { window, canonicalDataRoot, report } = context;
      const daemonPid = () => readDescriptor(canonicalDataRoot)?.pid;
      const build = () =>
        window.evaluate(
          (request) => window.api.codeGraphBuildWorktree(request),
          REQUEST,
        );

      await setCodeGraphChoice(window, true);
      const on = await sampleDaemonHosts(daemonPid, build);
      report.codeGraph = { daemonPid: on.parent, on: on.entries };
      expect(on.result).toMatchObject({ enabled: true, state: 'ready' });
      expect(on.parent).toEqual(expect.any(Number));
      // The daemon fingerprinted and built the worktree in its own hosts.
      expect(on.entries).toEqual(
        expect.arrayContaining([
          'code-graph-build-host.js',
          'code-graph-fingerprint-host.js',
        ]),
      );

      // Off: the next build is in process, over the graph the daemon wrote,
      // with nothing repaired.
      await setCodeGraphChoice(window, false);
      const off = await sampleDaemonHosts(daemonPid, build);
      report.codeGraph.off = off.entries;
      expect(off.result).toMatchObject({ enabled: true, state: 'ready' });
      expect(off.entries).toEqual([]);
      // The same graph, rebuilt: only its build time moved.
      const stable = ({ repositories }) =>
        repositories.map(({ lastBuildAt, ...repository }) => repository);
      expect(stable(off.result)).toEqual(stable(on.result));
    },
  );
});
