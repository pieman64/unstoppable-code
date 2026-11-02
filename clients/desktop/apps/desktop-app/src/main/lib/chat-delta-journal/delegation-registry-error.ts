import type { DelegationRegistryFailure } from './delegation-registry-api';

/** Engine domain error; adapters preserve failure verbatim, without message matching. */
export class DelegationRegistryOperationError extends Error {
  public constructor(public readonly failure: DelegationRegistryFailure) {
    super(failure.message);
    this.name = 'DelegationRegistryOperationError';
  }
}
