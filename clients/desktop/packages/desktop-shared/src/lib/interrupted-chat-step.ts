import type { PersistedChatMessage, UsageLimitedChatItem } from '../types';

interface ProjectedPath {
  anchor: string;
  parts: string[];
  windows: boolean;
  escaped: boolean;
}

/** Lexical projection only: no filesystem access or host-specific path API. */
function parsePath(value: string): ProjectedPath {
  const path = value.trim().replace(/\\/g, '/');
  const drive = /^[a-z]:\//i.exec(path)?.[0];
  const windows = Boolean(drive) || path.startsWith('//');
  const anchor = drive?.toLowerCase() ?? (path.startsWith('/') ? '/' : '');
  const parts: string[] = [];
  let escaped = false;
  for (const part of path.slice(drive?.length ?? 0).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      else escaped = true;
    } else parts.push(part);
  }
  return { anchor, parts, windows, escaped };
}

function projectPath(value: string, worktreePath?: string): string | undefined {
  // A recognized field can still hold a URL, drive-relative path or other URI.
  if (
    /^[a-z][a-z\d+.-]*:/i.test(value.trim()) &&
    !/^[a-z]:[/\\]/i.test(value.trim())
  )
    return undefined;
  const path = parsePath(value);
  // Reject URI fragments and drive prefixes disguised by relative segments.
  // The legitimate Windows drive has already been removed into the anchor.
  if (!path.parts.length || path.parts.some((part) => part.includes(':')))
    return undefined;
  let parts = path.parts;
  if (path.anchor) {
    const root = worktreePath ? parsePath(worktreePath) : undefined;
    const same = (a: string, b: string): boolean =>
      path.windows ? a.toLowerCase() === b.toLowerCase() : a === b;
    const contained =
      root?.anchor === path.anchor &&
      root.windows === path.windows &&
      root.parts.every((part, index) => same(part, path.parts[index] ?? ''));
    parts =
      contained && root
        ? path.parts.slice(root.parts.length)
        : path.parts.slice(-1);
  } else if (path.escaped || value.trim().startsWith('~')) {
    parts = path.parts.slice(-1);
  }
  const detail = parts.join('/').replace(/\s+/g, ' ').trim();
  if (!detail) return undefined;
  return detail.length > 80 ? `${detail.slice(0, 79)}…` : detail;
}

function fileDetail(input: unknown, worktreePath?: string): string | undefined {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const field: unknown = Reflect.get(value, key);
    if (typeof field === 'string' && field.trim())
      return projectPath(field, worktreePath);
  }
  return undefined;
}

/**
 * One current-turn scan for the selected ID, not one scan per invocation.
 * Absence (including synthetic settlement) cannot prove unfinished execution.
 */
function hasSuccessfulResult(
  messages: readonly PersistedChatMessage[],
  promptIndex: number,
  invocationIndex: number,
  invocationBlockIndex: number,
  toolUseId: string,
): boolean {
  if (typeof toolUseId !== 'string' || !toolUseId.trim()) return false;
  let invocations = 0;
  let result:
    | Extract<PersistedChatMessage['blocks'][number], { type: 'tool_result' }>
    | undefined;
  let resultSignature: string | undefined;
  for (let index = promptIndex + 1; index < messages.length; index += 1) {
    const blocks = messages[index].blocks;
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (block.type === 'tool_use' && block.toolUseId === toolUseId) {
        invocations += 1;
        if (invocations > 1) return false;
      }
      if (
        block.type !== 'tool_result' ||
        block.toolUseId !== toolUseId ||
        index < invocationIndex ||
        (index === invocationIndex && blockIndex <= invocationBlockIndex)
      )
        continue;
      if (block.isError !== false) return false;
      if (result) {
        // Only identical duplicates are safe. Serialize lazily so the usual
        // single-result path never copies potentially large tool output.
        resultSignature ??= JSON.stringify(result);
        if (JSON.stringify(block) !== resultSignature) return false;
      } else result = block;
    }
  }
  return invocations === 1 && result !== undefined;
}

/** Last persisted tool invocation after the latest prompt; results are not prompts. */
export function describeLastAgentStep(
  messages: readonly PersistedChatMessage[],
  worktreePath?: string,
): UsageLimitedChatItem['lastStep'] {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'user' &&
      (message.blocks.length === 0 ||
        !message.blocks.every((block) => block.type === 'tool_result'))
    ) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return undefined;
  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const blocks = messages[index].blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block.type !== 'tool_use') continue;
      const toolName = (block.display?.toolName.trim() || block.toolName)
        .replace(/\s+/g, ' ')
        .trim();
      if (!toolName) return undefined;
      const detail = fileDetail(
        block.display?.input ?? block.input,
        worktreePath,
      );
      const finished = hasSuccessfulResult(
        messages,
        promptIndex,
        index,
        blockIndex,
        block.toolUseId,
      );
      return {
        toolName,
        ...(detail ? { detail } : {}),
        ...(finished ? { finished: true } : {}),
      };
    }
  }
  return undefined;
}
