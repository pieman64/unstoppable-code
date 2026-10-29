import {
  normalizeScriptDevServerPatternsForRuntime,
  type NormalizedScriptDevServerPattern,
  type ScriptDevServerOpenTarget,
  type ScriptDevServerPattern,
} from '@canopy/desktop-shared/scripts';

/**
 * A single detected dev-server URL hit for a script run.
 *
 * - `url` is the normalized `href` produced by `new URL(...)`; we dedupe on this.
 * - `displayUrl` is the candidate string as extracted from the line (post-
 *   capture-group / full-match selection); kept verbatim for the open-control UI
 *   so users see what they originally printed.
 * - `label` is the optional human-readable label from the matching pattern
 *   entry, copied from the first pattern that produced this URL. Lower-priority
 *   labels never overwrite a previously detected hit's label.
 * - `patternIndex` records which pattern entry (priority order) supplied the
 *   match — useful for tests and for any future "Open all from <label>" UX.
 * - `firstSeenAt` is set on the batch in which the hit was first detected; it
 *   is preserved across subsequent batches.
 * - `openTarget` is copied from the matching normalized pattern entry and
 *   decides whether `Open` routes the URL into Canopy's Browser tab
 *   (`'in-app'`, the default for legacy patterns) or to the system browser
 *   (`'external'`).
 */
export interface DevServerHit {
  url: string;
  displayUrl: string;
  label?: string;
  patternIndex: number;
  firstSeenAt: number;
  openTarget: ScriptDevServerOpenTarget;
  /** Open automatically only for new live output, never snapshot hydration. */
  autoOpen?: boolean;
}

/**
 * Cap on the number of dev-server hits we keep per run. Anything past this is
 * silently dropped — the renderer UI's dropdown is not designed to surface
 * arbitrarily many URLs, and storing more would waste memory while a launch
 * runs.
 */
const MAX_DEV_SERVER_HITS = 8;

/**
 * Cap on the length of a single output line we will run regexes against.
 * Pathologically long lines (massive JSON blobs, base64 payloads) blow up
 * regex compile + match cost; truncating bounds the per-line work and matches
 * the shared `MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH` story.
 */
const MAX_DETECTION_LINE_LENGTH = 4096;

/**
 * Matches ANSI CSI / SGR escape sequences such as `\x1b[31m`, `\x1b[K`, etc.
 * Detection runs against the stripped line so URLs embedded inside color-coded
 * output (`\x1b[36mhttp://localhost:3000\x1b[0m`) still match. Kept local so we
 * do not couple this lightweight helper to the renderer's full `AnsiOutput`
 * parser.
 */
// eslint-disable-next-line no-control-regex -- ANSI escape stripping is the entire purpose of this regex.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_PATTERN, '');
}

interface CompiledPattern {
  regex: RegExp;
  label?: string;
  patternIndex: number;
  openTarget: ScriptDevServerOpenTarget;
  autoOpen?: boolean;
}

function compilePatterns(
  patterns: readonly NormalizedScriptDevServerPattern[],
): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (let i = 0; i < patterns.length; i += 1) {
    const entry = patterns[i];
    try {
      compiled.push({
        regex: new RegExp(entry.pattern, 'g'),
        label: entry.label,
        patternIndex: i,
        openTarget: entry.openTarget,
        autoOpen: entry.autoOpen,
      });
    } catch {
      // Skip patterns that fail to compile here. Normalization already runs a
      // parseability check upstream, but we re-guard so a future code path that
      // bypasses `normalizeScriptDevServerPatternsForRuntime` cannot crash
      // detection.
    }
  }
  return compiled;
}

function isHttpUrl(candidate: string): { url: string } | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { url: parsed.href };
    }
    return null;
  } catch {
    return null;
  }
}

function extractCandidatesFromLine(line: string, regex: RegExp): string[] {
  // Pattern entries are compiled with the 'g' flag so a single pattern may
  // emit multiple URLs from one output line. We reset `lastIndex` because the
  // same compiled regex is reused across lines within a batch.
  regex.lastIndex = 0;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    // Zero-length match guard: without this, a pattern like `^` would loop
    // forever. Bump `lastIndex` past the empty match and continue.
    if (match.index === regex.lastIndex) {
      regex.lastIndex += 1;
    }

    // Prefer the first non-empty capture group (so users can write
    // `Listening on (https?://\S+)` and have the parenthesized URL extracted);
    // fall back to the full match otherwise.
    let candidate: string | undefined;
    for (let i = 1; i < match.length; i += 1) {
      const group = match[i];
      if (typeof group === 'string' && group.length > 0) {
        candidate = group;
        break;
      }
    }
    if (candidate === undefined) {
      candidate = match[0];
    }
    if (typeof candidate === 'string' && candidate.length > 0) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Extract dev-server URL hits from a batch of newly streamed output lines.
 *
 * Detection runs against the new lines only — callers pass the accumulated
 * `existingHits` so dedupe is global across the run's lifetime, not per batch.
 * Existing hits are preserved verbatim (original label, patternIndex, and
 * timestamp) so a later batch can never overwrite a label discovered earlier.
 *
 * Returns the same array reference as `existingHits ?? []` when there is
 * nothing new to do (no patterns, no lines, or no new matches).
 */
export function extractDevServerHits(args: {
  devServerPattern: ScriptDevServerPattern | undefined;
  lines: string[];
  existingHits?: DevServerHit[];
  now?: () => number;
}): DevServerHit[] {
  const { devServerPattern, lines, existingHits } = args;
  const existing = existingHits ?? [];

  const patterns = normalizeScriptDevServerPatternsForRuntime(devServerPattern);
  if (patterns.length === 0) {
    return existing;
  }
  if (lines.length === 0) {
    return existing;
  }

  const compiled = compilePatterns(patterns);
  if (compiled.length === 0) {
    return existing;
  }

  // Build the working set from `existing` so dedupe spans the whole run.
  const next: DevServerHit[] = [...existing];
  const seenUrls = new Set<string>(existing.map((hit) => hit.url));
  if (next.length >= MAX_DEV_SERVER_HITS) {
    return existing;
  }

  const now = args.now ?? Date.now;
  let mutated = false;

  outer: for (const rawLine of lines) {
    const stripped = stripAnsi(rawLine);
    const truncated =
      stripped.length > MAX_DETECTION_LINE_LENGTH
        ? stripped.slice(0, MAX_DETECTION_LINE_LENGTH)
        : stripped;
    if (truncated.length === 0) {
      continue;
    }

    for (const entry of compiled) {
      const candidates = extractCandidatesFromLine(truncated, entry.regex);
      if (candidates.length === 0) {
        continue;
      }

      let producedValidUrl = false;
      for (const candidate of candidates) {
        const parsed = isHttpUrl(candidate);
        if (!parsed) {
          continue;
        }
        producedValidUrl = true;
        if (seenUrls.has(parsed.url)) {
          continue;
        }
        const hit: DevServerHit = {
          url: parsed.url,
          displayUrl: candidate,
          patternIndex: entry.patternIndex,
          firstSeenAt: now(),
          openTarget: entry.openTarget,
        };
        if (entry.label !== undefined) {
          hit.label = entry.label;
        }
        if (entry.autoOpen === true) {
          hit.autoOpen = true;
        }
        next.push(hit);
        seenUrls.add(parsed.url);
        mutated = true;
        if (next.length >= MAX_DEV_SERVER_HITS) {
          break outer;
        }
      }

      // If the higher-priority pattern matched and produced a valid URL, stop
      // checking lower-priority patterns for this line — that's how labels
      // win. (A pattern that matched but produced no valid URL falls through.)
      if (producedValidUrl) {
        break;
      }
    }
  }

  if (!mutated) {
    return existing;
  }
  return next;
}
