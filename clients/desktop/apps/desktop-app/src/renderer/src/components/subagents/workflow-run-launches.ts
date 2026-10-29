/**
 * Claude Code `Workflow` launches read from a root chat's loaded messages.
 *
 * A launch is the `Workflow` tool call plus its launch receipt (the
 * tool_result). The receipt names the run id, the provider task id and the
 * run's transcript directory. Transcript directories are host paths: they
 * stay in this desktop-only projection and never enter the subagent tree.
 */
import {
  extractWorkflowNameFromScript,
  isWorkflowLaunchReceipt,
  parseWorkflowReceipt,
} from '@/components/chat/workflow-receipt';
import type { ChatMessage } from '@/stores/chatStore';

/** Fallback run name when the script has no readable `meta.name`. */
export const WORKFLOW_RUN_FALLBACK_NAME = 'Workflow';

/** One `Workflow` tool call and what its launch receipt reported. */
export interface WorkflowLaunch {
  readonly toolUseId: string;
  /** `meta.name` from the workflow script. */
  readonly name: string;
  /** Message timestamp of the tool call. */
  readonly launchedAt: number;
  readonly summary?: string;
  /** Run id (`wf_…`) from the receipt; absent until the receipt arrives. */
  readonly runId?: string;
  /** Provider background task id from the receipt. */
  readonly taskId?: string;
  /** Absolute run transcript directory from the receipt. */
  readonly transcriptDir?: string;
}

/** Desktop-only file location of a launched run. Never put in the tree. */
export interface WorkflowRunLocation {
  readonly runId: string;
  readonly transcriptDir: string;
  readonly toolUseId: string;
  readonly name: string;
  readonly launchedAt: number;
  readonly taskId?: string;
}

const launchCache = new WeakMap<
  readonly ChatMessage[],
  readonly WorkflowLaunch[]
>();
const locationCache = new WeakMap<
  readonly ChatMessage[],
  readonly WorkflowRunLocation[]
>();

const EMPTY_LAUNCHES: readonly WorkflowLaunch[] = [];
const EMPTY_LOCATIONS: readonly WorkflowRunLocation[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scriptName(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) return WORKFLOW_RUN_FALLBACK_NAME;
    const script = parsed.script;
    if (typeof script !== 'string') return WORKFLOW_RUN_FALLBACK_NAME;
    return (
      extractWorkflowNameFromScript(script)?.trim() ||
      WORKFLOW_RUN_FALLBACK_NAME
    );
  } catch {
    return WORKFLOW_RUN_FALLBACK_NAME;
  }
}

/**
 * Every `Workflow` tool call in launch order, with its receipt when present.
 * Cached per messages array, so repeated calls on an unchanged transcript are
 * cheap and return the same array.
 */
export function collectWorkflowLaunches(
  messages: readonly ChatMessage[],
): readonly WorkflowLaunch[] {
  const cached = launchCache.get(messages);
  if (cached) return cached;

  const calls: { toolUseId: string; name: string; launchedAt: number }[] = [];
  const receipts = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.toolName === 'Workflow') {
        calls.push({
          toolUseId: block.toolUseId,
          name: scriptName(block.input),
          launchedAt: message.timestamp,
        });
      } else if (
        block.type === 'tool_result' &&
        isWorkflowLaunchReceipt(block.output)
      ) {
        receipts.set(block.toolUseId, block.output);
      }
    }
  }

  if (calls.length === 0) {
    launchCache.set(messages, EMPTY_LAUNCHES);
    return EMPTY_LAUNCHES;
  }

  const launches = calls.map((call): WorkflowLaunch => {
    const output = receipts.get(call.toolUseId);
    const receipt = output === undefined ? null : parseWorkflowReceipt(output);
    return {
      toolUseId: call.toolUseId,
      name: call.name,
      launchedAt: call.launchedAt,
      ...(receipt?.summary ? { summary: receipt.summary } : {}),
      ...(receipt?.runId ? { runId: receipt.runId } : {}),
      ...(receipt?.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt?.transcriptDir
        ? { transcriptDir: receipt.transcriptDir }
        : {}),
    };
  });
  launchCache.set(messages, launches);
  return launches;
}

/**
 * Launches whose receipt named both a run id and a transcript directory, in
 * launch order. The first launch wins when a run id repeats.
 */
export function collectWorkflowRunLocations(
  messages: readonly ChatMessage[],
): readonly WorkflowRunLocation[] {
  const cached = locationCache.get(messages);
  if (cached) return cached;
  const seen = new Set<string>();
  const locations: WorkflowRunLocation[] = [];
  for (const launch of collectWorkflowLaunches(messages)) {
    if (!launch.runId || !launch.transcriptDir || seen.has(launch.runId)) {
      continue;
    }
    seen.add(launch.runId);
    locations.push({
      runId: launch.runId,
      transcriptDir: launch.transcriptDir,
      toolUseId: launch.toolUseId,
      name: launch.name,
      launchedAt: launch.launchedAt,
      ...(launch.taskId ? { taskId: launch.taskId } : {}),
    });
  }
  const result = locations.length === 0 ? EMPTY_LOCATIONS : locations;
  locationCache.set(messages, result);
  return result;
}

/** The location of one launched run in a root chat, if its receipt is loaded. */
export function findWorkflowRunLocation(
  messages: readonly ChatMessage[],
  runId: string,
): WorkflowRunLocation | undefined {
  return collectWorkflowRunLocations(messages).find(
    (location) => location.runId === runId,
  );
}

/** Whether a root chat has launched at least one Claude Code workflow. */
export function hasWorkflowLaunches(messages: readonly ChatMessage[]): boolean {
  return collectWorkflowLaunches(messages).length > 0;
}
