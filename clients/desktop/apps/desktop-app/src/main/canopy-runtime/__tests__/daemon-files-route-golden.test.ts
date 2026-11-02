/**
 * CAN-5501 rule: captured on the unchanged Files route before its eligibility
 * check moved into the shared read-route guard. Live `file-tree:roots` and
 * `file-tree:directory` reads (`worker.filesystem.roots.list` and
 * `worker.filesystem.directory.list`) must stay byte-identical: legacy and canonical results, typed
 * failures, route counters and the evidence journal, for both backends and
 * both entry-name rule sets. Roots and directory are eligible on every
 * platform's table row, so the golden does not depend on the test host.
 */
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  bridgeCaller,
  createRouteHarness,
  FakeSender,
  type RouteHarness,
  type RouteHarnessOptions,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const MULTI = { workspaceId: 'multi', worktreeId: 'task' };
const COWORK_HOME = { workspaceId: 'cowork', worktreeId: 'home' };

const DIRECTORIES: ReadonlyArray<
  readonly [CanopyWorkspaceScope, string, string]
> = [
  [SINGLE, 'single', ''],
  [SINGLE, 'single', 'src'],
  [SINGLE, 'single', './'],
  [SINGLE, 'attachments', ''],
  [SINGLE, 'missing', ''],
  [MULTI, WORKSPACE_ROOT_REPO_ID, ''],
  [MULTI, 'api', ''],
  [COWORK_HOME, 'workspace', ''],
];

const ROOTS: readonly CanopyWorkspaceScope[] = [
  SINGLE,
  MULTI,
  COWORK_HOME,
  { workspaceId: 'never-seen', worktreeId: 'task' },
  // Ineligible on every platform: a foreign selector and an excluded scope.
  { ...SINGLE, repoId: 'single' },
  { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: 'task' },
];

let h: RouteHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * One line of exact JSON per fact; random temp paths and the
 * data-root-derived revision become placeholders.
 */
function line(harness: RouteHarness, label: string, value: unknown): string {
  const json = JSON.stringify(value)
    .split(harness.base)
    .join('<base>')
    .replace(/"catalogRevision":"[0-9a-f]{64}"/g, '"catalogRevision":"<rev>"');
  return `${label} ${json}`;
}

async function outcome(read: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await read };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'payload' in error)
      return { failed: error.payload };
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

/** One serialized pass over every read, in a fixed order, with one sender. */
async function captureFilesRouteGolden(
  options: RouteHarnessOptions,
): Promise<string[]> {
  h = await createRouteHarness(options);
  const harness = h;
  resetWorkCounters();
  const sender = new FakeSender(1);
  const baseline = harness.route.observe().cursor;
  const golden: string[] = [];
  for (const scope of ROOTS)
    golden.push(
      line(
        harness,
        `roots ${JSON.stringify(scope)}`,
        await outcome(harness.roots(scope, sender)),
      ),
    );
  golden.push(
    line(
      harness,
      `roots-bridge ${JSON.stringify(SINGLE)}`,
      await outcome(
        harness.roots(SINGLE, sender, bridgeCaller(sender, 'controller-1')),
      ),
    ),
  );
  for (const [scope, rootId, relativePath] of DIRECTORIES)
    golden.push(
      line(
        harness,
        `directory ${JSON.stringify([scope, rootId, relativePath])}`,
        await outcome(harness.directory(scope, rootId, relativePath, sender)),
      ),
    );
  const { entries, ...evidence } = harness.route.observe(baseline);
  golden.push(
    line(harness, 'counters', snapshotWorkCounters().route),
    line(harness, 'evidence', { ...evidence, cursor: undefined }),
    ...entries.map((entry) => line(harness, 'event', entry)),
    line(harness, 'daemon', harness.daemon.names()),
    line(harness, 'direct', {
      roots: harness.direct.roots.mock.calls.length,
      directory: harness.direct.directory.mock.calls.length,
    }),
  );
  await harness.close();
  h = undefined;
  return golden;
}

// Each capture seeds a fresh harness and runs every read; one capture can
// exceed Jest's default 5 s on a loaded host.
const CAPTURE_TIMEOUT_MS = 30_000;

describe.each(['posix', 'win32'] as const)(
  'Files route golden (%s entry names)',
  (entryNamePlatform) => {
    it.each([true, false])(
      'keeps roots and directory byte-identical with the flag %s',
      async (flag) => {
        expect(
          await captureFilesRouteGolden({ flag, entryNamePlatform }),
        ).toMatchSnapshot();
      },
      CAPTURE_TIMEOUT_MS,
    );
  },
);

// The golden above runs on the test host's own table row.
describe('Files route golden on an injected host', () => {
  let host: string[] = [];

  beforeAll(async () => {
    host = await captureFilesRouteGolden({ flag: true });
  }, CAPTURE_TIMEOUT_MS);

  it.each(['darwin', 'win32', 'linux'] as const)(
    'keeps the golden on an injected %s host',
    async (platform) => {
      expect(host).not.toHaveLength(0);
      expect(await captureFilesRouteGolden({ flag: true, platform })).toEqual(
        host,
      );
    },
    CAPTURE_TIMEOUT_MS,
  );
});
