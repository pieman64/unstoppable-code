const eventReceiptTimes: WeakMap<object, number> = new WeakMap();

export function recordEventReceiptTime(
  event: object,
  monotonicMs: number,
): void {
  eventReceiptTimes.set(event, monotonicMs);
}

export function takeEventReceiptTime(event: object): number | undefined {
  const monotonicMs = eventReceiptTimes.get(event);
  eventReceiptTimes.delete(event);
  return monotonicMs;
}
