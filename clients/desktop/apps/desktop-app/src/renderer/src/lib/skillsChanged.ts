/**
 * Dispatched after a local skill mutation. Discovery, the Installed Skills
 * list, and the publisher catalog each own a separate inventory instance and
 * refresh on it. Older dispatchers send a plain `Event` of this type.
 */
export const SKILLS_CHANGED_EVENT = 'canopy:skills-changed';

/**
 * A skills-changed notification that listeners can attach their refresh to,
 * so the sender can wait until every inventory shows the change.
 */
class SkillsChangedEvent extends Event {
  readonly refreshes: Promise<unknown>[] = [];

  constructor() {
    super(SKILLS_CHANGED_EVENT);
  }
}

/** Attaches a listener's inventory refresh to the event it is handling. */
export function trackSkillsRefresh(
  event: Event,
  refresh: Promise<unknown>,
): void {
  if (event instanceof SkillsChangedEvent) event.refreshes.push(refresh);
  else void refresh.catch(() => undefined);
}

/**
 * Announces a skill mutation and resolves once every listener that tracked a
 * refresh has finished it. Legacy callers settle failures; update actions can
 * opt in to rejection to distinguish a committed update from a refresh failure.
 */
export async function notifySkillsChanged(
  options: { rejectOnFailure?: boolean } = {},
): Promise<void> {
  const event = new SkillsChangedEvent();
  window.dispatchEvent(event);
  const results = await Promise.allSettled(event.refreshes);
  if (options.rejectOnFailure) {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
