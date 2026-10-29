// Geometry + lane-packing for the Day / Week time grid. Kept separate from the
// component so the pure layout function is unit-testable and so the component
// file only exports components (React Fast Refresh constraint).

import { minutesSinceMidnight } from './calendarDateUtils';
import type { CalendarEventGroup } from './calendarEvents';

/** Pixel height of one hour row. */
export const HOUR_PX = 48;
/** Fixed chip height — fires are zero-duration, so chips are uniform. */
export const EVENT_MIN_PX = 22;

export interface PositionedGroup {
  group: CalendarEventGroup;
  top: number;
  /**
   * Block height. A single fire is `EVENT_MIN_PX`; a condensed group spans from
   * its first to its last fire (at least `EVENT_MIN_PX`) so the block visibly
   * covers the whole window — e.g. an every-5-minutes-throughout-the-hour cron
   * fills most of the hour row.
   */
  height: number;
  /** Lane index within this group's overlap cluster. */
  lane: number;
  /** Lane count of this group's cluster — chips split width only by this. */
  laneCount: number;
}

function blockTopPx(at: Date): number {
  return (minutesSinceMidnight(at) / 60) * HOUR_PX;
}

/**
 * Greedy lane assignment for a single day's groups. A single fire is a fixed
 * `EVENT_MIN_PX` chip; a condensed group is a taller block spanning its first
 * to its last fire. Two blocks overlap when their vertical extents intersect.
 *
 * Lane splitting is scoped to each overlap *cluster* — a maximal run of blocks
 * chained by overlap — not the whole day. A day with one overlapping pair keeps
 * every other (non-overlapping) block full width, so a single split row no
 * longer halves the entire column.
 */
export function layoutDayGroups(
  groups: CalendarEventGroup[],
): PositionedGroup[] {
  const sorted = [...groups].sort(
    (left, right) => left.at.getTime() - right.at.getTime(),
  );

  const positioned: PositionedGroup[] = [];
  let cluster: PositionedGroup[] = [];
  let laneBottoms: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flushCluster = (): void => {
    const laneCount = Math.max(1, laneBottoms.length);
    for (const item of cluster) {
      item.laneCount = laneCount;
    }
    cluster = [];
    laneBottoms = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const group of sorted) {
    const top = blockTopPx(group.at);
    // The block ends at the last fire's time — it must not extend past `endsAt`
    // (e.g. a 12:00–12:55 group ends at 12:55, before 1:00), or consecutive
    // hourly blocks would overlap and get pushed into extra lanes. The minimum
    // height only applies when the true span is shorter than one chip.
    const height = Math.max(EVENT_MIN_PX, blockTopPx(group.endsAt) - top);
    const bottom = top + height;
    // A block that starts at or after every block in the current cluster has
    // ended begins a fresh cluster (no overlap to share lanes with).
    if (cluster.length > 0 && top >= clusterEnd) {
      flushCluster();
    }
    let lane = laneBottoms.findIndex((laneBottom) => laneBottom <= top);
    if (lane === -1) {
      lane = laneBottoms.length;
      laneBottoms.push(bottom);
    } else {
      laneBottoms[lane] = bottom;
    }
    const item: PositionedGroup = { group, top, height, lane, laneCount: 1 };
    cluster.push(item);
    positioned.push(item);
    clusterEnd = Math.max(clusterEnd, bottom);
  }
  if (cluster.length > 0) {
    flushCluster();
  }

  return positioned;
}
