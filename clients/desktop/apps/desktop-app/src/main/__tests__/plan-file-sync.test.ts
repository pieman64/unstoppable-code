const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();
const mockReaddir = jest.fn<Promise<string[]>, [string]>();

jest.mock('node:fs/promises', () => ({
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  writeFile: (path: string, content: string, encoding: string): Promise<void> =>
    mockWriteFile(path, content, encoding),
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readdir: (path: string): Promise<string[]> => mockReaddir(path),
}));

jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: jest.fn(),
  getPlanExploreTargetSync: jest.fn(),
}));

jest.mock('../lib/plan-persistence', () => ({
  getTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { join, sep } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  getPlanExplorePlanFilePath,
  getPlanExploreScopeDir,
} from '../lib/paths';
import {
  getPlanExploreTarget,
  getPlanExploreTargetSync,
} from '../lib/plan-explore-registry';
import {
  PlanFileSyncService,
  planChatTurnKey,
  planFileKey,
  resolvePlanTurnScope,
  type PlanFileRef,
  type PlanFileScope,
} from '../lib/plan-file-sync';
import { getTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import type { SendableBrowserWindow } from '../lib/window-send';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const mockedGetTrackedPlan = jest.mocked(getTrackedPlan);
const mockedUpdateTrackedPlan = jest.mocked(updateTrackedPlan);
const mockedGetPlanExploreTarget = jest.mocked(getPlanExploreTarget);
const mockedGetPlanExploreTargetSync = jest.mocked(getPlanExploreTargetSync);
const mockedLogMainProcessError = jest.mocked(logMainProcessError);

const PROJECT_ID = 'ws-1';
const WORKTREE_ID = 'wt-1';
const OTHER_WORKTREE_ID = 'wt-2';
const PLAN_ID = 'plan-1';
const OTHER_PLAN_ID = 'plan-2';
const COWORK_PROJECT_ID = 'cowork-ws';
const DEBOUNCE_MS = 1500;
const POLL_MS = 25_000;

const SCOPE: PlanFileScope = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
const REF: PlanFileRef = { ...SCOPE, planId: PLAN_ID };
const OTHER_REF: PlanFileRef = { ...SCOPE, planId: OTHER_PLAN_ID };

const ORIGINAL = '# Plan\n\n## Task 1';
const EDITED = '# Plan\n\n## Task 1 (edited)';

/** In-memory `plan.md` files keyed by absolute path. */
const files = new Map<string, string>();
/** In-memory tracked plans keyed by `planFileKey`. */
const plans = new Map<string, TrackedPlanData>();

function enoent(path: string): Error {
  return ioError('ENOENT', path);
}

function ioError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** Make every read of `path` fail with `code`, as for an unreadable file. */
function makeUnreadable(path: string, code: string): void {
  const readThrough = mockReadFile.getMockImplementation();
  mockReadFile.mockImplementation((target, encoding) =>
    target === path
      ? Promise.reject(ioError(code, target))
      : (readThrough?.(target, encoding) ?? Promise.reject(enoent(target))),
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Hold the next read of `path` until the returned gate opens; the read then
 * sees the file's bytes at that moment.
 */
function holdNextRead(path: string): Deferred<void> {
  const gate = deferred<void>();
  const readThrough = mockReadFile.getMockImplementation();
  mockReadFile.mockImplementationOnce((target, encoding) =>
    target === path
      ? gate.promise.then(() => {
          const text = files.get(target);
          return text === undefined
            ? Promise.reject(enoent(target))
            : Promise.resolve(text);
        })
      : (readThrough?.(target, encoding) ?? Promise.reject(enoent(target))),
  );
  return gate;
}

type UpdateTrackedPlanRequest = Parameters<typeof updateTrackedPlan>[0];

/** The fake persistence: a content change appends one revision. */
function applyTrackedPlanUpdate(
  request: UpdateTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const key = planFileKey(request);
  const existing = plans.get(key);
  if (!existing) {
    return Promise.resolve(null);
  }
  const content = request.content ?? existing.content;
  const contentChanged = request.content !== undefined;
  const latestRevisionNumber = contentChanged
    ? existing.latestRevisionNumber + 1
    : existing.latestRevisionNumber;
  const updated: TrackedPlanData = {
    ...existing,
    content,
    updatedAt: '2026-06-05T01:00:00.000Z',
    latestRevisionNumber,
    revisions: contentChanged
      ? [
          ...existing.revisions,
          {
            revisionNumber: latestRevisionNumber,
            content,
            source: existing.source,
            reviewStatus: existing.reviewStatus,
            createdAt: '2026-06-05T01:00:00.000Z',
          },
        ]
      : existing.revisions,
    ...(request.lastEditSource
      ? { lastEditSource: request.lastEditSource }
      : {}),
  };
  plans.set(key, updated);
  return Promise.resolve(updated);
}

function planPath(ref: PlanFileRef): string {
  return getPlanExplorePlanFilePath(ref.projectId, ref.worktreeId, ref.planId);
}

function buildPlan(
  ref: PlanFileRef,
  content: string,
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return {
    id: ref.planId,
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    source: 'claude',
    title: 'A plan',
    content,
    reviewStatus: 'pending',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content,
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-05T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function seedPlan(
  ref: PlanFileRef,
  content: string,
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  const plan = buildPlan(ref, content, overrides);
  plans.set(planFileKey(ref), plan);
  return plan;
}

function storedPlan(ref: PlanFileRef): TrackedPlanData | undefined {
  return plans.get(planFileKey(ref));
}

function fakeWindow(send: jest.Mock): SendableBrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send,
      mainFrame: { detached: false, isDestroyed: () => false },
    },
  };
}

/** Drain every pending promise continuation (setImmediate is not faked). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function writesTo(path: string): number {
  return mockWriteFile.mock.calls.filter(([target]) => target === path).length;
}

function readsOf(path: string): number {
  return mockReadFile.mock.calls.filter(([target]) => target === path).length;
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  files.clear();
  plans.clear();

  mockReadFile.mockImplementation((path) => {
    const text = files.get(path);
    return text === undefined
      ? Promise.reject(enoent(path))
      : Promise.resolve(text);
  });
  mockWriteFile.mockImplementation((path, content) => {
    files.set(path, content);
    return Promise.resolve();
  });
  mockMkdir.mockResolvedValue(undefined);
  mockReaddir.mockImplementation((dir) => {
    const prefix = `${dir}${sep}`;
    const names = new Set<string>();
    for (const path of Array.from(files.keys())) {
      if (path.startsWith(prefix)) {
        names.add(path.slice(prefix.length).split(sep)[0] ?? '');
      }
    }
    return names.size === 0
      ? Promise.reject(enoent(dir))
      : Promise.resolve(Array.from(names));
  });

  mockedGetTrackedPlan.mockImplementation((projectId, worktreeId, planId) =>
    Promise.resolve(
      plans.get(planFileKey({ projectId, worktreeId, planId })) ?? null,
    ),
  );
  mockedUpdateTrackedPlan.mockImplementation(applyTrackedPlanUpdate);
});

afterEach(() => {
  // No service path may resolve a plan through the plan-explore registry.
  expect(mockedGetPlanExploreTarget).not.toHaveBeenCalled();
  jest.clearAllTimers();
  jest.useRealTimers();
  registerWorkspaceTypes(new Map());
});

describe('plan file keys and turn scope', () => {
  it('keys plan files and chat turns by their full scope', () => {
    expect(planFileKey(REF)).toBe(JSON.stringify(['ws-1', 'wt-1', 'plan-1']));
    expect(planChatTurnKey('ws-1', 'wt-1', 'chat-1')).toBe(
      JSON.stringify(['ws-1', 'wt-1', 'chat-1']),
    );
    expect(planFileKey({ ...REF, worktreeId: OTHER_WORKTREE_ID })).not.toBe(
      planFileKey(REF),
    );
  });

  it('resolves an ordinary worktree turn to its own scope', () => {
    expect(resolvePlanTurnScope(PROJECT_ID, WORKTREE_ID)).toEqual(SCOPE);
    expect(mockedGetPlanExploreTargetSync).not.toHaveBeenCalled();
  });

  it('resolves the plan-explore sentinel to its registered real scope', () => {
    mockedGetPlanExploreTargetSync.mockReturnValue({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(resolvePlanTurnScope(PLAN_EXPLORE_CHAT_PROJECT_ID, PLAN_ID)).toEqual(
      SCOPE,
    );
    expect(mockedGetPlanExploreTargetSync).toHaveBeenCalledWith(PLAN_ID);
  });

  it('returns null for an unregistered takeover and scopes without plans', () => {
    mockedGetPlanExploreTargetSync.mockReturnValue(null);
    registerWorkspaceTypes(new Map([[COWORK_PROJECT_ID, 'cowork']]));

    expect(
      resolvePlanTurnScope(PLAN_EXPLORE_CHAT_PROJECT_ID, PLAN_ID),
    ).toBeNull();
    expect(resolvePlanTurnScope(COWORK_PROJECT_ID, 'entry-1')).toBeNull();
    expect(resolvePlanTurnScope(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBeNull();
    expect(
      resolvePlanTurnScope(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'container-1'),
    ).toBeNull();
  });
});

describe('PlanFileSyncService.materializePlanFile', () => {
  it('writes plan.md from the latest content and describes it', async () => {
    seedPlan(REF, ORIGINAL, { title: 'Roadmap', latestRevisionNumber: 3 });
    const service = new PlanFileSyncService();

    const result = await service.materializePlanFile(REF, { flush: true });

    expect(result).toEqual({
      filePath: planPath(REF),
      title: 'Roadmap',
      latestRevisionNumber: 3,
    });
    expect(planPath(REF)).toBe(
      join(getPlanExploreScopeDir(PROJECT_ID, WORKTREE_ID), PLAN_ID, 'plan.md'),
    );
    expect(mockMkdir).toHaveBeenCalledWith(
      join(getPlanExploreScopeDir(PROJECT_ID, WORKTREE_ID), PLAN_ID),
      { recursive: true },
    );
    expect(files.get(planPath(REF))).toBe(ORIGINAL);
  });

  it('writes nothing when plan.md already holds the latest content', async () => {
    seedPlan(REF, ORIGINAL);
    files.set(planPath(REF), ORIGINAL);
    const service = new PlanFileSyncService();

    const result = await service.materializePlanFile(REF, { flush: true });

    expect(result?.filePath).toBe(planPath(REF));
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
  });

  it('returns null for a missing plan and ignores scopes without plans', async () => {
    registerWorkspaceTypes(new Map([[COWORK_PROJECT_ID, 'cowork']]));
    const service = new PlanFileSyncService();

    expect(await service.materializePlanFile(REF, { flush: true })).toBeNull();
    expect(
      await service.materializePlanFile(
        {
          projectId: COWORK_PROJECT_ID,
          worktreeId: 'entry-1',
          planId: PLAN_ID,
        },
        { flush: true },
      ),
    ).toBeNull();
    expect(
      await service.materializePlanFile(
        {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
          planId: PLAN_ID,
        },
        { flush: true },
      ),
    ).toBeNull();
    expect(mockedGetTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('(a) does not apply an edited plan.md while a turn runs, leaves the file untouched, and returns its path', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    mockWriteFile.mockClear();

    service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    files.set(planPath(REF), EDITED);
    const result = await service.materializePlanFile(REF, { flush: true });

    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(EDITED);
    expect(result).toEqual({
      filePath: planPath(REF),
      title: 'A plan',
      latestRevisionNumber: 1,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('(b) applies an edited plan.md on a flush and emits tracked-plans:updated through the configured window', async () => {
    seedPlan(REF, ORIGINAL);
    const send = jest.fn();
    const service = new PlanFileSyncService();
    service.configure({ getWindow: () => fakeWindow(send) });
    await service.materializePlanFile(REF, { flush: true });

    files.set(planPath(REF), EDITED);
    const result = await service.materializePlanFile(REF, { flush: true });

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: PLAN_ID,
      content: EDITED,
      lastEditSource: 'agent',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('tracked-plans:updated', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      plan: storedPlan(REF),
    });
    expect(result?.latestRevisionNumber).toBe(2);
    expect(files.get(planPath(REF))).toBe(EDITED);
  });

  it('(c) applies a pre-restart edit even when a comment save moved plan.updatedAt past the file', async () => {
    // A comment save after the edit moved updatedAt; the file matches neither
    // the latest content nor any stored revision, so it is a real edit.
    seedPlan(REF, ORIGINAL, { updatedAt: '2026-06-05T00:05:00.000Z' });
    files.set(planPath(REF), EDITED);

    const restarted = new PlanFileSyncService();
    await restarted.materializePlanFile(REF, { flush: true });

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ content: EDITED, lastEditSource: 'agent' }),
    );
    expect(storedPlan(REF)?.latestRevisionNumber).toBe(2);
  });

  it('never creates a revision or overwrites an edit without a flush', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    mockWriteFile.mockClear();

    files.set(planPath(REF), EDITED);
    const result = await service.materializePlanFile(REF, { flush: false });

    expect(result?.filePath).toBe(planPath(REF));
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(EDITED);
  });

  it('creates an unedited working copy without a flush', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();

    const result = await service.materializePlanFile(REF, { flush: false });

    expect(result?.filePath).toBe(planPath(REF));
    expect(files.get(planPath(REF))).toBe(ORIGINAL);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
  });

  it('rewrites a stale file equal to an older revision after a restart without creating a revision', async () => {
    const latest = `${ORIGINAL}\n## Task 2`;
    seedPlan(REF, latest, {
      latestRevisionNumber: 2,
      revisions: [
        ...buildPlan(REF, ORIGINAL).revisions,
        {
          revisionNumber: 2,
          content: latest,
          source: 'claude',
          reviewStatus: 'pending',
          createdAt: '2026-06-05T00:01:00.000Z',
        },
      ],
    });
    files.set(planPath(REF), ORIGINAL);

    const restarted = new PlanFileSyncService();
    await restarted.checkPlanFileForChange(REF);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();

    await restarted.materializePlanFile(REF, { flush: true });

    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(latest);
  });

  it('rewrites the last materialized file after the tracked plan advances elsewhere', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });

    const revised = `${ORIGINAL}\n## Task 2`;
    seedPlan(REF, revised, { latestRevisionNumber: 2 });
    await service.materializePlanFile(REF, { flush: true });

    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(revised);
  });

  it('serializes concurrent materializations into one write', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();

    const [first, second] = await Promise.all([
      service.materializePlanFile(REF, { flush: true }),
      service.materializePlanFile(REF, { flush: true }),
    ]);

    expect(writesTo(planPath(REF))).toBe(1);
    expect(first?.filePath).toBe(planPath(REF));
    expect(second?.filePath).toBe(planPath(REF));
  });

  it('creates one revision when a materialize races a fired debounce', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);

    // Fire the debounce synchronously, then materialize before it settles.
    jest.advanceTimersByTime(DEBOUNCE_MS);
    const result = await service.materializePlanFile(REF, { flush: true });
    await settle();

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(result?.latestRevisionNumber).toBe(2);
    expect(storedPlan(REF)?.latestRevisionNumber).toBe(2);
  });
});

describe('PlanFileSyncService change detection', () => {
  it('ignores its own write', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });

    await service.checkPlanFileForChange(REF);

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
  });

  it('applies a debounced edit exactly once and emits once', async () => {
    seedPlan(REF, ORIGINAL);
    const send = jest.fn();
    const service = new PlanFileSyncService({
      getWindow: (): SendableBrowserWindow => fakeWindow(send),
    });
    await service.materializePlanFile(REF, { flush: true });

    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);
    await service.checkPlanFileForChange(REF);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await service.checkPlanFileForChange(REF);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: PLAN_ID,
      content: EDITED,
      lastEditSource: 'agent',
    });
    expect(send.mock.calls).toEqual([
      [
        'tracked-plans:updated',
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          plan: storedPlan(REF),
        },
      ],
    ]);
    expect(storedPlan(REF)?.content).toBe(EDITED);
    expect(storedPlan(REF)?.latestRevisionNumber).toBe(2);
  });

  it('creates no revision for a comment-only plan update after a restart', async () => {
    // Content equals the file; only updatedAt moved (a comment save).
    seedPlan(REF, ORIGINAL, { updatedAt: '2026-06-05T00:09:00.000Z' });
    files.set(planPath(REF), ORIGINAL);

    const restarted = new PlanFileSyncService();
    await restarted.checkPlanFileForChange(REF);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await restarted.checkPlanFileForChange(REF);

    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('forgetPlanFile clears a pending debounce', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);
    expect(jest.getTimerCount()).toBe(1);

    service.forgetPlanFile(REF);

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
  });

  it('forgetScope clears only that scope', async () => {
    const otherScopeRef: PlanFileRef = {
      ...REF,
      worktreeId: OTHER_WORKTREE_ID,
    };
    seedPlan(REF, ORIGINAL);
    seedPlan(otherScopeRef, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    await service.materializePlanFile(otherScopeRef, { flush: true });
    files.set(planPath(REF), EDITED);
    files.set(planPath(otherScopeRef), EDITED);
    await service.checkPlanFileForChange(REF);
    await service.checkPlanFileForChange(otherScopeRef);
    expect(jest.getTimerCount()).toBe(2);

    service.forgetScope(SCOPE);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: OTHER_WORKTREE_ID }),
    );
  });

  it('logs a failed detached refresh instead of leaking a rejection', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    mockedUpdateTrackedPlan.mockRejectedValueOnce(new Error('disk full'));
    await service.checkPlanFileForChange(REF);

    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await settle();

    expect(mockedLogMainProcessError).toHaveBeenCalledWith(
      expect.stringContaining(PLAN_ID),
      expect.objectContaining({ message: 'disk full' }),
    );
  });
});

describe('PlanFileSyncService unreadable plan files', () => {
  it.each(['EACCES', 'EIO'])(
    'resolves null and neither writes nor creates a revision when an existing plan.md cannot be read (%s)',
    async (code) => {
      seedPlan(REF, ORIGINAL);
      const service = new PlanFileSyncService();
      await service.materializePlanFile(REF, { flush: true });
      files.set(planPath(REF), EDITED);
      makeUnreadable(planPath(REF), code);
      mockWriteFile.mockClear();
      mockMkdir.mockClear();

      const flushed = await service.materializePlanFile(REF, { flush: true });
      const unflushed = await service.materializePlanFile(REF, {
        flush: false,
      });

      expect(flushed).toBeNull();
      expect(unflushed).toBeNull();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
      expect(files.get(planPath(REF))).toBe(EDITED);
      expect(storedPlan(REF)?.latestRevisionNumber).toBe(1);
      expect(mockedLogMainProcessError).toHaveBeenCalledTimes(2);
      expect(mockedLogMainProcessError).toHaveBeenCalledWith(
        expect.stringContaining(PLAN_ID),
        expect.anything(),
      );
    },
  );

  it.each(['EACCES', 'EIO'])(
    'never overwrites an unreadable plan.md after a restart (%s)',
    async (code) => {
      seedPlan(REF, ORIGINAL);
      files.set(planPath(REF), EDITED);
      makeUnreadable(planPath(REF), code);

      const restarted = new PlanFileSyncService();
      const result = await restarted.materializePlanFile(REF, { flush: true });

      expect(result).toBeNull();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
      expect(files.get(planPath(REF))).toBe(EDITED);
    },
  );

  it.each(['EACCES', 'EIO'])(
    'logs and leaves the file and plan untouched when a pending refresh cannot read plan.md (%s)',
    async (code) => {
      seedPlan(REF, ORIGINAL);
      const service = new PlanFileSyncService();
      await service.materializePlanFile(REF, { flush: true });
      files.set(planPath(REF), EDITED);
      await service.checkPlanFileForChange(REF);
      expect(jest.getTimerCount()).toBe(1);
      makeUnreadable(planPath(REF), code);
      mockWriteFile.mockClear();

      await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await settle();

      expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(files.get(planPath(REF))).toBe(EDITED);
      expect(mockedLogMainProcessError).toHaveBeenCalledTimes(1);
      expect(mockedLogMainProcessError).toHaveBeenCalledWith(
        expect.stringContaining(PLAN_ID),
        expect.anything(),
      );
    },
  );

  it('logs an unreadable plan when a visible plan is checked and keeps checking the others at lease end', async () => {
    seedPlan(REF, ORIGINAL);
    seedPlan(OTHER_REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    await service.materializePlanFile(OTHER_REF, { flush: true });
    files.set(planPath(REF), EDITED);
    files.set(planPath(OTHER_REF), `${EDITED} two`);
    makeUnreadable(planPath(REF), 'EIO');
    mockWriteFile.mockClear();

    service.acquireVisibility(REF, 'sender-1:a');
    await settle();
    expect(mockedLogMainProcessError).toHaveBeenCalledTimes(1);
    service.releaseVisibility(REF, 'sender-1:a');

    const lease = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedLogMainProcessError).toHaveBeenCalledTimes(2);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: OTHER_PLAN_ID,
        content: `${EDITED} two`,
      }),
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(EDITED);
  });
});

describe('PlanFileSyncService turn admission during an apply', () => {
  const turnKey = planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1');

  it('(a) parks a debounced edit when a turn begins between the file read and the commit, then applies it once after that turn', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);
    const read = holdNextRead(planPath(REF));

    // The refresh passes its idle check and starts reading plan.md.
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const lease = service.beginTurn(turnKey, SCOPE);
    read.resolve();
    await settle();

    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ content: EDITED, lastEditSource: 'agent' }),
    );
    expect(storedPlan(REF)?.latestRevisionNumber).toBe(2);
  });

  it('(a) parks a flushed edit when a turn begins between the file read and the commit, then applies it once after that turn', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    const read = holdNextRead(planPath(REF));

    const materialized = service.materializePlanFile(REF, { flush: true });
    await settle();
    const lease = service.beginTurn(turnKey, SCOPE);
    read.resolve();

    expect(await materialized).toEqual({
      filePath: planPath(REF),
      title: 'A plan',
      latestRevisionNumber: 1,
    });
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(EDITED);

    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(storedPlan(REF)?.content).toBe(EDITED);
  });

  it('(b) commits exactly one pre-turn revision when a turn begins while the update is persisting, and applies that turn’s own edit only after it ends', async () => {
    seedPlan(REF, ORIGINAL);
    const send = jest.fn();
    const service = new PlanFileSyncService({
      getWindow: (): SendableBrowserWindow => fakeWindow(send),
    });
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);
    const commit = deferred<void>();
    mockedUpdateTrackedPlan.mockImplementationOnce((request) =>
      commit.promise.then(() => applyTrackedPlanUpdate(request)),
    );

    // The refresh reads the pre-turn edit and requests its revision.
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);

    // A turn begins while that update is still persisting; its own
    // materialization waits behind the per-plan lock.
    const lease = service.beginTurn(turnKey, SCOPE);
    let turnMaterialized = false;
    const turnMaterialize = service
      .materializePlanFile(REF, { flush: true })
      .then((result) => {
        turnMaterialized = true;
        return result;
      });
    await settle();
    expect(turnMaterialized).toBe(false);
    mockWriteFile.mockClear();

    commit.resolve();
    const result = await turnMaterialize;

    expect(result?.latestRevisionNumber).toBe(2);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ content: EDITED, lastEditSource: 'agent' }),
    );
    expect(
      storedPlan(REF)?.revisions.map((revision) => revision.content),
    ).toEqual([ORIGINAL, EDITED]);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(files.get(planPath(REF))).toBe(EDITED);
    expect(send).toHaveBeenCalledTimes(1);

    // The turn's own edit stays pending until the turn ends.
    const turnEdit = `${EDITED}\n## Task 2`;
    files.set(planPath(REF), turnEdit);
    await service.checkPlanFileForChange(REF);
    await service.materializePlanFile(REF, { flush: true });
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(files.get(planPath(REF))).toBe(turnEdit);

    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(2);
    expect(mockedUpdateTrackedPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: turnEdit, lastEditSource: 'agent' }),
    );
    expect(storedPlan(REF)?.latestRevisionNumber).toBe(3);
  });
});

describe('PlanFileSyncService turn leases', () => {
  it('parks a check while a turn runs, arms no timer, and applies once when the turn ends', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });

    const lease = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    expect(service.isScopeActive(SCOPE)).toBe(true);
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();

    lease.end();
    expect(service.isScopeActive(SCOPE)).toBe(false);
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ content: EDITED, lastEditSource: 'agent' }),
    );
  });

  it('parks a debounce that fires after a turn began without re-arming', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    files.set(planPath(REF), EDITED);
    await service.checkPlanFileForChange(REF);
    expect(jest.getTimerCount()).toBe(1);

    const lease = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await settle();

    expect(jest.getTimerCount()).toBe(0);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();

    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
  });

  it('applies two plans once each only after the second of two leases in the scope ends', async () => {
    seedPlan(REF, ORIGINAL);
    seedPlan(OTHER_REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    await service.materializePlanFile(OTHER_REF, { flush: true });

    const first = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    const second = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-2'),
      SCOPE,
    );
    files.set(planPath(REF), EDITED);
    files.set(planPath(OTHER_REF), `${EDITED} two`);

    first.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(service.isScopeActive(SCOPE)).toBe(true);

    second.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(2);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: PLAN_ID, content: EDITED }),
    );
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: OTHER_PLAN_ID,
        content: `${EDITED} two`,
      }),
    );
  });

  it('keeps the same plan id in two worktrees independent', async () => {
    const w2Ref: PlanFileRef = { ...REF, worktreeId: OTHER_WORKTREE_ID };
    const w2Original = '# W2 plan';
    const w2Edited = '# W2 plan (edited)';
    seedPlan(REF, ORIGINAL);
    seedPlan(w2Ref, w2Original);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    await service.materializePlanFile(w2Ref, { flush: true });

    const lease = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    expect(
      service.isScopeActive({ ...SCOPE, worktreeId: OTHER_WORKTREE_ID }),
    ).toBe(false);
    files.set(planPath(REF), EDITED);
    files.set(planPath(w2Ref), w2Edited);
    await service.checkPlanFileForChange(REF);
    await service.checkPlanFileForChange(w2Ref);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: OTHER_WORKTREE_ID,
      planId: PLAN_ID,
      content: w2Edited,
      lastEditSource: 'agent',
    });

    // W2's applied edit did not become W1's baseline.
    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(2);
    expect(mockedUpdateTrackedPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, content: EDITED }),
    );
  });

  it('keeps deferring after a superseded lease ends and applies once when the current one ends', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    const turnKey = planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1');

    const superseded = service.beginTurn(turnKey, SCOPE);
    const current = service.beginTurn(turnKey, SCOPE);
    files.set(planPath(REF), EDITED);

    superseded.end();
    await settle();
    expect(service.isScopeActive(SCOPE)).toBe(true);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).not.toHaveBeenCalled();
    expect(mockReaddir).not.toHaveBeenCalled();

    current.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
  });

  it('does not let a superseded lease that never ends hold the scope, and ignores its late end', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    const turnKey = planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1');

    // A reload re-begins the same chat's turn without ending the first lease.
    const superseded = service.beginTurn(turnKey, SCOPE);
    const current = service.beginTurn(turnKey, SCOPE);
    files.set(planPath(REF), EDITED);

    current.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(service.isScopeActive(SCOPE)).toBe(false);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);

    const next = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-2'),
      SCOPE,
    );
    superseded.end();
    await settle();
    expect(service.isScopeActive(SCOPE)).toBe(true);
    expect(mockReaddir).toHaveBeenCalledTimes(1);
    next.end();
  });

  it('runs one scope check for a doubly ended lease', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    const lease = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    const other = service.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-2'),
      SCOPE,
    );
    other.end();
    await settle();
    expect(mockReaddir).not.toHaveBeenCalled();

    lease.end();
    lease.end();
    other.end();
    await settle();

    expect(mockReaddir).toHaveBeenCalledTimes(1);
    expect(mockReaddir).toHaveBeenCalledWith(
      getPlanExploreScopeDir(PROJECT_ID, WORKTREE_ID),
    );
    expect(service.isScopeActive(SCOPE)).toBe(false);
  });

  it('checks a plan known only from the scope directory when the last lease ends', async () => {
    seedPlan(REF, ORIGINAL);
    files.set(planPath(REF), EDITED);
    const restarted = new PlanFileSyncService();

    const lease = restarted.beginTurn(
      planChatTurnKey(PROJECT_ID, WORKTREE_ID, 'chat-1'),
      SCOPE,
    );
    lease.end();
    await settle();
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockReaddir).toHaveBeenCalledWith(
      getPlanExploreScopeDir(PROJECT_ID, WORKTREE_ID),
    );
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: PLAN_ID, content: EDITED }),
    );
  });

  it('hands out a no-op lease for scopes without plans', async () => {
    registerWorkspaceTypes(new Map([[COWORK_PROJECT_ID, 'cowork']]));
    const service = new PlanFileSyncService();
    const cowork: PlanFileScope = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: 'entry-1',
    };

    const lease = service.beginTurn(
      planChatTurnKey(COWORK_PROJECT_ID, 'entry-1', 'chat-1'),
      cowork,
    );
    expect(service.isScopeActive(cowork)).toBe(false);
    lease.end();
    await settle();

    expect(mockReaddir).not.toHaveBeenCalled();
  });
});

describe('PlanFileSyncService visibility', () => {
  it('checks a plan as soon as it becomes visible', async () => {
    seedPlan(REF, ORIGINAL);
    files.set(planPath(REF), EDITED);
    const restarted = new PlanFileSyncService();

    restarted.acquireVisibility(REF, 'sender-1:consumer-1');
    await settle();
    expect(readsOf(planPath(REF))).toBe(1);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    restarted.releaseVisibility(REF, 'sender-1:consumer-1');
  });

  it('keeps the poll running until the last owner releases', async () => {
    seedPlan(REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });

    service.acquireVisibility(REF, 'sender-1:a');
    service.acquireVisibility(REF, 'sender-1:b');
    await settle();
    expect(jest.getTimerCount()).toBe(1);

    service.releaseVisibility(REF, 'sender-1:a');
    expect(jest.getTimerCount()).toBe(1);
    mockReadFile.mockClear();
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(readsOf(planPath(REF))).toBe(1);

    service.releaseVisibility(REF, 'sender-1:b');
    expect(jest.getTimerCount()).toBe(0);
    mockReadFile.mockClear();
    await jest.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('polls only visible plans', async () => {
    seedPlan(REF, ORIGINAL);
    seedPlan(OTHER_REF, ORIGINAL);
    const service = new PlanFileSyncService();
    await service.materializePlanFile(REF, { flush: true });
    await service.materializePlanFile(OTHER_REF, { flush: true });

    service.acquireVisibility(REF, 'sender-1:a');
    await settle();
    files.set(planPath(REF), EDITED);
    files.set(planPath(OTHER_REF), `${EDITED} two`);
    mockReadFile.mockClear();
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(readsOf(planPath(REF))).toBe(1);
    expect(readsOf(planPath(OTHER_REF))).toBe(0);
    await jest.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedUpdateTrackedPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: PLAN_ID }),
    );
    service.releaseVisibility(REF, 'sender-1:a');
  });

  it('ignores Cowork and shared-viewer refs', async () => {
    registerWorkspaceTypes(new Map([[COWORK_PROJECT_ID, 'cowork']]));
    const service = new PlanFileSyncService();

    service.acquireVisibility(
      { projectId: COWORK_PROJECT_ID, worktreeId: 'entry-1', planId: PLAN_ID },
      'sender-1:a',
    );
    service.acquireVisibility(
      {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
        planId: PLAN_ID,
      },
      'sender-1:b',
    );
    await settle();

    expect(jest.getTimerCount()).toBe(0);
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
