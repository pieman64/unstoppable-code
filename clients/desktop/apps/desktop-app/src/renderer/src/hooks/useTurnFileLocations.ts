import { useEffect, useMemo, useRef, useState } from 'react';
import { expandTurnFileRecords } from '@canopy/protocol/turn-files';
import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import type { TurnFileLocation } from '@canopy/desktop-shared/lib/turn-files';
import {
  resolveTurnFileLocations,
  type TurnFileLocationsResolution,
} from '@/lib/turn-file-locations';

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
  /** Transient source-to-summary paths; never retained after settlement. */
  pendingPathAliases: TurnFileLocationsResolution['pendingPathAliases'];
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
const NO_PENDING_ALIASES: TurnFileLocationsResolution['pendingPathAliases'] =
  [];
const RETRY_DELAY_MS = 2_000;

function candidateKey(file: TranscriptTurnFile): string {
  return `${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`;
}

function locationKey(file: TurnFileLocation): string {
  return `${file.target?.projectId ?? ''}/${file.target?.worktreeId ?? ''}:${file.path}`;
}

/**
 * Reconciles every lifecycle state by host file identity before presentation.
 * Only ready files are checked for existence and become actionable. Legacy
 * unfinished creations may be checked on completion; pending updates never
 * inherit success merely because the path already exists.
 */
export function useTurnFileLocations(
  target: TurnFileLocationsTarget | undefined,
  files: readonly TranscriptTurnFile[],
  complete: boolean,
): TurnFileLocationsResult {
  const evidence = useMemo(() => expandTurnFileRecords(files), [files]);
  const candidates = useMemo(
    () =>
      evidence.map(
        (file): TranscriptTurnFile =>
          complete && file.change !== 'updated' && file.state === 'creating'
            ? { ...file, state: 'ready' }
            : file,
      ),
    [complete, evidence],
  );
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  // A change of classification re-resolves, so a located chip never keeps a
  // stale updated or saved marker.
  const key = `${projectId ?? ''}/${worktreeId ?? ''}\u0000${complete}\u0000${candidates
    .map(
      (file) =>
        `${candidateKey(file)}\u0000${file.change ?? ''}\u0000${file.state}\u0000${file.saved ?? ''}\u0000${file.removed ?? ''}\u0000${JSON.stringify(file.movedFrom ?? [])}`,
    )
    .join('\n')}`;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  // Completion is the one transition that must look at the disk again, so it
  // refreshes the short-lived caches first; everything else may reuse them.
  const previousCompleteRef = useRef(complete);
  const [result, setResult] = useState<{
    key: string;
    located: TurnFileLocation[];
    pending: TranscriptTurnFile[];
    pendingPathAliases: TurnFileLocationsResolution['pendingPathAliases'];
  }>({
    key: '',
    located: NONE,
    pending: [],
    pendingPathAliases: NO_PENDING_ALIASES,
  });

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
        setResult({
          key,
          located: resolution.located,
          pending: resolution.pending,
          pendingPathAliases: resolution.pendingPathAliases,
        });
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
    // Until aliases are reconciled, an earlier presentation cannot remain actionable.
    if (
      candidates.some(
        (file) =>
          file.state !== 'ready' || file.removed || file.movedFrom?.length,
      )
    )
      return NONE;
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
      const creating = evidence.filter((file) => file.state === 'creating');
      if (answered) return result.pending;
      if (
        candidates.some(
          (file) =>
            file.state !== 'ready' || file.removed || file.movedFrom?.length,
        )
      )
        return creating;
      const known = new Set(located.map(locationKey));
      return [
        ...creating,
        ...candidates.filter((file) => !known.has(candidateKey(file))),
      ];
    }
    if (answered || mountedCompleteRef.current) return [];
    const stillCandidates = new Set(
      candidates.filter((file) => file.state !== 'failed').map(candidateKey),
    );
    return lastPendingRef.current.filter((file) =>
      stillCandidates.has(candidateKey(file)),
    );
  }, [
    answered,
    candidates,
    complete,
    evidence,
    located,
    projectId,
    worktreeId,
    result.pending,
  ]);
  lastPendingRef.current = pending;
  const pendingPathAliases =
    answered && !complete ? result.pendingPathAliases : NO_PENDING_ALIASES;

  return useMemo(
    () => ({ pending, pendingPathAliases, located, settled }),
    [pending, pendingPathAliases, located, settled],
  );
}
