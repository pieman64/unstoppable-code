/**
 * Whether the Projects stand-in at the foot of the rail should be showing.
 *
 * The stand-in exists because an expanded Chats list pushes the real Projects
 * band clean off the bottom of the viewport, and `position: sticky` cannot
 * lift an element above its own place in the flow. It is shown exactly while
 * the band is gone.
 *
 * Pulled out as a pure function because the decision has to be made in two
 * different frames of reference. The rail's scroll sync is PREDICTIVE: the
 * wheel handler cancels the event, computes where the scroll is about to land,
 * and syncs every sticky style for that position before committing
 * `viewport.scrollTop`, so the whole gesture stays on the main thread. Every
 * other term in that pass is derived from the predicted offset — but rects are
 * necessarily measured at the CURRENT one. Feeding them in unadjusted left the
 * stand-in a full wheel event behind: a gesture that stopped within one delta
 * of the crossing settled wrong, and nothing re-measured, because the scroll
 * event that follows early-returns on `lastSyncedScrollTop === scrollTop`.
 * Usually that showed a redundant stand-in under a visible band; scrolling up,
 * it hid the stand-in while Projects was unreachable — this feature's own bug.
 */
export interface ProjectsPinVisibilityMetrics {
  /** Top edge of the sticky Projects band, measured at the current offset. */
  readonly controlsTop: number;
  /** Height of that band. Zero means it is not laid out; never pin then. */
  readonly controlsHeight: number;
  /** Bottom edge of the scroll viewport. Fixed — scrolling does not move it. */
  readonly hostBottom: number;
  /**
   * Pixels the caller is about to scroll by, positive downward. Zero for the
   * at-rest path, which measures and decides in the same frame.
   *
   * Scrolling down moves content up, so the band's predicted top is
   * `controlsTop - scrollDelta`. Linear prediction is sound here precisely
   * because the band is below the fold in this regime — it is travelling with
   * the flow, not stuck, so nothing clamps its movement.
   *
   * The linearity claim is bounded, and the asymmetry is the point. Flinging
   * UP away from a band that is currently stuck at the top, `controlsTop` is
   * clamped at the sticky offset while its true flow top is higher, so the
   * prediction overshoots. That can only ever produce a spurious SHOW — a
   * redundant stand-in beneath a visible band, cleared by the next event —
   * never the false hide that leaves Projects unreachable, which is the bug
   * this whole affordance exists to prevent. Do not "correct" the overshoot
   * in a way that trades it for the false hide.
   */
  readonly scrollDelta: number;
}

export function shouldShowProjectsPin(
  metrics: ProjectsPinVisibilityMetrics,
): boolean {
  if (metrics.controlsHeight <= 0) return false;
  const predictedTop = metrics.controlsTop - metrics.scrollDelta;
  return predictedTop >= metrics.hostBottom - 1;
}
