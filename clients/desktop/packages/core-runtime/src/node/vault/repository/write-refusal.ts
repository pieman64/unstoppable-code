import { zeroBytes } from './zero-bytes';

/** Internal context for a refused put or delete; never a branch for callers. */
export interface VaultWriteRefusal<Step extends string> {
  readonly step: Step;
}

/** Restores admission when a write that closed it is not accepted. */
export interface VaultClosure {
  reopen(): void;
}

interface VaultRefusalEffects {
  /** Null when the write closed nothing, or fails closed. */
  readonly closure: VaultClosure | null;
  /** The write's own copy of its secret. */
  readonly material: Uint8Array | null;
}

/**
 * The one path for every put or delete that is not accepted: it reopens what
 * the write closed, zeroes its material and reports the step, so refusals
 * differ only in that step.
 */
export function refuseVaultWrite<Step extends string, T>(
  observer: ((refusal: VaultWriteRefusal<Step>) => void) | undefined,
  step: Step,
  effects: VaultRefusalEffects,
  result: T | TypeError,
): Promise<T> {
  effects.closure?.reopen();
  if (effects.material) zeroBytes(effects.material);
  try {
    observer?.(Object.freeze({ step }));
  } catch {
    // An observer cannot change how a refusal reads.
  }
  return result instanceof TypeError
    ? Promise.reject(result)
    : Promise.resolve(result);
}
