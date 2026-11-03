import type { W5WireCall } from './w5-boundary-operation';

export type { W5WireCall } from './w5-boundary-operation';

/** The receipt caller of a keyed lifecycle run from `source`. */
export function w5LifecycleReceiptCaller(
  source: string,
  wireCall: W5WireCall | undefined,
): string {
  return wireCall?.caller ?? `desktop-host:${source}`;
}
