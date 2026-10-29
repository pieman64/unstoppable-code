/**
 * E2E-only React work counters for the desktop performance harness.
 *
 * React reports every commit to `__REACT_DEVTOOLS_GLOBAL_HOOK__` if one
 * exists when `react-dom` loads. This module installs a minimal hook that
 * counts commits and the fibers that performed work in each (React sets the
 * `PerformedWork` flag on a component fiber whose render function ran), and
 * exposes `window.__CANOPY_REACT_WORK__` so the harness can read and reset
 * the counts.
 *
 * It is never imported by the renderer bundle. E2E builds inject it as a
 * classic inline script ahead of the module entry (see
 * `apps/desktop-app/src/main/build/renderer-react-work-hook.ts`): a preload
 * runs in an isolated world `react-dom` cannot see, and a module import would
 * run after the vendor chunk. Production builds never inject it, the
 * `__CANOPY_E2E__` guard compiles the installer to a no-op, and the
 * production renderer build fails if its output installs a hook.
 */

/** React's `PerformedWork` fiber flag (`ReactFiberFlags`). */
const PERFORMED_WORK = 0b1;

const DEVTOOLS_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

export interface ReactWorkCounters {
  commits: number;
  performedWorkFibers: number;
}

export interface ReactWorkMilestones {
  /**
   * `performance.now()` at the page's first commit: the J1 journey's React
   * mount milestone. Page-lifetime, so a counter reset keeps it.
   */
  firstCommitAtMs?: number;
}

export interface ReactWorkSnapshot {
  /** Changes on every reset and page load, so resets are detectable. */
  generation: string;
  counters: ReactWorkCounters;
  milestones: ReactWorkMilestones;
}

export interface ReactWorkQuery {
  snapshot(): ReactWorkSnapshot;
  reset(): ReactWorkSnapshot;
}

export interface ReactWorkDevtoolsHook {
  readonly supportsFiber: true;
  readonly isDisabled: false;
  inject(internals: unknown): number;
  onCommitFiberRoot(...args: unknown[]): void;
}

interface FiberLike {
  flags: number;
  child: unknown;
  sibling: unknown;
  alternate: unknown;
}

function isFiberLike(value: unknown): value is FiberLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'flags' in value &&
    typeof value.flags === 'number' &&
    'child' in value &&
    'sibling' in value &&
    'alternate' in value
  );
}

/**
 * Fibers in a committed root that performed work in that commit. A child list
 * shared with the previous commit belongs to a subtree React reused without
 * rendering, whose flags describe an earlier commit, so it is skipped.
 */
export function countPerformedWorkFibers(root: unknown): number {
  const current: unknown =
    typeof root === 'object' && root !== null && 'current' in root
      ? root.current
      : null;
  if (!isFiberLike(current)) return 0;
  let count = 0;
  const pending: FiberLike[] = [current];
  for (let fiber = pending.pop(); fiber; fiber = pending.pop()) {
    if ((fiber.flags & PERFORMED_WORK) !== 0) count += 1;
    if (isFiberLike(fiber.alternate) && fiber.child === fiber.alternate.child)
      continue;
    for (
      let child: unknown = fiber.child;
      isFiberLike(child);
      child = child.sibling
    ) {
      pending.push(child);
    }
  }
  return count;
}

export function createReactWorkHook(
  now: () => number = (): number => performance.now(),
): {
  hook: ReactWorkDevtoolsHook;
  query: ReactWorkQuery;
} {
  const installation = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let resets = 0;
  let commits = 0;
  let performedWorkFibers = 0;
  let renderers = 0;
  let firstCommitAtMs: number | undefined;
  const snapshot = (): ReactWorkSnapshot => ({
    generation: `${installation}:${resets}`,
    counters: { commits, performedWorkFibers },
    milestones: firstCommitAtMs === undefined ? {} : { firstCommitAtMs },
  });
  return {
    hook: {
      supportsFiber: true,
      isDisabled: false,
      inject: (): number => {
        renderers += 1;
        return renderers;
      },
      onCommitFiberRoot: (...args: unknown[]): void => {
        firstCommitAtMs ??= now();
        commits += 1;
        performedWorkFibers += countPerformedWorkFibers(args[1]);
      },
    },
    query: {
      snapshot,
      reset: (): ReactWorkSnapshot => {
        resets += 1;
        commits = 0;
        performedWorkFibers = 0;
        return snapshot();
      },
    },
  };
}

/**
 * Installs the counting hook and its query on `target` (the page's global
 * object) in E2E builds. Never replaces an existing DevTools hook.
 */
export function installReactWorkHook(target: object): boolean {
  if (!__CANOPY_E2E__) return false;
  if (Reflect.has(target, DEVTOOLS_HOOK_KEY)) return false;
  const { hook, query } = createReactWorkHook();
  Object.defineProperties(target, {
    // Writable, like the DevTools extension's own hook, so a script that
    // replaces it never throws. React keeps the hook it injected into.
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      configurable: true,
      writable: true,
      value: hook,
    },
    __CANOPY_REACT_WORK__: { configurable: true, value: Object.freeze(query) },
  });
  return true;
}
