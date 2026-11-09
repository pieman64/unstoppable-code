import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getGitExecutableDetectionMode } from '@canopy/core-runtime/node';
import { isHostAbsolute } from '../git-read/commands';
import {
  createWorld,
  DIVERGENCES,
  type FileEntry,
  fakeHost,
  flush,
  resolveEntry,
  snapshotFor,
} from './git-read-host-fakes';

/*
 * U2b's half of the shared selection table (CAN-4303 R6 §1.4): each scenario
 * replays through `createGitReadHost` with the private SelectionIo seam and a
 * runner-shaped executor. A daemon outcome that differs from desktop's must be
 * listed below under a deliberate divergence (R6 §2.7); any other difference,
 * or a listed one that no longer differs, fails.
 */

type Divergence = keyof typeof DIVERGENCES;

const fileEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('eacces') }).strict(),
  z.object({ kind: z.literal('directory') }).strict(),
  z
    .object({
      kind: z.literal('executable'),
      stdout: z.string(),
      transient: z.literal('timeout').optional(),
    })
    .strict(),
  z.object({ kind: z.literal('noexec') }).strict(),
  z.object({ kind: z.literal('shim') }).strict(),
  z.object({ kind: z.literal('symlink'), target: z.string() }).strict(),
]);
const expectationSchema = z.object({
  attempts: z.array(z.string()),
  status: z.object({
    ready: z.boolean(),
    path: z.string().nullable().optional(),
  }),
  savedAfter: z.string().optional(),
});
const stepSchema = z.object({
  name: z.string(),
  filesystem: z.record(z.string(), fileEntrySchema).optional(),
  select: z.string().optional(),
  elapsedMs: z.number().optional(),
  expected: z.object({
    resolved: z.string().nullable(),
    savedAfter: z.string().optional(),
  }),
});
const scenarioSchema = z.object({
  name: z.string(),
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: z.string().optional(),
  environment: z.record(z.string(), z.string()),
  saved: z.string().nullable(),
  loginPath: z.string(),
  developerDir: z.string().nullable(),
  whereExe: z.record(z.string(), z.string()).optional(),
  filesystem: z.record(z.string(), fileEntrySchema),
  expected: expectationSchema.optional(),
  expectedByJoin: z.object({ win32: expectationSchema }).optional(),
  steps: z.array(stepSchema).optional(),
});
type Scenario = z.infer<typeof scenarioSchema>;

const SCENARIOS_PATH = join(
  __dirname,
  '../../../protocol/src/git-executable/__tests__/selection-scenarios.json',
);
const scenarios = z
  .object({ scenarios: z.array(scenarioSchema) })
  .parse(JSON.parse(readFileSync(SCENARIOS_PATH, 'utf8'))).scenarios;

interface Outcome {
  readonly resolved: string | null;
  readonly attempts?: readonly string[];
}

/**
 * Daemon outcomes that differ from desktop's, by `scenario` or
 * `scenario › step`. A different saved value afterwards is always
 * `no-writes` (asserted per case), so it is not listed.
 */
const DIVERGENT: Readonly<
  Record<string, { readonly divergence: Divergence; readonly daemon: Outcome }>
> = {
  'Windows accepts a relative saved selection': {
    divergence: 'windows-absolute-path',
    daemon: {
      resolved: 'C:\\Program Files\\Git\\cmd\\git.exe',
      attempts: ['C:\\Program Files\\Git\\cmd\\git.exe'],
    },
  },
  'Linux ppc64 uses the environment override': {
    divergence: 'other-linux-snapshot-path',
    daemon: { resolved: '/env/git', attempts: [] },
  },
  'macOS saved symlink retargeted to another Git › the saved symlink now points at another Git':
    {
      divergence: 'overlay-keying-and-ttl',
      daemon: { resolved: '/opt/b/bin/git' },
    },
  'macOS saved selection re-selected with the same string after a transient timeout › the timeout clears and the user re-selects the same path':
    {
      divergence: 'overlay-keying-and-ttl',
      daemon: { resolved: '/usr/local/bin/git' },
    },
  'Linux saved selection after a transient timeout › the timeout clears': {
    divergence: 'overlay-keying-and-ttl',
    daemon: { resolved: null },
  },
};

function desktopExpectation(
  scenario: Scenario,
): z.infer<typeof expectationSchema> {
  // The daemon joins Windows candidates with path.win32, as a Windows host.
  const expected = scenario.expected ?? scenario.expectedByJoin?.win32;
  if (!expected) throw new Error(`${scenario.name} has no expectation`);
  return expected;
}

const linuxDiscovery = (scenario: Scenario): boolean =>
  scenario.os !== 'linux' ||
  getGitExecutableDetectionMode(scenario.os, scenario.arch ?? 'x64') ===
    'linux';

/**
 * Desktop's first detection as a spawn resolution. Overlay keying stats an
 * absolute saved value before selecting; outside macOS (whose attempts are
 * realpath lookups) that lookup is an attempt too.
 */
function expectedInitial(scenario: Scenario): Outcome {
  const { status, attempts } = desktopExpectation(scenario);
  const saved = (scenario.saved ?? '').trim();
  const keyed =
    scenario.os !== 'darwin' &&
    linuxDiscovery(scenario) &&
    saved !== '' &&
    isHostAbsolute(scenario.os, saved);
  return {
    resolved: status.ready ? (status.path ?? 'git') : null,
    attempts: keyed ? [saved, ...attempts] : attempts,
  };
}

function compare(label: string, daemon: Outcome, desktop: Outcome): void {
  const listed = DIVERGENT[label];
  const same = JSON.stringify(daemon) === JSON.stringify(desktop);
  if (same) {
    expect([label, listed]).toEqual([label, undefined]);
    return;
  }
  expect([label, listed?.divergence]).toEqual([label, expect.any(String)]);
  expect([label, daemon]).toEqual([label, listed?.daemon]);
}

function patched(
  filesystem: Record<string, FileEntry>,
  patch: Record<string, FileEntry> | undefined,
): Record<string, FileEntry> {
  return { ...filesystem, ...patch };
}

describe('shared Git selection scenarios through createGitReadHost', () => {
  it('loads every scenario and lists only known divergences', () => {
    expect(scenarios.length).toBeGreaterThan(30);
    const labels = new Set(
      scenarios.flatMap((scenario) => [
        scenario.name,
        ...(scenario.steps ?? []).map(
          (step) => `${scenario.name} › ${step.name}`,
        ),
      ]),
    );
    for (const [label, { divergence }] of Object.entries(DIVERGENT)) {
      expect([label, labels.has(label)]).toEqual([label, true]);
      expect(Object.keys(DIVERGENCES)).toContain(divergence);
    }
  });

  it.each(
    scenarios.map((scenario): [string, Scenario] => [scenario.name, scenario]),
  )('%s', async (name, scenario) => {
    const world = createWorld(scenario.os, {
      filesystem: { ...scenario.filesystem },
      loginPath: scenario.loginPath,
      developerDir: scenario.developerDir,
      whereExe: scenario.whereExe ?? {},
    });
    const environment = snapshotFor(scenario.os, scenario.environment);
    const frozen = JSON.stringify(environment);
    const { host, clock, resolve } = fakeHost(
      world,
      { environment },
      { arch: scenario.arch ?? 'x64' },
    );
    // Desktop's table reads a warm login PATH; the cold case is C9's test.
    host.prewarm();
    await flush();
    world.attempts.length = 0;

    let saved = scenario.saved ?? '';
    const initial = await resolve(saved);
    compare(
      name,
      { resolved: initial.resolved, attempts: [...world.attempts] },
      expectedInitial(scenario),
    );

    for (const step of scenario.steps ?? []) {
      world.filesystem = patched(world.filesystem, step.filesystem);
      if (step.select !== undefined) saved = step.select;
      clock.now += step.elapsedMs ?? 0;
      const later = await resolve(saved);
      compare(
        `${name} › ${step.name}`,
        { resolved: later.resolved },
        { resolved: step.expected.resolved },
      );
    }

    // no-writes: the snapshot is unchanged and nothing is published.
    expect(JSON.stringify(environment)).toBe(frozen);
    expect(
      world.ran.filter(
        (executable) => resolveEntry(world, executable).entry.kind === 'shim',
      ),
    ).toEqual([]);
    expect(
      world.probes.every(({ command }) =>
        [
          'git-version',
          'git-bare-init-smoke',
          'xcode-select-print-path',
          'macos-login-shell-path',
          'linux-login-shell-path',
          'getent-passwd',
          'where-git',
          'where-winget',
        ].includes(command.kind),
      ),
    ).toBe(true);
  });
});
