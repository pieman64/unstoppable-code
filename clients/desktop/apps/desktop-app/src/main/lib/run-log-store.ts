import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

export const MAX_RUN_LOG_BYTES = 1024 * 1024;
export const MAX_RUN_LOG_LINES = 2000;

export interface ActiveRunLogState {
  runId: string;
  lineCount: number;
  byteCount: number;
}

export interface RunLogCoordinator {
  activeRunStates: Map<string, ActiveRunLogState>;
  getWriteKey: (
    projectId: string,
    worktreeId: string,
    runKey: string,
  ) => string;
  isDeletingWorktreeLogs: (projectId: string, worktreeId: string) => boolean;
  awaitPendingWrite: (
    projectId: string,
    worktreeId: string,
    runKey: string,
  ) => Promise<void>;
  withWriteChain: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  deleteWorktreeLogs: (
    projectId: string,
    worktreeId: string,
    removeLogs: () => Promise<void>,
  ) => Promise<void>;
}

export interface RunLogPaths {
  dirPath: string;
  metaPath: string;
  logPath: string;
}

export async function startRunLogFiles(args: {
  coordinator: RunLogCoordinator;
  projectId: string;
  worktreeId: string;
  runKey: string;
  runId: string;
  paths: RunLogPaths;
  meta: unknown;
}): Promise<void> {
  const writeKey = args.coordinator.getWriteKey(
    args.projectId,
    args.worktreeId,
    args.runKey,
  );
  if (
    args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
  ) {
    return;
  }

  await args.coordinator.withWriteChain(writeKey, async () => {
    if (
      args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
    ) {
      return;
    }

    await mkdir(args.paths.dirPath, { recursive: true });
    await Promise.all([
      writeFile(
        args.paths.metaPath,
        JSON.stringify(args.meta, null, 2),
        'utf8',
      ),
      writeFile(args.paths.logPath, '', 'utf8'),
    ]);
    args.coordinator.activeRunStates.set(
      writeKey,
      buildActiveRunState(args.runId, []),
    );
  });
}

export async function completeRunLogFiles<
  TMeta extends { runId: string },
>(args: {
  coordinator: RunLogCoordinator;
  projectId: string;
  worktreeId: string;
  runKey: string;
  runId: string;
  paths: Pick<RunLogPaths, 'metaPath' | 'logPath'>;
  readMeta: () => Promise<TMeta | null>;
  buildNextMeta: (meta: TMeta, now: string) => TMeta;
}): Promise<void> {
  const writeKey = args.coordinator.getWriteKey(
    args.projectId,
    args.worktreeId,
    args.runKey,
  );
  if (
    args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
  ) {
    return;
  }

  try {
    await args.coordinator.withWriteChain(writeKey, async () => {
      if (
        args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
      ) {
        return;
      }

      const meta = await args.readMeta();
      if (!meta || meta.runId !== args.runId) {
        return;
      }

      await compactRunLog(args.paths.logPath, args.runId);

      const nextMeta = args.buildNextMeta(meta, new Date().toISOString());
      await writeFile(
        args.paths.metaPath,
        JSON.stringify(nextMeta, null, 2),
        'utf8',
      );
    });
  } finally {
    const activeRun = args.coordinator.activeRunStates.get(writeKey);
    if (activeRun?.runId === args.runId) {
      args.coordinator.activeRunStates.delete(writeKey);
    }
  }
}

function getWorktreeLogKey(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

function getWorktreeWriteKeyPrefix(
  projectId: string,
  worktreeId: string,
): string {
  return `${getWorktreeLogKey(projectId, worktreeId)}\0`;
}

export function createRunLogCoordinator(): RunLogCoordinator {
  const writeChains = new Map<string, Promise<void>>();
  const activeRunStates = new Map<string, ActiveRunLogState>();
  const deletingWorktreeLogKeys = new Set<string>();

  function getWriteKey(
    projectId: string,
    worktreeId: string,
    runKey: string,
  ): string {
    return `${projectId}\0${worktreeId}\0${runKey}`;
  }

  function isDeletingWorktreeLogs(
    projectId: string,
    worktreeId: string,
  ): boolean {
    return deletingWorktreeLogKeys.has(
      getWorktreeLogKey(projectId, worktreeId),
    );
  }

  async function awaitPendingWritesForWorktree(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    const prefix = getWorktreeWriteKeyPrefix(projectId, worktreeId);
    while (true) {
      const pendingWrites = Array.from(writeChains.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([, promise]) => promise);
      if (pendingWrites.length === 0) {
        return;
      }
      await Promise.allSettled(pendingWrites);
    }
  }

  async function awaitPendingWrite(
    projectId: string,
    worktreeId: string,
    runKey: string,
  ): Promise<void> {
    await (writeChains.get(getWriteKey(projectId, worktreeId, runKey)) ??
      Promise.resolve());
  }

  async function withWriteChain<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = writeChains.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeChains.set(key, current);
    await prev;
    try {
      return await fn();
    } finally {
      if (release) {
        release();
      }
      if (writeChains.get(key) === current) {
        writeChains.delete(key);
      }
    }
  }

  async function deleteWorktreeLogs(
    projectId: string,
    worktreeId: string,
    removeLogs: () => Promise<void>,
  ): Promise<void> {
    const worktreeLogKey = getWorktreeLogKey(projectId, worktreeId);
    const worktreeKeyPrefix = getWorktreeWriteKeyPrefix(projectId, worktreeId);
    deletingWorktreeLogKeys.add(worktreeLogKey);
    try {
      await awaitPendingWritesForWorktree(projectId, worktreeId);

      for (const key of Array.from(activeRunStates.keys())) {
        if (key.startsWith(worktreeKeyPrefix)) {
          activeRunStates.delete(key);
        }
      }

      await removeLogs();
    } finally {
      deletingWorktreeLogKeys.delete(worktreeLogKey);
    }
  }

  return {
    activeRunStates,
    getWriteKey,
    isDeletingWorktreeLogs,
    awaitPendingWrite,
    withWriteChain,
    deleteWorktreeLogs,
  };
}

export function parseLogLines(raw: string): string[] {
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function serializeLogLines(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function getSerializedLineByteCount(lines: string[]): number {
  return lines.reduce(
    (total, line) => total + Buffer.byteLength(line, 'utf8') + 1,
    0,
  );
}

export function buildActiveRunState(
  runId: string,
  lines: string[],
): ActiveRunLogState {
  return {
    runId,
    lineCount: lines.length,
    byteCount: getSerializedLineByteCount(lines),
  };
}

export function compactLogLines(lines: string[]): string[] {
  const cappedByCount =
    lines.length > MAX_RUN_LOG_LINES
      ? lines.slice(-MAX_RUN_LOG_LINES)
      : [...lines];

  let startIdx = 0;
  let totalBytes = getSerializedLineByteCount(cappedByCount);
  while (totalBytes > MAX_RUN_LOG_BYTES && startIdx < cappedByCount.length) {
    totalBytes -= Buffer.byteLength(cappedByCount[startIdx] ?? '', 'utf8') + 1;
    startIdx += 1;
  }

  return startIdx === 0 ? cappedByCount : cappedByCount.slice(startIdx);
}

export async function readRunLogState(
  logPath: string,
  runId: string,
): Promise<ActiveRunLogState> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return buildActiveRunState(runId, parseLogLines(raw));
}

export async function compactRunLog(
  logPath: string,
  runId: string,
): Promise<ActiveRunLogState> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  const compactedLines = compactLogLines(parseLogLines(raw));
  const compactedText = serializeLogLines(compactedLines);
  if (compactedText !== raw) {
    await writeFile(logPath, compactedText, 'utf8');
  }
  return buildActiveRunState(runId, compactedLines);
}

export async function appendRunLogLines(args: {
  coordinator: RunLogCoordinator;
  projectId: string;
  worktreeId: string;
  runKey: string;
  runId: string;
  logPath: string;
  lines: string[];
  isCurrentRun: () => Promise<boolean>;
}): Promise<void> {
  if (args.lines.length === 0) {
    return;
  }
  if (
    args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
  ) {
    return;
  }

  const appendedText = serializeLogLines(args.lines);
  const appendedByteCount = getSerializedLineByteCount(args.lines);
  const writeKey = args.coordinator.getWriteKey(
    args.projectId,
    args.worktreeId,
    args.runKey,
  );

  await args.coordinator.withWriteChain(writeKey, async () => {
    if (
      args.coordinator.isDeletingWorktreeLogs(args.projectId, args.worktreeId)
    ) {
      return;
    }
    if (!(await args.isCurrentRun())) {
      return;
    }

    let state = args.coordinator.activeRunStates.get(writeKey);
    if (!state || state.runId !== args.runId) {
      state = await readRunLogState(args.logPath, args.runId);
    }

    await appendFile(args.logPath, appendedText, 'utf8');

    const nextState = {
      runId: args.runId,
      lineCount: state.lineCount + args.lines.length,
      byteCount: state.byteCount + appendedByteCount,
    };
    if (
      nextState.lineCount > MAX_RUN_LOG_LINES ||
      nextState.byteCount > MAX_RUN_LOG_BYTES
    ) {
      args.coordinator.activeRunStates.set(
        writeKey,
        await compactRunLog(args.logPath, args.runId),
      );
      return;
    }

    args.coordinator.activeRunStates.set(writeKey, nextState);
  });
}
