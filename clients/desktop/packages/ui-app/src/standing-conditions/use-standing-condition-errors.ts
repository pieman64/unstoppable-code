import { useEffect, useRef, useState } from 'react';
import { createAppError, type AppError } from '@canopy/protocol/app-errors';
import {
  resolveStandingConditions,
  selectStandingConditionSignals,
  type StandingCondition,
  type StandingConditionInput,
  type StandingConditionSignal,
} from './standing-conditions';

/** A re-raise inside this window is the same episode, with the same reference. */
const CLEARED_EPISODE_RETENTION_MS = 60_000;
const MAX_CLEARED_EPISODES = 16;

/** Returns the error the host recorded, which display and reports must use. */
export type StandingConditionReporter = (error: AppError) => AppError;

interface Episode {
  readonly signature: string;
  readonly error: AppError;
  clearedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function createEpisodeError(
  signal: StandingConditionSignal,
  report: StandingConditionReporter | undefined,
): AppError {
  const error = createAppError(
    signal.code,
    signal.source === undefined ? {} : { source: signal.source },
  );
  try {
    return report?.(error) ?? error;
  } catch {
    // A failing report path must not take the banner down with it.
    return error;
  }
}

function sameErrors(
  a: ReadonlyMap<string, AppError>,
  b: ReadonlyMap<string, AppError>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, error] of a) {
    if (b.get(id) !== error) return false;
  }
  return true;
}

/**
 * One error and one report per active episode, by condition ID. Errors are
 * created in an effect, so a new condition can show one render late. A
 * suppressed signal keeps an existing episode alive but never starts one.
 */
export function useStandingConditionErrors(
  active: readonly StandingConditionSignal[],
  report?: StandingConditionReporter,
): ReadonlyMap<string, AppError> {
  const [errors, setErrors] = useState<ReadonlyMap<string, AppError>>(
    () => new Map<string, AppError>(),
  );
  const episodesRef = useRef(new Map<string, Episode>());
  const latestRef = useRef({ active, report });
  // Value-based, so a new array or callback identity is not a new episode.
  const activeKey = JSON.stringify(
    active.map((signal) => [
      signal.id,
      signal.code,
      signal.source ?? null,
      signal.suppressed === true,
    ]),
  );

  useEffect(() => {
    latestRef.current = { active, report };
  });

  useEffect(() => {
    const episodes = episodesRef.current;

    const publish = (): void => {
      const next = new Map<string, AppError>();
      for (const [id, episode] of episodes) {
        if (episode.clearedAt === null) next.set(id, episode.error);
      }
      setErrors((previous) => (sameErrors(previous, next) ? previous : next));
    };

    const stopTimer = (episode: Episode): void => {
      if (episode.timer !== null) clearTimeout(episode.timer);
      episode.timer = null;
    };

    const activeIds = new Set<string>();
    for (const signal of latestRef.current.active) {
      activeIds.add(signal.id);
      const signature = JSON.stringify([signal.code, signal.source ?? null]);
      let episode = episodes.get(signal.id);
      if (
        episode &&
        (episode.signature !== signature ||
          (episode.clearedAt !== null &&
            Date.now() - episode.clearedAt >= CLEARED_EPISODE_RETENTION_MS))
      ) {
        stopTimer(episode);
        episodes.delete(signal.id);
        episode = undefined;
      }
      if (episode) {
        stopTimer(episode);
        episode.clearedAt = null;
      } else if (signal.suppressed !== true) {
        episodes.set(signal.id, {
          signature,
          error: createEpisodeError(signal, latestRef.current.report),
          clearedAt: null,
          timer: null,
        });
      }
    }

    const now = Date.now();
    const cleared: [string, Episode][] = [];
    for (const entry of episodes) {
      const [id, episode] = entry;
      if (activeIds.has(id)) continue;
      episode.clearedAt ??= now;
      cleared.push(entry);
    }
    cleared.sort(([, a], [, b]) => (a.clearedAt ?? 0) - (b.clearedAt ?? 0));
    for (const [id, episode] of cleared.slice(
      0,
      Math.max(0, cleared.length - MAX_CLEARED_EPISODES),
    )) {
      stopTimer(episode);
      episodes.delete(id);
    }
    for (const [id, episode] of cleared.slice(-MAX_CLEARED_EPISODES)) {
      // Strict Mode replay stops timers, so re-arm from the original clear.
      if (episode.timer !== null) continue;
      episode.timer = setTimeout(
        (): void => {
          episode.timer = null;
          if (episodes.get(id) === episode) episodes.delete(id);
        },
        Math.max(
          0,
          (episode.clearedAt ?? now) + CLEARED_EPISODE_RETENTION_MS - now,
        ),
      );
    }

    publish();
  }, [activeKey]);

  useEffect(() => {
    const episodes = episodesRef.current;
    return (): void => {
      for (const episode of episodes.values()) {
        if (episode.timer !== null) clearTimeout(episode.timer);
        episode.timer = null;
      }
    };
  }, []);

  return errors;
}

/** Filters, episodes and resolves a host's inputs in one step. */
export function useStandingConditions(
  inputs: readonly StandingConditionInput[],
  report?: StandingConditionReporter,
): StandingCondition[] {
  const errors = useStandingConditionErrors(
    selectStandingConditionSignals(inputs),
    report,
  );
  return resolveStandingConditions(inputs, errors);
}
