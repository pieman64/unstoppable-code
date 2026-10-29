// Analysis of one captured window (one thread/turn): request summaries,
// phase labels, tool surface, and per-request global-AGENTS content. Pure.
import { classifyRecords } from './phase-classifier.mjs';
import {
  growthSeries,
  isGenerationRecord,
  summarizeResponsesRequest,
  withEffectiveBytes,
} from './request-breakdown.mjs';

/**
 * @param {object} snapshot capture snapshot
 * @param {{ completionSeq?: number|null, singlePhase?: string, agentsTokens?: string[], contentTokens?: Record<string,string> }} options
 *   `contentTokens`: named tokens to locate per request (for example the
 *   original and replacement global AGENTS canaries).
 */
export function analyzeWindow(
  snapshot,
  {
    completionSeq = null,
    singlePhase,
    agentsTokens = [],
    contentTokens = {},
  } = {},
) {
  const phases = classifyRecords(snapshot.records, {
    completionSeq,
    singlePhase,
  });
  const generation = snapshot.records.filter(isGenerationRecord);
  const previousSeqBySeq = new Map(
    generation.map((record) => [record.seq, record.previousSeq ?? null]),
  );
  const summaries = withEffectiveBytes(
    generation.map((record) =>
      summarizeResponsesRequest(record, { agentsTokens }),
    ),
    previousSeqBySeq,
  ).map((summary) => {
    const record = snapshot.records.find(
      (candidate) => candidate.seq === summary.seq,
    );
    const text = record
      ? Buffer.from(record.rawBase64, 'base64').toString('utf8')
      : '';
    return {
      ...summary,
      phase: phases.get(summary.seq) ?? null,
      contains: Object.fromEntries(
        Object.entries(contentTokens).map(([name, token]) => [
          name,
          text.includes(token),
        ]),
      ),
    };
  });
  const nonGeneration = snapshot.records
    .filter((record) => !isGenerationRecord(record))
    .map((record) => ({
      seq: record.seq,
      kind: record.kind,
      surface: record.surface,
      method: record.method,
      path: record.path,
      prompt: record.prompt,
      phase: phases.get(record.seq) ?? null,
    }));
  return { phases, summaries, growth: growthSeries(summaries), nonGeneration };
}

/** Compare the advertised tool names with the expected set. */
export function compareToolSurface(actualNames, expectedNames) {
  const actual = new Set(actualNames);
  const expected = new Set(expectedNames);
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  return {
    equal: extra.length === 0 && missing.length === 0,
    extra,
    missing,
    actualCount: actual.size,
  };
}

/**
 * Per-request global AGENTS table: which request carried which content and its
 * byte size (05 §1.12 counting).
 */
export function globalAgentsTable(summaries) {
  return summaries.map((summary, index) => ({
    request: index,
    seq: summary.seq,
    phase: summary.phase,
    globalAgentsBytes: summary.globalAgents?.bytes ?? 0,
    globalAgentsItems: summary.globalAgents?.items ?? 0,
    carries: summary.contains ?? {},
  }));
}

/** Byte shares for the harness-overhead report of the first request. */
export function harnessOverhead(summary) {
  if (!summary?.parsed) return null;
  const c = summary.classBytes;
  const pageAndPrompt =
    (c.tool_output ?? 0) +
    (c.tool_call ?? 0) +
    (c.user_prompt ?? 0) +
    (c.assistant ?? 0) +
    (c.reasoning ?? 0);
  return {
    totalBytes: summary.totalBytes,
    instructionsBytes: summary.instructionsBytes,
    toolsBytes: summary.toolsBytes,
    inputToolSchemaBytes: summary.inputToolSchemaBytes,
    globalAgentsBytes: summary.globalAgents.bytes,
    developerBytes: c.developer ?? 0,
    otherUserItemBytes: c.user_other ?? 0,
    userPromptBytes: c.user_prompt ?? 0,
    otherFieldBytes: summary.otherFieldBytes,
    harnessBytes: summary.totalBytes - pageAndPrompt,
    estimateTokensAt3: Math.ceil(summary.totalBytes / 3),
    estimateTokensAt4: Math.ceil(summary.totalBytes / 4),
  };
}
