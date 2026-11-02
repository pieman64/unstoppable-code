/** A bounded main-process policy denial, distinct from a transport failure. */
export class ResourceContextUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Resource unavailable (${reason})`);
    this.name = 'ResourceContextUnavailableError';
  }
}

/**
 * `Resource unavailable (<reason>)` and its per-resource variants, which the
 * resource lanes raise as plain errors. `pipeline` is the noun workflows used
 * before they were renamed.
 */
export const RESOURCE_REFUSAL =
  /^(?:resource|workflow|pipeline|skill|agent|automation|collection|plugin) unavailable \([a-z-]+\)\.?$/i;

/** A resource-context policy denial, typed or raised by a resource lane. */
export function isResourceContextRefusal(error: unknown): boolean {
  return (
    error instanceof ResourceContextUnavailableError ||
    (error instanceof Error && RESOURCE_REFUSAL.test(error.message.trim()))
  );
}
