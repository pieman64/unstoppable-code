import { turnFilePath } from './file-path';

/**
 * Untrusted transcript evidence, not a worker locator or filesystem grant.
 * Hosts resolve, check existence and authorize each path before file actions.
 */
export interface TurnFileRecord {
  path: string;
  state: 'creating' | 'ready' | 'failed';
  /** Omission preserves legacy saved-file behavior, including overwrites. */
  change?: 'updated';
  /** Successful Write/add evidence; presentation receipts never set this. */
  saved?: true;
  /** Successful deletion evidence retained until host canonical reconciliation. */
  removed?: true;
  /** Successful move sources; lexical aliases may need host root resolution. */
  movedFrom?: string[];
  /** Ordered evidence; the host reconciles this instead of lexical summaries. */
  evidence?: TurnFileEvidence[];
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: { projectId: string; worktreeId: string };
}

/** A stable tool contribution; result updates replace it without reordering. */
export interface TurnFileEvidence extends Omit<TurnFileRecord, 'evidence'> {
  key: string;
  /** Explicit path alias supplied by a successful presentation receipt. */
  requestedPath?: string;
}

/** Legacy records remain usable when ordered evidence is unavailable. */
export function expandTurnFileRecords(
  files: readonly TurnFileRecord[],
): TurnFileRecord[] {
  const evidence = files.find((file) => file.evidence)?.evidence;
  if (!evidence) return [...files];
  type Alias = Pick<TurnFileRecord, 'path' | 'target'>;
  const aliases = new Map<string, Alias | null>();
  const windowsAliases = new Map<string, Alias | null>();
  const windows = (path: string): boolean => /^(?:[a-z]:\/|\/\/)/i.test(path);
  const pathKey = (path: string): string =>
    windows(path) ? path.toLowerCase() : path;
  const remember = (
    map: Map<string, Alias | null>,
    key: string,
    file: Alias,
  ): void => {
    const previous = map.get(key);
    if (previous === null) return;
    if (
      previous &&
      (pathKey(previous.path) !== pathKey(file.path) ||
        (previous.target &&
          file.target &&
          (previous.target.projectId !== file.target.projectId ||
            previous.target.worktreeId !== file.target.worktreeId)))
    ) {
      map.set(key, null);
      return;
    }
    const target = file.target ?? previous?.target;
    map.set(key, { path: file.path, ...(target ? { target } : {}) });
  };
  for (const file of evidence) {
    if (!file.requestedPath) continue;
    remember(aliases, pathKey(file.requestedPath), file);
    remember(aliases, pathKey(file.path), file);
    if (windows(file.path))
      remember(windowsAliases, file.requestedPath.toLowerCase(), file);
  }
  const resolve = (path: string, target: TurnFileRecord['target']): Alias => {
    const exact = aliases.get(pathKey(path));
    const alias =
      exact === null
        ? undefined
        : (exact ?? windowsAliases.get(path.toLowerCase()));
    if (
      !alias ||
      (target &&
        alias.target &&
        (target.projectId !== alias.target.projectId ||
          target.worktreeId !== alias.target.worktreeId))
    )
      return { path, ...(target ? { target } : {}) };
    const owner = target ?? alias.target;
    return { path: alias.path, ...(owner ? { target: owner } : {}) };
  };
  return evidence.map(({ key, requestedPath, ...file }) => {
    void key;
    void requestedPath;
    const resolved = resolve(file.path, file.target);
    let target = resolved.target;
    const movedFrom = file.movedFrom?.map((path) => {
      const source = resolve(path, target);
      target ??= source.target;
      return source.path;
    });
    return {
      ...file,
      ...resolved,
      ...(target ? { target } : {}),
      ...(movedFrom ? { movedFrom } : {}),
    };
  });
}

/** Validate cached/imported evidence without granting access to its path. */
export function isTurnFileRecord(value: unknown): value is TurnFileRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  if (
    !('path' in value) ||
    typeof value.path !== 'string' ||
    turnFilePath(value.path) !== value.path
  )
    return false;
  if (
    !('state' in value) ||
    (value.state !== 'creating' &&
      value.state !== 'ready' &&
      value.state !== 'failed')
  )
    return false;
  if (
    'change' in value &&
    value.change !== undefined &&
    value.change !== 'updated'
  )
    return false;
  if ('saved' in value && value.saved !== undefined && value.saved !== true)
    return false;
  if (
    'removed' in value &&
    value.removed !== undefined &&
    (value.removed !== true ||
      (value.state !== 'ready' && value.state !== 'failed'))
  )
    return false;
  if (
    'movedFrom' in value &&
    value.movedFrom !== undefined &&
    (!Array.isArray(value.movedFrom) ||
      value.state !== 'ready' ||
      !value.movedFrom.length ||
      !value.movedFrom.every(
        (path: unknown) =>
          typeof path === 'string' && turnFilePath(path) === path,
      ))
  )
    return false;
  if ('evidence' in value && value.evidence !== undefined) {
    const keys = new Set<string>();
    if (
      !Array.isArray(value.evidence) ||
      !value.evidence.length ||
      !value.evidence.every((entry: unknown) => {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          'evidence' in entry ||
          !('key' in entry) ||
          typeof entry.key !== 'string' ||
          !entry.key.length ||
          keys.has(entry.key) ||
          !isTurnFileRecord(entry)
        )
          return false;
        if (
          'requestedPath' in entry &&
          entry.requestedPath !== undefined &&
          (typeof entry.requestedPath !== 'string' ||
            turnFilePath(entry.requestedPath) !== entry.requestedPath ||
            entry.state !== 'ready')
        )
          return false;
        keys.add(entry.key);
        return true;
      })
    )
      return false;
  }
  if ('target' in value && value.target !== undefined) {
    const target = value.target;
    if (
      typeof target !== 'object' ||
      target === null ||
      Array.isArray(target) ||
      !('projectId' in target) ||
      typeof target.projectId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(target.projectId) ||
      !('worktreeId' in target) ||
      typeof target.worktreeId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(target.worktreeId)
    )
      return false;
  }
  return true;
}

/** A tool target is a literal path, while file-link host ports accept hrefs. */
export function turnFileHref(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Merge evidence only after the host resolves the same scoped file identity. */
export function mergeTurnFileRecords(
  previous: TurnFileRecord | undefined,
  next: TurnFileRecord,
): TurnFileRecord {
  if (!previous || next.removed) return next;
  if (previous.removed)
    return next.saved || next.change || next.state !== 'ready'
      ? next
      : previous;
  const isMutation = (file: TurnFileRecord): boolean =>
    file.saved === true || file.change === 'updated' || file.state !== 'ready';
  const successful = [previous, next].filter(
    (file) => file.state === 'ready' && isMutation(file),
  );
  const saved = successful.some((file) => file.saved);
  const state = successful.length
    ? 'ready'
    : previous.state === 'creating' || next.state === 'creating'
      ? 'creating'
      : isMutation(next)
        ? next.state
        : isMutation(previous)
          ? previous.state
          : next.state;
  const change = saved
    ? undefined
    : successful.length
      ? 'updated'
      : (next.change ?? previous.change);
  const target = next.target ?? previous.target;
  return {
    path: next.path,
    state,
    ...(saved ? { saved: true } : {}),
    ...(change ? { change } : {}),
    ...(target ? { target } : {}),
    ...((previous.movedFrom || next.movedFrom) && state === 'ready'
      ? {
          movedFrom: Array.from(
            new Set([...(previous.movedFrom ?? []), ...(next.movedFrom ?? [])]),
          ),
        }
      : {}),
  };
}

/** Lexical root projection only; host existence and authorization remain separate. */
export function locateTurnFilePath(
  path: string,
  roots: readonly { id: string; absolutePath: string }[],
):
  | {
      rootId: string;
      absolutePath: string;
      relativePath: string;
      identity: string;
    }
  | undefined {
  const normalized = turnFilePath(path);
  const first = roots[0];
  if (!normalized || !first) return undefined;
  const absolutePath = /^(?:\/|[a-z]:\/)/i.test(normalized)
    ? normalized
    : turnFilePath(`${first.absolutePath.replace(/\/+$/, '')}/${normalized}`);
  if (!absolutePath || !/^(?:\/|[a-z]:\/)/i.test(absolutePath))
    return undefined;
  let answer:
    | {
        rootId: string;
        absolutePath: string;
        relativePath: string;
        identity: string;
      }
    | undefined;
  for (const root of roots) {
    const base =
      root.absolutePath === '/' ? '' : turnFilePath(root.absolutePath);
    if (base === undefined) continue;
    const insensitive = /^(?:[a-z]:\/|\/\/)/i.test(base);
    const candidate = insensitive ? absolutePath.toLowerCase() : absolutePath;
    const prefix = `${insensitive ? base.toLowerCase() : base}/`;
    if (!candidate.startsWith(prefix)) continue;
    const relativePath = absolutePath.slice(prefix.length);
    if (
      !relativePath ||
      (answer && relativePath.length >= answer.relativePath.length)
    )
      continue;
    answer = {
      rootId: root.id,
      absolutePath,
      relativePath,
      identity: `${root.id}:${insensitive ? relativePath.toLowerCase() : relativePath}`,
    };
  }
  return answer;
}

/** Apply moves/deletes only after the host resolves scoped canonical identities. */
export function reconcileTurnFileRecords<
  T extends {
    identity: string;
    file: TurnFileRecord;
    sourceIdentities?: readonly string[];
  },
>(entries: readonly T[]): T[] {
  const files = new Map<string, T>();
  for (const entry of entries) {
    let file = entry.file;
    for (const source of entry.sourceIdentities ?? []) {
      if (file.state !== 'ready' || file.removed) continue;
      const previous = files.get(source);
      if (previous && !previous.file.removed)
        file = mergeTurnFileRecords(previous.file, file);
      if (source !== entry.identity)
        files.set(source, {
          ...(previous ?? entry),
          identity: source,
          file: {
            path: previous?.file.path ?? file.path,
            state: 'ready',
            removed: true,
          },
        });
    }
    const previous = files.get(entry.identity);
    const merged = mergeTurnFileRecords(previous?.file, file);
    files.set(entry.identity, {
      ...(merged.state === 'ready' && file.state !== 'ready'
        ? (previous ?? entry)
        : entry),
      file: merged,
    });
  }
  return Array.from(files.values()).filter((entry) => !entry.file.removed);
}
