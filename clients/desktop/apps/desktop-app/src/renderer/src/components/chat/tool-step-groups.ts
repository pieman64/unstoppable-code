/**
 * Early access: compact tool calls. Back-to-back assistant messages that only
 * call tools (and think) fold into one transcript row that reads like
 * "Searched 3 times, read 4 files". Anything the user may need to see or act
 * on keeps its own row: agent text, questions, plans, skills, sub-agents and
 * failed calls (which can carry a sign-in recovery card).
 *
 * The live step window (CAN-4274, its own opt-in setting) builds on the same
 * runs: thinking counts as a step, one step is enough to fold, and the run a
 * turn is still adding to shows only its newest steps under the summary row.
 */
import {
  describeStepCounts,
  describeStepKinds,
  getToolFamilyFromName,
  type PortalChatToolFamily,
  type StepKind,
  type ToolDisplayScope,
} from '@canopy/ui-shared/components';
import type { TurnSummaryCounts } from '@canopy/desktop-shared/lib/turn-utils';
import {
  isAskUserQuestionToolName,
  SHOW_VISUAL_TOOL_ALIASES,
} from '@/lib/canopy-tool-aliases';
import type { DisplayBlock, DisplayMessage } from './types';

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;
type ThinkingBlock = Extract<DisplayBlock, { type: 'thinking' }>;
/** One agent step: a tool call, or (in the live step window) a thought. */
export type ToolStepBlock = ToolUseBlock | ThinkingBlock;

/** Tools that render as something other than a plain tool row. */
const STANDALONE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ExitPlanMode',
  'EnterPlanMode',
  'Skill',
]);

/** A run needs at least this many tool calls to fold; one call shows as is. */
const MIN_FOLDED_TOOL_CALLS = 2;

function isFoldableToolUse(block: ToolUseBlock): boolean {
  if (STANDALONE_TOOL_NAMES.has(block.toolName)) return false;
  if (isAskUserQuestionToolName(block.toolName)) return false;
  if (
    block.result?.visualRef ||
    SHOW_VISUAL_TOOL_ALIASES.includes(block.toolName)
  ) {
    return false;
  }
  return block.result?.isError !== true;
}

/** Whether a block is a tool call or thinking that may fold. */
function isFoldableStepBlock(block: DisplayBlock): boolean {
  if (block.isSystemMessage === true) return false;
  if (block.type === 'thinking') return true;
  return block.type === 'tool_use' && isFoldableToolUse(block);
}

/** Whether a message holds only tool calls and thinking that may fold. */
export function isFoldableToolMessage(message: DisplayMessage): boolean {
  if (message.role !== 'assistant' || message.blocks.length === 0) {
    return false;
  }
  return message.blocks.every(isFoldableStepBlock);
}

/**
 * Where a transcript row came from. The live step window can show one
 * message as several rows; each keeps the message's id (search, memory and
 * block origins use it) and gets its own render key.
 */
export interface StepPiece {
  /** The transcript message the row's blocks belong to. */
  source: DisplayMessage;
  /** Unique among a turn's rows, and stable while the message grows. */
  key: string;
  /** False when later blocks of `source` show in another row. */
  endsSource: boolean;
  /**
   * Where the row's first block sits in `source`. Block keys add it, so a
   * thought or text block keeps its row as the window slides past others.
   */
  blockOffset: number;
}

const stepPieces = new WeakMap<DisplayMessage, StepPiece>();

/** The row's source; a message that was not split is its own. */
export function stepPieceOf(message: DisplayMessage): StepPiece {
  return (
    stepPieces.get(message) ?? {
      source: message,
      key: message.id,
      endsSource: true,
      blockOffset: 0,
    }
  );
}

const splitMessages = new WeakMap<DisplayMessage, DisplayMessage[]>();

/**
 * One assistant message can hold text between its steps (a Claude event's
 * content array, an OpenCode patch stream). The live step window splits it at
 * block boundaries into runs of foldable steps and runs of everything else,
 * so text keeps its own row in order and the steps around it can fold. The
 * blocks themselves are shared, so results and running state are untouched.
 */
function splitAtSteps(message: DisplayMessage): DisplayMessage[] {
  if (message.role !== 'assistant') return [message];
  const cached = splitMessages.get(message);
  if (cached) return cached;
  const starts: number[] = [];
  message.blocks.forEach((block, index) => {
    if (
      index === 0 ||
      isFoldableStepBlock(block) !==
        isFoldableStepBlock(message.blocks[index - 1])
    ) {
      starts.push(index);
    }
  });
  if (starts.length < 2) return [message];
  const pieces = starts.map((start, index) => {
    const end = starts[index + 1] ?? message.blocks.length;
    const piece = { ...message, blocks: message.blocks.slice(start, end) };
    stepPieces.set(piece, {
      source: message,
      key: start === 0 ? message.id : `${message.id}#${String(start)}`,
      endsSource: end === message.blocks.length,
      blockOffset: start,
    });
    return piece;
  });
  splitMessages.set(message, pieces);
  return pieces;
}

function toolUsesOf(messages: readonly DisplayMessage[]): ToolUseBlock[] {
  return messages.flatMap((message) =>
    message.blocks.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    ),
  );
}

/** Steps the live step window shows while a turn is still running. */
export const LIVE_STEP_WINDOW_SIZE = 3;

export interface SegmentToolStepsOptions {
  /** Live step window: thinking counts as a step and one step folds. */
  liveStepWindow?: boolean;
}

/** Thinking counts as a step once it has text; an empty shell does not. */
function isThinkingStep(block: DisplayBlock): block is ThinkingBlock {
  return block.type === 'thinking' && block.text.trim().length > 0;
}

function stepsOf(messages: readonly DisplayMessage[]): ToolStepBlock[] {
  return messages.flatMap((message) =>
    message.blocks.filter(
      (block): block is ToolStepBlock =>
        block.type === 'tool_use' || isThinkingStep(block),
    ),
  );
}

export type ToolStepSegment =
  | { kind: 'message'; message: DisplayMessage }
  | {
      kind: 'steps';
      /** Stable while the run grows: the render key of its first row. */
      key: string;
      messages: DisplayMessage[];
      toolUses: ToolUseBlock[];
      /**
       * What the summary counts. Without the live step window this is
       * `toolUses` itself; with it, thinking is included in order.
       */
      steps: ToolStepBlock[];
    };

/**
 * Splits a turn's visible messages into single messages and folded runs of
 * tool calls. Order is preserved; a run with fewer than two tool calls is
 * returned as its individual messages. With `liveStepWindow`, any run with at
 * least one step (a tool call or a thought) folds, and a message with text
 * between its steps is first split around that text (see `stepPieceOf`).
 */
export function segmentToolSteps(
  messages: readonly DisplayMessage[],
  options?: SegmentToolStepsOptions,
): ToolStepSegment[] {
  const liveWindow = options?.liveStepWindow === true;
  const segments: ToolStepSegment[] = [];
  let run: DisplayMessage[] = [];
  const flush = (): void => {
    const toolUses = toolUsesOf(run);
    const steps = liveWindow ? stepsOf(run) : toolUses;
    const first = run[0];
    const folds = liveWindow
      ? steps.length > 0
      : toolUses.length >= MIN_FOLDED_TOOL_CALLS;
    if (first && folds) {
      segments.push({
        kind: 'steps',
        key: stepPieceOf(first).key,
        messages: run,
        toolUses,
        steps,
      });
    } else {
      for (const message of run) segments.push({ kind: 'message', message });
    }
    run = [];
  };
  for (const message of liveWindow
    ? messages.flatMap(splitAtSteps)
    : messages) {
    if (isFoldableToolMessage(message)) {
      run.push(message);
      continue;
    }
    flush();
    segments.push({ kind: 'message', message });
  }
  flush();
  return segments;
}

/** A message trimmed to its tail, cached so unchanged rows keep their identity. */
const trimmedMessages = new WeakMap<
  DisplayMessage,
  { from: number; message: DisplayMessage }
>();

function trimmedFrom(message: DisplayMessage, from: number): DisplayMessage {
  if (from === 0) return message;
  const cached = trimmedMessages.get(message);
  if (cached?.from === from) return cached.message;
  const trimmed = { ...message, blocks: message.blocks.slice(from) };
  const piece = stepPieceOf(message);
  stepPieces.set(trimmed, {
    ...piece,
    blockOffset: piece.blockOffset + from,
  });
  trimmedMessages.set(message, { from, message: trimmed });
  return trimmed;
}

/**
 * The newest `size` steps of a run, as the messages that hold them. A message
 * that straddles the cut keeps only its blocks from the oldest shown step on,
 * under its own id. Messages before the cut, and empty thinking shells
 * anywhere, are left out. Walks back from the end, so the cost is the window,
 * not the run.
 */
export function liveStepWindow(
  messages: readonly DisplayMessage[],
  size: number = LIVE_STEP_WINDOW_SIZE,
): DisplayMessage[] {
  let remaining = size;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (let block = message.blocks.length - 1; block >= 0; block -= 1) {
      const candidate = message.blocks[block];
      if (candidate.type !== 'tool_use' && !isThinkingStep(candidate)) {
        continue;
      }
      remaining -= 1;
      if (remaining === 0) {
        return [
          trimmedFrom(message, block),
          ...messages.slice(index + 1).filter(hasStep),
        ];
      }
    }
  }
  return messages.filter(hasStep);
}

/** False for a message that is only an empty thinking shell so far. */
function hasStep(message: DisplayMessage): boolean {
  return message.blocks.some(
    (block) => block.type === 'tool_use' || isThinkingStep(block),
  );
}

function stepKindOf(family: PortalChatToolFamily): StepKind {
  switch (family) {
    case 'grep':
    case 'glob':
      return 'search';
    case 'read':
      return 'read';
    case 'edit':
    case 'write':
      return 'edit';
    case 'bash':
    case 'script-output':
      return 'command';
    case 'graph':
      return 'graph';
    case 'web':
      return 'web';
    case 'todo':
      return 'tasks';
    default:
      return 'other';
  }
}

/**
 * Plain-words summary of a run, kinds in the order they first appear:
 * "Searched 3 times, read 4 files, checked the code graph". Thinking, which
 * only the live step window counts, reads "Thought 2 times".
 */
export function summarizeSteps(
  steps: readonly ToolStepBlock[],
  scope?: ToolDisplayScope,
): string {
  return describeStepCounts(
    steps.map((block) => [stepKindOfBlock(block, scope), 1] as const),
  );
}

/**
 * The clean chat look's words for a run, without counting it: "Ran commands,
 * read files, searched the code".
 */
export function describeSteps(
  steps: readonly ToolStepBlock[],
  scope?: ToolDisplayScope,
): string {
  return describeStepKinds(
    steps.map((block) => [stepKindOfBlock(block, scope), 1] as const),
  );
}

function stepKindOfBlock(
  block: ToolStepBlock,
  scope?: ToolDisplayScope,
): StepKind {
  return block.type === 'thinking'
    ? 'thinking'
    : stepKindOf(getToolFamilyFromName(block.toolName, scope, block.input));
}

/** The kind of a run's first step, which its row leads with. */
export function firstStepKind(
  steps: readonly ToolStepBlock[],
  scope?: ToolDisplayScope,
): StepKind | undefined {
  const first = steps[0];
  return first ? stepKindOfBlock(first, scope) : undefined;
}

/** Each counted step of a finished turn and the kind it reads as. */
export const TURN_COUNT_KINDS: Record<
  Exclude<keyof TurnSummaryCounts, 'messages'>,
  StepKind
> = {
  thinking: 'thinking',
  bash: 'command',
  read: 'read',
  readLines: 'read',
  writeEdit: 'edit',
  plan: 'other',
  fileEdit: 'edit',
  fileAdd: 'edit',
  fileDelete: 'edit',
  search: 'search',
  grep: 'search',
  web: 'web',
  agent: 'other',
  workflow: 'other',
  tasks: 'tasks',
  taskStop: 'other',
  skills: 'other',
  monitor: 'other',
  claude: 'other',
  scheduleWakeup: 'other',
  askUser: 'other',
  scriptOutput: 'command',
  watcher: 'other',
  canopy: 'other',
  graph: 'graph',
  appAdvisor: 'other',
  pipelineEditor: 'other',
  computerUse: 'other',
  mcp: 'other',
  other: 'other',
};

/** The summary chips' order; a test keeps it covering every counted key. */
export const TURN_COUNT_ORDER: readonly Exclude<
  keyof TurnSummaryCounts,
  'messages'
>[] = [
  'thinking',
  'bash',
  'read',
  'readLines',
  'writeEdit',
  'plan',
  'fileEdit',
  'fileAdd',
  'fileDelete',
  'search',
  'grep',
  'web',
  'agent',
  'workflow',
  'tasks',
  'taskStop',
  'skills',
  'monitor',
  'claude',
  'scheduleWakeup',
  'askUser',
  'scriptOutput',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'computerUse',
  'mcp',
  'other',
];

/**
 * A finished turn's steps by kind, in the order its summary chips list them,
 * for the clean chat look's plain-words row. Messages are not steps.
 */
export function turnStepCounts(
  counts: TurnSummaryCounts,
): [StepKind, number][] {
  const result: [StepKind, number][] = [];
  for (const key of TURN_COUNT_ORDER) {
    if (counts[key] > 0) result.push([TURN_COUNT_KINDS[key], counts[key]]);
  }
  return result;
}

/** Summary of a run's tool calls; see `summarizeSteps`. */
export function summarizeToolSteps(
  toolUses: readonly ToolUseBlock[],
  scope?: ToolDisplayScope,
): string {
  return summarizeSteps(toolUses, scope);
}

/** The call still running at the end of a run, if any. */
export function runningToolUse(
  toolUses: readonly ToolUseBlock[],
): ToolUseBlock | undefined {
  const last = toolUses[toolUses.length - 1];
  return last && last.result === undefined ? last : undefined;
}
