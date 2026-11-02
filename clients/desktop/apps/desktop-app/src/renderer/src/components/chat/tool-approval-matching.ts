import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import {
  collectTurnFiles,
  turnFilePath,
  turnFileWritePaths,
} from '@canopy/desktop-shared/lib/turn-files';
import {
  expandTurnFileRecords,
  type TurnFileEvidence,
  type TurnFileRecord,
} from '@canopy/protocol/turn-files';
import {
  NO_TOOL_APPROVAL_WAIT,
  parseMcpToolName,
  unwrapShellWrappedCommand,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import type { DisplayBlock, DisplayMessage } from './types';

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

/** An unresolved call of the turn and the agent scope it ran in. */
interface Candidate {
  readonly block: ToolUseBlock;
  /** `null` for the root agent; a subagent's known thread ids otherwise. */
  readonly scope: null | { readonly threadIds?: readonly string[] };
}

const SHELL_TOOLS = new Set([
  'Bash',
  'shell',
  'local_shell',
  'exec_command',
  'command_execution',
]);
const FILE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'file_change',
  'apply_patch',
  'functions.apply_patch',
]);

function collectCandidates(messages: readonly DisplayMessage[]): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (
    blocks: readonly DisplayBlock[],
    scope: Candidate['scope'],
  ): void => {
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (block.result === undefined) candidates.push({ block, scope });
      } else if (block.type === 'codex_agent') {
        visit(block.subBlocks, { threadIds: block.receiverThreadIds });
      } else if ('subBlocks' in block && Array.isArray(block.subBlocks)) {
        // Claude and delegated agents carry no id an approval names.
        visit(block.subBlocks, {});
      }
    }
  };
  for (const message of messages) {
    if (message.role === 'assistant') visit(message.blocks, null);
  }
  return candidates;
}

function parseInput(input: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCommand(command: string): string {
  return unwrapShellWrappedCommand(command.trim()).trim();
}

function callCommand(block: ToolUseBlock): string | undefined {
  const input = parseInput(block.input);
  if (input) {
    return typeof input.command === 'string'
      ? normalizeCommand(input.command)
      : undefined;
  }
  return block.toolName === 'Bash' ? undefined : normalizeCommand(block.input);
}

/** Windows drive and UNC paths compare without case, like the collector. */
function pathKey(path: string): string {
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

function normalizedPathKey(value: string | undefined): string | undefined {
  const path = turnFilePath(value);
  return path === undefined ? undefined : pathKey(path);
}

function callPathKeys(block: ToolUseBlock): string[] {
  return turnFileWritePaths(block).map(pathKey);
}

/** A relative display path matches only whole trailing segments. */
function pathMatches(
  callPath: string,
  absolute: string | undefined,
  display: string | undefined,
): boolean {
  if (absolute !== undefined) return callPath === absolute;
  // A shortened display path must carry directory identity. A basename
  // alone cannot establish that it belongs to this workspace's file.
  const suffix = /^(?:[a-z]:\/|\/\/)/i.test(callPath)
    ? display?.toLowerCase()
    : display;
  return (
    suffix !== undefined &&
    suffix.includes('/') &&
    (callPath === suffix || callPath.endsWith(`/${suffix}`))
  );
}

/**
 * The calls a request could be, split into those its details pin down
 * (`exact`) and those merely of the right kind (`compatible`). `comparable`
 * is false when the request carries nothing to compare.
 */
function classify(
  details: ApprovalRequestEvent['details'],
  candidates: readonly Candidate[],
): { exact: Candidate[]; compatible: Candidate[]; comparable: boolean } {
  switch (details.kind) {
    case 'command': {
      const compatible = candidates.filter(({ block }) =>
        SHELL_TOOLS.has(block.toolName),
      );
      const command = normalizeCommand(details.command);
      return {
        compatible,
        exact: compatible.filter(
          ({ block }) => command !== '' && callCommand(block) === command,
        ),
        comparable: command !== '',
      };
    }
    case 'file-write': {
      const compatible = candidates.filter(({ block }) =>
        FILE_TOOLS.has(block.toolName),
      );
      const absolute = normalizedPathKey(details.path);
      const display = normalizedPathKey(details.displayPath);
      return {
        compatible,
        exact: compatible.filter(({ block }) =>
          callPathKeys(block).some((path) =>
            pathMatches(path, absolute, display),
          ),
        ),
        comparable: absolute !== undefined || display !== undefined,
      };
    }
    case 'mcp': {
      const exact = candidates.filter(({ block }) => {
        const parsed = parseMcpToolName(block.toolName);
        return (
          block.toolName === `mcp__${details.server}__${details.tool}` ||
          (parsed !== null &&
            parsed.server === details.server &&
            parsed.tool === details.tool)
        );
      });
      return { compatible: exact, exact, comparable: true };
    }
    case 'tool': {
      const exact = candidates.filter(
        ({ block }) => block.toolName === details.toolName,
      );
      return { compatible: exact, exact, comparable: true };
    }
    default:
      // Network and browser prompts belong to no transcript call.
      return { compatible: [], exact: [], comparable: true };
  }
}

function inScope(
  candidate: Candidate,
  subagentId: string | undefined,
): boolean {
  if (subagentId === undefined) return candidate.scope === null;
  if (candidate.scope === null) return false;
  const { threadIds } = candidate.scope;
  return threadIds?.includes(subagentId) === true;
}

/**
 * The tool-use ids of a turn's unresolved calls that pending approvals hold.
 * An explicit `toolUseId` matches only that call. A request without one
 * matches by its command, file, MCP or tool details within its agent scope,
 * and only when exactly one call fits; a request with nothing to compare
 * falls back to the scope's only call of its kind. Anything ambiguous is
 * left as it is rather than guessed.
 */
export function matchWaitingToolUseIds(
  approvals: readonly ApprovalRequestEvent[],
  messages: readonly DisplayMessage[],
): ReadonlySet<string> {
  const waiting = new Set<string>();
  if (approvals.length === 0) return waiting;
  const unresolved = collectCandidates(messages);
  const seen = new Set<string>();
  const reused = new Set<string>();
  for (const { block } of unresolved) {
    if (seen.has(block.toolUseId)) reused.add(block.toolUseId);
    seen.add(block.toolUseId);
  }
  // Rows currently carry tool-use identity but no independent agent scope.
  // A reused id cannot safely identify which row waits, even if request
  // details identify one scoped candidate, so leave those rows unchanged.
  const candidates = unresolved.filter(
    ({ block }) => !reused.has(block.toolUseId),
  );
  if (candidates.length === 0) return waiting;
  for (const approval of approvals) {
    if (approval.toolUseId !== undefined) {
      if (
        candidates.some(
          (candidate) =>
            candidate.block.toolUseId === approval.toolUseId &&
            inScope(candidate, approval.subagentId),
        )
      )
        waiting.add(approval.toolUseId);
      continue;
    }
    const { exact, compatible, comparable } = classify(
      approval.details,
      candidates.filter((candidate) => inScope(candidate, approval.subagentId)),
    );
    const match =
      exact.length === 1
        ? exact[0]
        : !comparable && compatible.length === 1
          ? compatible[0]
          : undefined;
    if (match) waiting.add(match.block.toolUseId);
  }
  return waiting;
}

/**
 * A turn's approval signal for its rows, live line and file chips: the
 * matched calls, and the files those calls are writing.
 */
export function desktopTurnApprovalWait(
  approvals: readonly ApprovalRequestEvent[],
  messages: readonly DisplayMessage[],
  files?: readonly TurnFileRecord[],
  pendingPathAliases: readonly (readonly [
    sourcePath: string,
    pendingPath: string,
  ])[] = [],
): ToolApprovalWait {
  const ids = matchWaitingToolUseIds(approvals, messages);
  if (ids.size === 0) return NO_TOOL_APPROVAL_WAIT;
  const pending: TurnFileEvidence[] = collectCandidates(messages)
    .filter(({ block }) => ids.has(block.toolUseId))
    .flatMap(({ block }) => turnFileWritePaths(block))
    .map((path, index) => ({
      key: `approval-wait-${index}`,
      path,
      state: 'creating',
    }));
  const first = pending[0];
  const evidence = first
    ? ((files ?? collectTurnFiles(messages))[0]?.evidence ?? [])
    : [];
  // Use the summary's receipt aliases, including its ambiguity and workspace
  // fences. These extra contributions are presentation-only and never stored.
  const paths = new Set(
    first
      ? expandTurnFileRecords([
          { ...first, evidence: [...evidence, ...pending] },
        ])
          .slice(evidence.length)
          .map((file) => pathKey(file.path))
      : [],
  );
  const canonicalPaths = new Set(paths);
  for (const [sourcePath, pendingPath] of pendingPathAliases) {
    if (paths.has(pathKey(sourcePath)))
      canonicalPaths.add(pathKey(pendingPath));
  }
  return {
    isCallWaiting: (call) =>
      call.toolUseId !== undefined && ids.has(call.toolUseId),
    isFileWaiting: (path): boolean => {
      const key = normalizedPathKey(path);
      return key !== undefined && canonicalPaths.has(key);
    },
  };
}
