/**
 * Pipeline origin badge tones, shared by every surface that labels where a
 * pipeline came from (desktop pipeline tables, trigger modal, hook editor,
 * and the web plan-pipeline dialog) so one origin reads the same everywhere.
 *
 * Origin is a taxonomy, not a run state, and the token set has no
 * origin-specific roles. Borrowing intent hues is therefore a deliberate,
 * named deviation from DESIGN.md "Consume roles, not values": the assignment
 * is fixed here, once, so no surface picks its own hue. Every tinted origin
 * gets a hue that is stable across brands and themes: `accent` is excluded
 * because it is brand-defined (green on Canopy, blue on Unstoppable, so it
 * would collide with `curated` or `shared`), and `info` aliases `special` in
 * the token graph, so only one of the two appears below.
 */
export type PipelineSourceBadgeKey =
  | 'user'
  | 'project'
  | 'bundled'
  | 'shared'
  | 'curated';

const PIPELINE_SOURCE_BADGE_TONES: Readonly<
  Record<PipelineSourceBadgeKey, string>
> = {
  /**
   * Authored on this machine. The user's own pipelines are the plain case,
   * so they wear the neutral secondary chip and every tinted badge means
   * "came from somewhere else".
   */
  user: 'bg-quaternary fg-secondary',
  /** Checked into the repository the worktree belongs to. */
  project: 'bg-warning-subtle fg-warning',
  /** Ships with the app. */
  bundled: 'bg-info-subtle fg-info',
  /**
   * Published by a teammate or the organization. Blue is the one hue left
   * that is not an alias of another entry, and it has no `*-subtle` surface
   * role, so this is the only tint here that alpha-mixes its ink.
   */
  shared: 'bg-fg-blue/10 fg-blue',
  /** Maintained by the curated catalog. */
  curated: 'bg-success-subtle fg-success',
};

export const PIPELINE_SOURCE_BADGE_KEYS: readonly PipelineSourceBadgeKey[] = [
  'user',
  'project',
  'bundled',
  'shared',
  'curated',
];

/** Tone classes (background + ink) for a pipeline origin badge. */
export function pipelineSourceBadgeClassName(
  source: PipelineSourceBadgeKey,
): string {
  return PIPELINE_SOURCE_BADGE_TONES[source];
}
