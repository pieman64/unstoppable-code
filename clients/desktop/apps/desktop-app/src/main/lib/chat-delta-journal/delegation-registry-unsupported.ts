import { DelegationRegistryOperationError } from './delegation-registry-error';

/** Typed temporary failure, never silently fabricated canonical state. */
export class DelegationRegistryNotImplementedError extends DelegationRegistryOperationError {
  public constructor() {
    super({
      code: 'unsupported_format',
      message: 'Delegation registry not implemented in A0',
      retryable: false,
    });
    this.name = 'DelegationRegistryNotImplementedError';
  }
}
