interface ClosestCapableTarget {
  closest: (selector: string) => unknown;
}

function hasClosestMethod(value: unknown): value is ClosestCapableTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'closest' in value &&
    typeof value.closest === 'function'
  );
}

/** Whether an event target sits inside an integrated-terminal pane. */
export function isTerminalTarget(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  return target.closest('.xterm, .canopy-terminal-host') !== null;
}
