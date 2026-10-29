// Changes synchronously whenever an input to watcher delivery authorization
// (the App Advisor access setting, or the account and project owner context)
// may have changed. A delivery compares it across awaits to detect a decision
// that went stale before provider handoff.
let generation = 0;

export function noteWatcherDeliveryAuthorityChange(): void {
  generation += 1;
}

export function watcherDeliveryAuthorityGeneration(): number {
  return generation;
}
