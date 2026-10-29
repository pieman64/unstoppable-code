import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import type { TurnFileLocation } from '@canopy/desktop-shared/lib/turn-files';
import { resolveTurnFileLocations } from '@/lib/turn-file-locations';

export interface TurnFileLocationsTarget {
  projectId: string;
  worktreeId: string;
}

export interface TurnFileLocationsResult {
  /**
   * Chips to show before a host answer: creations still in flight while the
   * turn runs, plus files whose check has not answered yet so the summary
   * does not unmount between a creation finishing and its check resolving.
   */
  pending: TranscriptTurnFile[];
  /** Files confirmed to exist inside a root of their workspace. */
  located: TurnFileLocation[];
  /**
   * False only while a turn that was already complete when it mounted waits
   * for its first host answer; a live turn is always settled so its summary
   * never collapses while the agent works.
   */
  settled: boolean;
}

const NONE: TurnFileLocation[] = [];
const RETRY_DELAY_MS = 2_000;

function candidateKey(file: TranscriptTurnFile): string {
  return `${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`;
}

function locationKey(file: TurnFileLocation): string {
  return `${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`;
}

/**
 * Checks a turn's file outputs against the host before they are presented.
 * While the turn runs only completed creations are checked; once it ends
 * every record that did not fail is, so a creation the transcript never saw
 * finish still shows when the file is there and stays hidden when it is not.
 * A failed write never becomes a chip: the path may exist from before.
 */
export function useTurnFileLocations(
  target: TurnFileLocationsTarget | undefined,
  files: readonly TranscriptTurnFile[],
  complete: boolean,
): TurnFileLocationsResult {
  const candidates = useMemo(
    () =>
      files.filter((file) =>
        complete ? file.state !== 'failed' : file.state === 'ready',
      ),
    [complete, files],
  );
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const key = `${projectId ?? ''}/${worktreeId ?? ''}\u0000${complete}\u0000${candidates
    .map(candidateKey)
    .join('\n')}`;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  // Completion is the one transition that must look at the disk again, so it
  // refreshes the short-lived caches first; everything else may reuse them.
  const previousCompleteRef = useRef(complete);
  const [result, setResult] = useState<{
    key: string;
    located: TurnFileLocation[];
  }>({ key: '', located: NONE });

  useEffect(() => {
    const fresh = complete && !previousCompleteRef.current;
    previousCompleteRef.current = complete;
    if (!projectId || !worktreeId || candidatesRef.current.length === 0)
      return undefined;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = (attempt: number): void => {
      void resolveTurnFileLocations(
        { projectId, worktreeId },
        candidatesRef.current,
        { fresh },
      ).then((resolution) => {
        if (cancelled) return;
        setResult({ key, located: resolution.located });
        // A check that could not complete is not an answer for that file:
        // show what is known now and look once more shortly after.
        if (resolution.failed && attempt === 0)
          retry = setTimeout(() => run(1), RETRY_DELAY_MS);
      });
    };
    run(0);
    return (): void => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [key, projectId, worktreeId, complete]);

  const located = useMemo(() => {
    if (!projectId || !worktreeId || candidates.length === 0) return NONE;
    if (result.key === key) return result.located;
    // Keep entries that are still candidates while a newer check runs.
    const keys = new Set(candidates.map(candidateKey));
    const kept = result.located.filter((file) =>
      keys.has(
        `${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`,
      ),
    );
    return kept.length === result.located.length ? result.located : kept;
  }, [candidates, key, projectId, result, worktreeId]);

  const answered = result.key === key;
  const mountedCompleteRef = useRef(complete);
  const settled =
    !mountedCompleteRef.current ||
    !projectId ||
    !worktreeId ||
    candidates.length === 0 ||
    result.key !== '';

  // Chips shown before the host answers. A ready file whose check is still
  // running stays visible as pending rather than vanishing for a frame; a
  // turn that just completed keeps the chips it was showing until the
  // completion recheck answers. A turn that mounted already complete shows
  // nothing until its files are confirmed.
  const lastPendingRef = useRef<TranscriptTurnFile[]>([]);
  const pending = useMemo(() => {
    // Without a chat target nothing can be checked or opened, so a viewer
    // that renders turns without one (pipeline detail, audit trail) shows no
    // files at all rather than an empty disclosure.
    if (!projectId || !worktreeId) return [];
    if (!complete) {
      const creating = files.filter((file) => file.state === 'creating');
      if (answered) return creating;
      const known = new Set(located.map(locationKey));
      return [
        ...creating,
        ...candidates.filter((file) => !known.has(candidateKey(file))),
      ];
    }
    if (answered || mountedCompleteRef.current) return [];
    const stillCandidates = new Set(candidates.map(candidateKey));
    return lastPendingRef.current.filter((file) =>
      stillCandidates.has(candidateKey(file)),
    );
  }, [answered, candidates, complete, files, located, projectId, worktreeId]);
  lastPendingRef.current = pending;

  return useMemo(
    () => ({ pending, located, settled }),
    [pending, located, settled],
  );
}
