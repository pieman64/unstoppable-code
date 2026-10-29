import { realpathSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type {
  ActivityReadWorkflowAgentTranscriptResponse,
  WorkflowAgentProgress,
  WorkflowPhaseInfo,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';

const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_AGENT_TRANSCRIPT_LINES = 20_000;
const MAX_AGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const AGENT_TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const INITIAL_PROMPT_PREFIX_BYTES = 64 * 1024;

/**
 * Resolve symlinks in the longest existing prefix of `filePath`. A live run's
 * state file does not exist yet, but its parent directories (for example
 * macOS `/var` -> `/private/var`) still need resolving to compare with roots.
 */
function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    const parent = dirname(filePath);
    if (parent === filePath) return filePath;
    return join(safeRealpath(parent), basename(filePath));
  }
}

/** Validate workflow artifacts are under home or the configured Claude root. */
export function assertAllowedWorkflowPath(
  filePath: string,
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() ||
    join(homedir(), '.claude'),
): string {
  const hasTraversal = filePath
    .split(/[\\/]+/)
    .some((segment) => segment === '..');
  if (!filePath || hasTraversal) {
    throw new Error('Invalid workflow path');
  }

  const resolved = resolve(filePath);
  const real = safeRealpath(resolved);
  const allowedRoots = [
    safeRealpath(resolve(homedir())),
    safeRealpath(resolve(claudeConfigDir)),
  ];
  const isAllowed = allowedRoots.some((root) => {
    const rel = relative(root, real);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!isAllowed) {
    throw new Error('workflow path must be under an allowed directory');
  }
  if (!/(^|[\\/])workflows([\\/]|$)/.test(real)) {
    throw new Error('workflow path must be a workflows artifact');
  }
  return resolved;
}

/**
 * `transcriptDir` is `<session>/subagents/workflows/<runId>`. The run-state
 * JSON lives at `<session>/workflows/<runId>.json`. Walk three parents up to
 * the session dir, then descend into `workflows/`.
 */
export function deriveWorkflowRunStatePath(
  transcriptDir: string,
  runId: string,
): string {
  const sessionDir = dirname(dirname(dirname(transcriptDir)));
  return join(sessionDir, 'workflows', `${runId}.json`);
}

export function deriveWorkflowAgentTranscriptPath(
  transcriptDir: string,
  agentId: string,
): string {
  if (!SAFE_AGENT_ID_RE.test(agentId)) {
    throw new Error('Invalid agentId');
  }
  return join(transcriptDir, `agent-${agentId}.jsonl`);
}

/** Append-only progress journal written live during a workflow run. */
export function deriveWorkflowJournalPath(transcriptDir: string): string {
  return join(transcriptDir, 'journal.jsonl');
}

export function deriveWorkflowAgentMetaPath(
  transcriptDir: string,
  agentId: string,
): string {
  if (!SAFE_AGENT_ID_RE.test(agentId)) {
    throw new Error('Invalid agentId');
  }
  return join(transcriptDir, `agent-${agentId}.meta.json`);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePhases(value: unknown): WorkflowPhaseInfo[] {
  if (!Array.isArray(value)) return [];
  const phases: WorkflowPhaseInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const title = asString(entry.title);
    if (!title) continue;
    const detail = asString(entry.detail);
    phases.push(detail ? { title, detail } : { title });
  }
  return phases;
}

function parseAgents(value: unknown): WorkflowAgentProgress[] {
  if (!Array.isArray(value)) return [];
  const agents: WorkflowAgentProgress[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== 'workflow_agent') continue;
    const agentId = asString(entry.agentId);
    const label = asString(entry.label);
    if (!agentId || !label) continue;
    const state = asString(entry.state) ?? 'queued';
    const startedAt = asNumber(entry.startedAt);
    const durationMs = asNumber(entry.durationMs);
    agents.push({
      index: asNumber(entry.index) ?? 0,
      label,
      phaseIndex: asNumber(entry.phaseIndex) ?? 0,
      phaseTitle: asString(entry.phaseTitle) ?? '',
      agentId,
      agentType: asString(entry.agentType) ?? 'Agent',
      ...(asString(entry.model) ? { model: asString(entry.model) } : {}),
      state,
      ...(asString(entry.lastToolName)
        ? { lastToolName: asString(entry.lastToolName) }
        : {}),
      ...(asString(entry.lastToolSummary)
        ? { lastToolSummary: asString(entry.lastToolSummary) }
        : {}),
      ...(asString(entry.promptPreview)
        ? { promptPreview: asString(entry.promptPreview) }
        : {}),
      ...(asString(entry.resultPreview)
        ? { resultPreview: asString(entry.resultPreview) }
        : {}),
      ...(asNumber(entry.tokens) !== undefined
        ? { tokens: asNumber(entry.tokens) }
        : {}),
      ...(asNumber(entry.toolCalls) !== undefined
        ? { toolCalls: asNumber(entry.toolCalls) }
        : {}),
      ...(asNumber(entry.durationMs) !== undefined
        ? { durationMs: asNumber(entry.durationMs) }
        : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(startedAt !== undefined &&
      durationMs !== undefined &&
      (state === 'done' || state === 'error')
        ? { settledAt: startedAt + durationMs }
        : {}),
      ...(asString(entry.error) !== undefined
        ? { error: asString(entry.error) }
        : {}),
    });
  }
  return agents;
}

export function parseWorkflowRunState(
  raw: string,
  runId: string,
): WorkflowRunState | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;

  return {
    runId: asString(json.runId) ?? runId,
    ...(asString(json.taskId) ? { taskId: asString(json.taskId) } : {}),
    status: asString(json.status) ?? 'running',
    ...(asString(json.workflowName)
      ? { workflowName: asString(json.workflowName) }
      : {}),
    ...(asString(json.summary) ? { summary: asString(json.summary) } : {}),
    ...(asNumber(json.durationMs) !== undefined
      ? { durationMs: asNumber(json.durationMs) }
      : {}),
    ...(asNumber(json.agentCount) !== undefined
      ? { agentCount: asNumber(json.agentCount) }
      : {}),
    ...(asNumber(json.totalTokens) !== undefined
      ? { totalTokens: asNumber(json.totalTokens) }
      : {}),
    ...(asNumber(json.totalToolCalls) !== undefined
      ? { totalToolCalls: asNumber(json.totalToolCalls) }
      : {}),
    ...(asNumber(json.startTime) !== undefined
      ? { startedAt: asNumber(json.startTime) }
      : {}),
    phases: parsePhases(json.phases),
    agents: parseAgents(json.workflowProgress),
    ...(asString(json.result) ? { result: asString(json.result) } : {}),
  };
}

export interface WorkflowJournalAgent {
  agentId: string;
  label?: string;
  phase?: string;
  state: 'running' | 'done' | 'error';
}

export interface WorkflowAgentMeta {
  agentType?: string;
  description?: string;
  workflowPhase?: string;
}

export interface WorkflowLiveAgentDetails extends WorkflowAgentMeta {
  agentId: string;
  promptPreview?: string;
  startedAt?: number;
  modifiedAt?: number;
}

function parseWorkflowJournal(journalText: string): {
  agents: WorkflowJournalAgent[];
  phases: string[];
} {
  const order: string[] = [];
  const agentsById = new Map<string, WorkflowJournalAgent>();
  const phases: string[] = [];
  const seenPhases = new Set<string>();
  for (const line of journalText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    if (type !== 'started' && type !== 'result' && type !== 'failed') continue;
    const agentId = asString(entry.agentId);
    if (!agentId || !SAFE_AGENT_ID_RE.test(agentId)) continue;

    const previous = agentsById.get(agentId);
    if (!previous) order.push(agentId);
    if (type === 'started') {
      const label = asString(entry.label) ?? previous?.label;
      const phase = asString(entry.phase) ?? previous?.phase;
      if (phase && !seenPhases.has(phase)) {
        seenPhases.add(phase);
        phases.push(phase);
      }
      agentsById.set(agentId, {
        agentId,
        ...(label ? { label } : {}),
        ...(phase ? { phase } : {}),
        state: 'running',
      });
    } else {
      agentsById.set(agentId, {
        agentId,
        ...(previous?.label ? { label: previous.label } : {}),
        ...(previous?.phase ? { phase: previous.phase } : {}),
        state: type === 'result' ? 'done' : 'error',
      });
    }
  }

  return {
    agents: order.flatMap((agentId) => {
      const agent = agentsById.get(agentId);
      return agent ? [agent] : [];
    }),
    phases,
  };
}

/**
 * Parse the live `journal.jsonl` into ordered, unique agents. Latest records
 * win for state, while labels and phases come from each agent's latest start.
 */
export function parseWorkflowJournalAgents(
  journalText: string,
): WorkflowJournalAgent[] {
  return parseWorkflowJournal(journalText).agents;
}

/** Return journal phases once each, ordered by their first started record. */
export function parseWorkflowJournalPhases(journalText: string): string[] {
  return parseWorkflowJournal(journalText).phases;
}

/** Read recognized metadata from a per-agent `*.meta.json` payload. */
export function parseAgentMeta(metaText: string): WorkflowAgentMeta {
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return {};
  }
  if (!isRecord(meta)) return {};
  return {
    ...(asString(meta.agentType)
      ? { agentType: asString(meta.agentType) }
      : {}),
    ...(asString(meta.description)
      ? { description: asString(meta.description) }
      : {}),
    ...(asString(meta.workflowPhase)
      ? { workflowPhase: asString(meta.workflowPhase) }
      : {}),
  };
}

/** Read `agentType` from a per-agent `*.meta.json` payload. */
export function parseAgentMetaType(metaText: string): string | undefined {
  return parseAgentMeta(metaText).agentType;
}

/** Parse the timestamp on the first non-empty transcript record. */
export function extractAgentTranscriptStartedAt(
  jsonlText: string,
): number | undefined {
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isRecord(entry)) return undefined;
    const timestamp = asString(entry.timestamp);
    if (!timestamp) return undefined;
    const startedAt = Date.parse(timestamp);
    return Number.isFinite(startedAt) ? startedAt : undefined;
  }
  return undefined;
}

/**
 * Extract the initial user prompt from an agent transcript — the first `user`
 * record's text, whether the content is a plain string or an array of blocks.
 */
export function extractAgentPromptPreview(
  jsonlText: string,
): string | undefined {
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isRecord(entry) || entry.type !== 'user') continue;
    const message = entry.message;
    if (!isRecord(message)) return undefined;
    const content = message.content;
    if (typeof content === 'string') {
      const text = content.trim();
      return text.length > 0 ? text : undefined;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string'
        ) {
          const text = block.text.trim();
          if (text.length > 0) return text;
        }
      }
    }
    return undefined;
  }
  return undefined;
}

/** Build the live state projection from journal rows and bounded file reads. */
export function buildLiveWorkflowRunState(
  runId: string,
  journalText: string,
  details: WorkflowLiveAgentDetails[],
  journalModifiedAt?: number,
): WorkflowRunState | null {
  const journal = parseWorkflowJournal(journalText);
  if (journal.agents.length === 0) return null;

  const detailsById = new Map<string, WorkflowLiveAgentDetails>();
  for (const detail of details) {
    detailsById.set(detail.agentId, detail);
  }
  const phases: WorkflowPhaseInfo[] = journal.phases.map((title) => ({
    title,
  }));
  const agents: WorkflowAgentProgress[] = [];
  const activityTimes: number[] =
    journalModifiedAt !== undefined ? [journalModifiedAt] : [];
  let startedAt: number | undefined;

  let index = 0;
  for (const journalAgent of journal.agents) {
    index += 1;
    const detail = detailsById.get(journalAgent.agentId);
    const phaseTitle = journalAgent.phase ?? detail?.workflowPhase ?? '';
    const phaseIndex = journal.phases.indexOf(phaseTitle);
    const agentStartedAt = detail?.startedAt;
    if (agentStartedAt !== undefined && Number.isFinite(agentStartedAt)) {
      startedAt =
        startedAt === undefined
          ? agentStartedAt
          : Math.min(startedAt, agentStartedAt);
    }
    if (
      detail?.modifiedAt !== undefined &&
      Number.isFinite(detail.modifiedAt)
    ) {
      activityTimes.push(detail.modifiedAt);
    }
    const settledAt =
      journalAgent.state === 'done' || journalAgent.state === 'error'
        ? detail?.modifiedAt
        : undefined;
    agents.push({
      index,
      label:
        journalAgent.label ??
        detail?.description ??
        `Agent ${journalAgent.agentId.slice(0, 8)}`,
      phaseIndex: phaseIndex >= 0 ? phaseIndex : 0,
      phaseTitle,
      agentId: journalAgent.agentId,
      agentType: detail?.agentType ?? 'Agent',
      state: journalAgent.state,
      ...(detail?.promptPreview ? { promptPreview: detail.promptPreview } : {}),
      ...(agentStartedAt !== undefined && Number.isFinite(agentStartedAt)
        ? { startedAt: agentStartedAt }
        : {}),
      ...(settledAt !== undefined ? { settledAt } : {}),
    });
  }

  return {
    runId,
    status: 'running',
    phases,
    agents,
    agentCount: agents.length,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(activityTimes.length > 0
      ? {
          lastActivityAt: activityTimes.reduce(
            (latest, timestamp) => Math.max(latest, timestamp),
            activityTimes[0] ?? 0,
          ),
        }
      : {}),
  };
}

/** Return a bounded transcript tail plus the first user prompt when present. */
/**
 * Read a validated workflow artifact (run state or journal) in full. A byte
 * prefix of either would parse wrong: a cut run state fails JSON parsing, and
 * a cut journal misses every later agent update.
 */
export async function readWorkflowArtifactFile(
  validatedPath: string,
): Promise<string> {
  return readFile(validatedPath, 'utf8');
}

export async function readWorkflowAgentTranscript(
  filePath: string,
): Promise<ActivityReadWorkflowAgentTranscriptResponse> {
  const fileStat = await stat(filePath);
  if (fileStat.size <= 0) {
    return { lines: [], truncated: false };
  }

  const file = await open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = fileStat.size;
    let bytesBuffered = 0;
    let lineBreaks = 0;

    while (
      position > 0 &&
      bytesBuffered < MAX_AGENT_TRANSCRIPT_BYTES &&
      lineBreaks <= MAX_AGENT_TRANSCRIPT_LINES
    ) {
      const length = Math.min(
        AGENT_TRANSCRIPT_TAIL_CHUNK_BYTES,
        position,
        MAX_AGENT_TRANSCRIPT_BYTES - bytesBuffered,
      );
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesBuffered += bytesRead;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 10) lineBreaks += 1;
      }
    }

    const content = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (position > 0 && lines.length > 0) lines.shift();
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    const truncated =
      position > 0 || nonEmptyLines.length > MAX_AGENT_TRANSCRIPT_LINES;
    const tail = nonEmptyLines.slice(-MAX_AGENT_TRANSCRIPT_LINES);

    const prefixLength = Math.min(fileStat.size, INITIAL_PROMPT_PREFIX_BYTES);
    const prefixBuffer = Buffer.alloc(prefixLength);
    const { bytesRead: prefixBytesRead } = await file.read(
      prefixBuffer,
      0,
      prefixLength,
      0,
    );
    const prefix = prefixBuffer.subarray(0, prefixBytesRead).toString('utf8');
    const initialPrompt = extractAgentPromptPreview(prefix);

    return {
      lines: tail,
      truncated,
      ...(initialPrompt ? { initialPrompt } : {}),
    };
  } finally {
    await file.close();
  }
}
