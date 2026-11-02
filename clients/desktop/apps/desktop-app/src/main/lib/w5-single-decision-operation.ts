import {
  createW5SingleDecisionOperation as createCoreW5SingleDecisionOperation,
  type W5SingleDecisionOperation,
} from '@canopy/core-runtime/node/w5/single-decision-operation';
import { IdentifierValidationError } from './validation';
import { runKeyedW5Operation } from './w5-keyed-operation';
import { withStorageAdmission } from './w5-storage';

export type {
  W5SingleDecisionInput,
  W5SingleDecisionOperation,
} from '@canopy/core-runtime/node/w5/single-decision-operation';

/**
 * The core one-decision runner bound to desktop main: a keyed receipt names
 * its caller `desktop-host:<source>`, an invalid identifier is a safe refusal,
 * and storage admission is the shared desktop admission. Each binding resolves
 * at call time, so test spies still intercept.
 */
export function createW5SingleDecisionOperation<Source extends string>(
  isBoundaryRefusal: (error: unknown) => boolean,
): W5SingleDecisionOperation<Source> {
  return createCoreW5SingleDecisionOperation<Source>(
    {
      runKeyed: (input, decode, work) =>
        runKeyedW5Operation(input, decode, work),
      admitStorage: (targets, run) => withStorageAdmission(targets, run),
      caller: (source) => `desktop-host:${source}`,
      isHostRefusal: (error) => error instanceof IdentifierValidationError,
    },
    isBoundaryRefusal,
  );
}
