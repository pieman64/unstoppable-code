import { brandText } from '@/lib/brand';
import { extractIpcErrorMessage } from '@/lib/errors';

/** One source that failed to load, and what it reported. */
export interface SourceLoadError {
  /** What failed, in sentence case: `Shared skills`, `MCP servers`. */
  readonly source: string;
  /** The raw message, possibly still wrapped by Electron's IPC rejection. */
  readonly message: string;
}

export interface LoadErrorSummary {
  /** What failed: `Couldn't load shared skills and collections.` */
  readonly title: string;
  /** Why, in plain words. */
  readonly message: string;
}

const CLOUD_NOT_CONFIGURED_REGEX = /base URL is not configured/i;

/**
 * The reason a source failed, as the user should read it: Electron's
 * `Error invoking remote method '…':` wrapper and error class names removed,
 * and a missing Cloud configuration said in plain words.
 */
export function describeLoadError(message: string): string {
  const cleaned = extractIpcErrorMessage(message).trim();
  if (CLOUD_NOT_CONFIGURED_REGEX.test(cleaned)) {
    return `${brandText.appName} Cloud isn't set up in this build.`;
  }
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** `Shared skills`, `Shared collections` → `shared skills and collections`. */
function describeSources(sources: readonly string[]): string {
  // Mid-sentence, a word drops its capital; an acronym (`MCP`) keeps it.
  const lowered = sources.map((source) =>
    /^[A-Z][a-z]/.test(source)
      ? source.charAt(0).toLowerCase() + source.slice(1)
      : source,
  );
  const shared = 'shared ';
  if (lowered.length > 1 && lowered.every((s) => s.startsWith(shared))) {
    return `${shared}${joinList(lowered.map((s) => s.slice(shared.length)))}`;
  }
  return joinList(lowered);
}

/**
 * One notice for several sources that failed to load. Sources that failed
 * for the same reason are named together, so a single cause (the Cloud not
 * being set up) reads as one sentence instead of one raw error per source.
 */
export function summarizeLoadErrors(
  errors: readonly SourceLoadError[],
): LoadErrorSummary | null {
  if (errors.length === 0) return null;
  const sourcesByReason = new Map<string, string[]>();
  for (const { source, message } of errors) {
    const reason = describeLoadError(message);
    const sources = sourcesByReason.get(reason) ?? [];
    sources.push(source);
    sourcesByReason.set(reason, sources);
  }
  const groups = Array.from(sourcesByReason.entries());
  const allSources = groups.flatMap(([, sources]) => sources);
  const title = `Couldn't load ${describeSources(allSources)}.`;
  if (groups.length === 1) {
    return { title, message: groups[0][0] };
  }
  return {
    title,
    message: groups
      .map(([reason, sources]) => {
        const named = describeSources(sources);
        return `${named.charAt(0).toUpperCase()}${named.slice(1)}: ${reason}`;
      })
      .join(' '),
  };
}
