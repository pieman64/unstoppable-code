/** A bounded main-process policy denial, distinct from a transport failure. */
export class ResourceContextUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Resource unavailable (${reason})`);
    this.name = 'ResourceContextUnavailableError';
  }
}
