import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { hasRenderableRichTranscript } from './pipelineExecutionDetail';
import { parseAgentTranscriptLines } from './transcript-parser';

const FIRST_PROBE_LINES = 64;
const PROBE_GROWTH = 4;

/**
 * Whether an agent step's transcript lines contain a renderable message: the
 * signal that makes Rich the default log view.
 *
 * A full parse answers this for the cost of the whole transcript. Transcripts
 * produce their first message within a few lines, so this parses growing
 * prefixes and stops at the first one that renders. The last probe covers
 * every line, so the answer equals a full parse's; a log with no message at
 * all costs about a third more than one full parse.
 */
export function hasRenderableTranscriptPrefix(
  lines: readonly string[],
  provider: AgentProviderType | undefined,
): boolean {
  let end = Math.min(lines.length, FIRST_PROBE_LINES);
  while (end > 0) {
    const parsed = parseAgentTranscriptLines(lines.slice(0, end), provider);
    if (hasRenderableRichTranscript(parsed.displayMessages)) {
      return true;
    }
    if (end >= lines.length) {
      return false;
    }
    end = Math.min(lines.length, end * PROBE_GROWTH);
  }
  return false;
}

/** What a transcript probe last saw: enough to tell whether to probe again. */
export interface TranscriptProbeMark {
  length: number;
  lastLine: string | undefined;
}

export function markTranscriptProbe(
  lines: readonly string[],
): TranscriptProbeMark {
  return { length: lines.length, lastLine: lines[lines.length - 1] };
}

/**
 * Whether the lines changed since the probe that left `mark`. A JSONL record
 * can complete in place on the final line, leaving the line count unchanged,
 * so the final line's content is compared as well as the count.
 */
export function transcriptChangedSinceProbe(
  mark: TranscriptProbeMark | null,
  lines: readonly string[],
): boolean {
  return (
    mark === null ||
    mark.length !== lines.length ||
    mark.lastLine !== lines[lines.length - 1]
  );
}
