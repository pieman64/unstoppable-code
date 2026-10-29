import type { ScriptOutputEvent } from '@canopy/desktop-shared/types';
import {
  extractDevServerHits,
  type DevServerHit,
} from './scriptDevServerDetection';

type RunIdentity = Pick<
  ScriptOutputEvent,
  'projectId' | 'worktreeId' | 'script' | 'runId'
>;
type OpenContext = Pick<RunIdentity, 'projectId' | 'worktreeId'>;

export interface ScriptDevServerAutoOpener {
  started: (event: RunIdentity) => void;
  output: (event: ScriptOutputEvent) => void;
  completed: (event: RunIdentity) => void;
}

/** Live events only: independent of selected worktree and persisted log hydration. */
export function createScriptDevServerAutoOpener(
  open: (hit: DevServerHit, context: OpenContext) => void,
): ScriptDevServerAutoOpener {
  const hitsByRun = new Map<string, DevServerHit[]>();
  const key = (event: RunIdentity): string =>
    JSON.stringify([
      event.projectId,
      event.worktreeId,
      event.script.scriptKey,
      event.runId ?? null,
    ]);
  const clear = (event: RunIdentity): void => {
    hitsByRun.delete(key(event));
  };
  return {
    started: clear,
    completed: clear,
    output: (event): void => {
      const pattern = event.script.devServerPattern;
      if (pattern === undefined || typeof pattern === 'string') {
        return;
      }
      const entries = Array.isArray(pattern) ? pattern : [pattern];
      // Legacy scripts pay no regex/detection cost on this additional path.
      if (
        !entries.some(
          (entry) => typeof entry === 'object' && entry?.autoOpen === true,
        )
      ) {
        return;
      }
      const runKey = key(event);
      const previous = hitsByRun.get(runKey) ?? [];
      const hits = extractDevServerHits({
        devServerPattern: pattern,
        lines: event.lines,
        existingHits: previous,
      });
      // Record before opening, so reentrant or repeated events cannot reopen.
      hitsByRun.set(runKey, hits);
      for (const hit of hits.slice(previous.length)) {
        if (hit.autoOpen === true) {
          open(hit, {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
          });
        }
      }
    },
  };
}
