/** Explicit local runner; not imported by ordinary CI test discovery. Unrun draft. */
import { isDeepStrictEqual } from 'node:util';
import {
  runW3RealOracle,
  w3FixedSeedEdits,
  type W3DriverObservation,
} from './w3-real-oracle-driver';

export async function qualifyW3Locally(): Promise<
  readonly W3DriverObservation[]
> {
  return runW3RealOracle({
    edits: w3FixedSeedEdits(100, 0x5733),
    computeDerived: true,
    assertEqual: (actual, expected, context): void => {
      if (!isDeepStrictEqual(actual, expected))
        throw new Error(`W3 oracle mismatch ${context}`);
    },
  });
}
