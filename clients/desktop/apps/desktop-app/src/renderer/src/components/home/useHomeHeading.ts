import { useEffect, useState } from 'react';
import { pickHomeHeading } from './homeHeadings';

/**
 * Module-level, ref-counted "held" heading shared across every concurrent
 * `useHomeHeading()` instance.
 *
 * `MainPage` stays mounted (just `hidden`) while the standalone `HomePage`
 * is active (see `App.tsx`), so the embedded `HomeSurface` inside
 * `WorktreePart` / `WorktreeManager`'s empty state and the page `HomeSurface`
 * can both be mounted at once during a Code<->New Task navigation. Picking a
 * fresh phrase per mount (the old behavior) meant that transition visibly
 * re-rolled the heading even though, conceptually, the user never left the
 * Home surface. Instead, the phrase is picked once and HELD for as long as
 * ANY instance is mounted anywhere, and only repicked once the instance
 * count drops to zero (i.e. no Home surface is mounted at all).
 */
let activeInstanceCount = 0;
let heldHeading: string | null = null;

/**
 * Picks a random `HOME_HEADINGS` entry the first time any `HomeSurface`
 * mounts, and holds it for as long as at least one `HomeSurface` instance
 * remains mounted anywhere in the tree — including across a Code-page empty
 * state <-> standalone "New Task" page navigation, since the always-mounted
 * `MainPage` keeps its embedded instance alive underneath the hidden class.
 * Uses `useState`'s lazy initializer (not `useMemo`, which React does not
 * guarantee to preserve across renders) so the heading is guaranteed stable
 * across rerenders of a given instance.
 */
export function useHomeHeading(): string {
  const [heading] = useState<string>(() => {
    if (heldHeading === null) {
      heldHeading = pickHomeHeading();
    }
    return heldHeading;
  });

  useEffect(() => {
    activeInstanceCount += 1;
    // Re-assert in case a sibling instance's unmount cleanup already ran and
    // nulled the held heading between this instance's render (which read or
    // set `heldHeading`) and this effect committing — React can mount a
    // replacement instance and unmount an outgoing one within the same
    // commit, and effect ordering does not guarantee the new mount's effect
    // runs before the old unmount's cleanup.
    heldHeading = heading;

    return (): void => {
      activeInstanceCount -= 1;
      if (activeInstanceCount <= 0) {
        activeInstanceCount = 0;
        heldHeading = null;
      }
    };
  }, [heading]);

  return heading;
}
