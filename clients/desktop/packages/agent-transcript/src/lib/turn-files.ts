import { turnFilePath } from '@canopy/protocol/file-path';
import type {
  TurnFileEvidence,
  TurnFileRecord,
} from '@canopy/protocol/turn-files';

/** Minimal merged-tool shape shared by transcript and host projections. */
export interface TurnFileBlock {
  type: string;
  toolUseId?: string;
  toolName?: string;
  input?: string;
  result?: { output: string; isError: boolean };
  subBlocks?: readonly TurnFileBlock[];
}

export interface TurnFileMessage {
  id?: string;
  role: string;
  blocks: readonly TurnFileBlock[];
}

export interface TurnFileCollectionOptions {
  /** Hosts supply their registry's exact presentation-tool identities. */
  presentationTool?: (name: string) => 'files' | 'advisor' | undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function turnFileTarget(value: unknown): TurnFileRecord['target'] {
  if (
    record(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.projectId) &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.worktreeId)
  )
    return { projectId: value.projectId, worktreeId: value.worktreeId };
  return undefined;
}

interface Contribution extends Omit<TurnFileRecord, 'movedFrom'> {
  origin?: string;
  kind: 'saved' | 'updated' | 'presented' | 'deleted';
  requestedPath?: string;
  movedFrom?: string;
}

const defaultOptions: TurnFileCollectionOptions = {};
const blockCaches = new WeakMap<
  TurnFileCollectionOptions,
  WeakMap<TurnFileBlock, readonly Contribution[]>
>();

function filesFromBlock(
  block: TurnFileBlock,
  options: TurnFileCollectionOptions,
): readonly Contribution[] {
  let cache = blockCaches.get(options);
  if (!cache) {
    cache = new WeakMap();
    blockCaches.set(options, cache);
  }
  const cached = cache.get(block);
  if (cached) return cached;
  const files = parseBlockFiles(block, options);
  cache.set(block, files);
  return files;
}

function parseBlockFiles(
  block: TurnFileBlock,
  options: TurnFileCollectionOptions,
): readonly Contribution[] {
  if (block.subBlocks)
    return block.subBlocks.flatMap((child) => filesFromBlock(child, options));
  if (block.type !== 'tool_use' || !block.toolName || block.input === undefined)
    return [];
  const files: Contribution[] = [];
  const state = !block.result
    ? 'creating'
    : block.result.isError
      ? 'failed'
      : 'ready';
  const add = (
    value: unknown,
    kind: Contribution['kind'],
    extra: Pick<Contribution, 'requestedPath' | 'movedFrom' | 'target'> = {},
  ): void => {
    const path = turnFilePath(value);
    if (path)
      files.push({
        path,
        state,
        kind,
        ...(block.toolUseId ? { origin: block.toolUseId } : {}),
        ...(kind === 'updated' ? { change: 'updated' } : {}),
        ...extra,
      });
  };
  if (['Write', 'Edit', 'MultiEdit'].includes(block.toolName)) {
    const input = parse(block.input);
    if (record(input))
      add(
        input.file_path ?? input.path,
        block.toolName === 'Write' ? 'saved' : 'updated',
      );
  } else if (block.toolName === 'file_change') {
    for (const line of block.input.split('\n')) {
      const match = /^(add|update|delete): (.+)$/.exec(line);
      if (match)
        add(
          match[2],
          match[1] === 'add'
            ? 'saved'
            : match[1] === 'update'
              ? 'updated'
              : 'deleted',
        );
    }
  } else if (
    block.toolName === 'apply_patch' ||
    block.toolName === 'functions.apply_patch'
  ) {
    let current:
      | { path: string; kind: Contribution['kind']; movedFrom?: string }
      | undefined;
    let canMove = false;
    const flush = (): void => {
      if (current)
        add(
          current.path,
          current.kind,
          current.movedFrom ? { movedFrom: current.movedFrom } : {},
        );
      current = undefined;
      canMove = false;
    };
    for (const line of block.input.split('\n')) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
      if (header) {
        flush();
        current = {
          path: header[2],
          kind:
            header[1] === 'Add'
              ? 'saved'
              : header[1] === 'Update'
                ? 'updated'
                : 'deleted',
        };
        canMove = current.kind === 'updated';
      } else if (line === '*** End Patch' || line === '*** Begin Patch') {
        flush();
      } else {
        const move = /^\*\*\* Move to: (.+)$/.exec(line);
        if (move && canMove && current) {
          current = {
            ...current,
            path: move[1],
            movedFrom: turnFilePath(current.path),
          };
        }
        canMove = false;
      }
    }
    flush();
  } else if (block.result && !block.result.isError) {
    const presentation =
      options.presentationTool?.(block.toolName) ??
      (block.toolName === 'ShowFiles' ? 'files' : undefined);
    if (!presentation) return files;
    const output = parse(block.result.output);
    const input = parse(block.input);
    const target =
      presentation === 'advisor' && record(input)
        ? turnFileTarget(input.workspace)
        : undefined;
    if (record(output) && Array.isArray(output.files))
      for (const file of output.files)
        if (record(file) && file.ok === true) {
          const requestedPath = turnFilePath(file.path);
          add(file.absolutePath ?? file.path, 'presented', {
            ...(requestedPath ? { requestedPath } : {}),
            ...(target ? { target } : {}),
          });
        }
  }
  return files;
}

/**
 * The paths one call creates, updates or deletes, normalized as the collector
 * records them, so a host can tie a pending file back to the call writing it.
 */
export function turnFileWritePaths(block: TurnFileBlock): string[] {
  return filesFromBlock(block, defaultOptions)
    .filter((file) => file.kind !== 'presented')
    .map((file) => file.path);
}

function fileKey(path: string): string {
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

interface Evidence extends Omit<TurnFileRecord, 'saved'> {
  mutation: boolean;
  saved: boolean;
}

/** Successful mutations win over retries; presentation alone never completes an edit. */
function merge(previous: Evidence | undefined, next: Evidence): Evidence {
  if (!previous) return next;
  const successful = [previous, next].filter(
    (file) => file.mutation && file.state === 'ready',
  );
  const mutation = previous.mutation || next.mutation;
  const saved = previous.saved || next.saved;
  const state = successful.length
    ? 'ready'
    : next.mutation
      ? next.state
      : previous.mutation
        ? previous.state
        : next.state;
  const change = saved
    ? undefined
    : successful.length
      ? successful.find((file) => file.change)?.change
      : (next.change ?? previous.change);
  const target = next.target ?? previous.target;
  return {
    path: next.path,
    state,
    mutation,
    saved,
    ...(change ? { change } : {}),
    ...(target ? { target } : {}),
  };
}

/** No prose guessing, scans, existence claims or authorization changes. */
function collectTurnFileSnapshot(
  messages: readonly TurnFileMessage[],
  retained: readonly TurnFileRecord[] = [],
  options: TurnFileCollectionOptions = defaultOptions,
): TurnFileRecord[] {
  const files = new Map<string, Evidence>();
  const presentedPaths = new Map<string, string>();
  const windowsPresentedPaths = new Map<string, string>();
  for (const file of retained)
    files.set(
      fileKey(file.path),
      merge(files.get(fileKey(file.path)), {
        ...file,
        mutation: file.saved === true || file.change === 'updated',
        saved: file.saved === true && file.state === 'ready',
      }),
    );
  const resolve = (path: string): string =>
    presentedPaths.get(fileKey(path)) ??
    windowsPresentedPaths.get(path.toLowerCase()) ??
    path;
  for (const message of messages) {
    if (message.role === 'user') continue;
    for (const block of message.blocks)
      for (const file of filesFromBlock(block, options)) {
        let previous: Evidence | undefined;
        if (
          file.requestedPath &&
          fileKey(file.requestedPath) !== fileKey(file.path)
        ) {
          const key = fileKey(resolve(file.requestedPath));
          previous = files.get(key);
          files.delete(key);
          if (/^(?:[a-z]:\/|\/\/)/i.test(file.path)) {
            // The receipt supplies the host's case policy for relative identities.
            files.forEach((value, candidate) => {
              if (candidate.toLowerCase() === key.toLowerCase()) {
                previous = merge(previous, value);
                files.delete(candidate);
              }
            });
            windowsPresentedPaths.set(
              file.requestedPath.toLowerCase(),
              file.path,
            );
          }
          presentedPaths.set(fileKey(file.requestedPath), file.path);
        }
        const path = resolve(file.path);
        const key = fileKey(path);
        previous = merge(
          previous,
          files.get(key) ?? {
            path,
            state: file.state,
            mutation: false,
            saved: false,
          },
        );
        if (file.kind === 'deleted') {
          if (file.state === 'ready') files.delete(key);
          continue;
        }
        if (file.movedFrom && file.state === 'ready') {
          const source = fileKey(resolve(file.movedFrom));
          const moved = files.get(source);
          if (moved) previous = merge(previous, { ...moved, path });
          if (source !== key) files.delete(source);
        }
        files.set(
          key,
          merge(previous, {
            path,
            state: file.state,
            mutation: file.kind !== 'presented',
            saved: file.kind === 'saved' && file.state === 'ready',
            ...(file.change ? { change: file.change } : {}),
            ...(file.target ? { target: file.target } : {}),
          }),
        );
      }
  }
  return Array.from(
    files.values(),
    (file): TurnFileRecord => ({
      path: file.path,
      state: file.state,
      ...(file.saved ? { saved: true } : {}),
      ...(file.change ? { change: file.change } : {}),
      ...(file.target ? { target: file.target } : {}),
    }),
  );
}

/** Preserve ordered operations until the host can resolve canonical aliases. */
export function collectTurnFiles(
  messages: readonly TurnFileMessage[],
  retained: readonly TurnFileRecord[] = [],
  options: TurnFileCollectionOptions = defaultOptions,
): TurnFileRecord[] {
  const history = new Map<string, TurnFileEvidence>();
  const existing = retained.find((file) => file.evidence)?.evidence;
  if (existing) for (const file of existing) history.set(file.key, file);
  else
    for (const file of retained) {
      const { evidence, ...record } = file;
      void evidence;
      const key = JSON.stringify(['retained', file.target, file.path]);
      history.set(key, { ...record, key });
    }
  let messageIndex = 0;
  for (const message of messages) {
    const messageOrdinal = messageIndex++;
    if (message.role === 'user') continue;
    let blockIndex = 0;
    for (const block of message.blocks) {
      const blockOrdinal = blockIndex++;
      let contributionIndex = 0;
      for (const file of filesFromBlock(block, options)) {
        const contributionOrdinal = contributionIndex++;
        if (file.kind === 'deleted' && file.state !== 'ready') continue;
        const origin = file.origin ?? block.toolUseId;
        const key = JSON.stringify([
          message.id ?? messageOrdinal,
          origin ?? blockOrdinal,
          contributionOrdinal,
        ]);
        const previous = history.get(key);
        if (
          (previous?.state === 'ready' && file.state !== 'ready') ||
          (previous?.state === 'failed' && file.state === 'creating')
        )
          continue;
        history.set(key, {
          key,
          path: file.path,
          state: file.state,
          ...(file.kind === 'saved' && file.state === 'ready'
            ? { saved: true }
            : {}),
          ...(file.change ? { change: file.change } : {}),
          ...(file.requestedPath ? { requestedPath: file.requestedPath } : {}),
          ...(file.kind === 'deleted' ? { removed: true } : {}),
          ...(file.movedFrom && file.state === 'ready'
            ? { movedFrom: [file.movedFrom] }
            : {}),
          ...(file.target ? { target: file.target } : {}),
        });
      }
    }
  }
  const evidence = Array.from(history.values());
  const files = collectTurnFileSnapshot(messages, retained, options);
  const first = files[0];
  if (first) files[0] = { ...first, evidence };
  else {
    const removed = evidence.find((file) => file.removed);
    if (removed)
      files.push({
        path: removed.path,
        state: 'failed',
        removed: true,
        evidence,
      });
  }
  return files;
}
