import type * as ResolutionDependencyIndex from '../resolve/resolution-dependency-index';
import { runW3RealOracle, W3_ADVERSARIAL_EDITS } from './w3-real-oracle-driver';
import { qualifyW3Observation } from './w3-real-oracle-qualification';

describe('W3 actual production resolver differential oracle', () => {
  it('matches literal derived identities across all modes after each edit', async () => {
    const observations = await runW3RealOracle({
      edits: W3_ADVERSARIAL_EDITS,
      computeDerived: true,
      assertEqual: (actual, expected, context): void => {
        expect({ context, value: actual }).toEqual({
          context,
          value: expected,
        });
      },
    });
    expect(observations).toHaveLength((W3_ADVERSARIAL_EDITS.length + 1) * 3);
    for (const observation of observations) qualifyW3Observation(observation);
  }, 120_000);

  it('matches reset/diff/incremental/cold after every bounded adversarial edit', async () => {
    const observations = await runW3RealOracle({
      edits: W3_ADVERSARIAL_EDITS,
      assertEqual: (actual, expected, context): void => {
        expect({ context, value: actual }).toEqual({
          context,
          value: expected,
        });
      },
    });
    expect(observations).toHaveLength((W3_ADVERSARIAL_EDITS.length + 1) * 3);
    for (const observation of observations) qualifyW3Observation(observation);
    // This suite makes no performance claim; assert actual scopes, not timings.
  }, 120_000);

  it('rejects real always-full execution even when literal semantics and dependencies match', async () => {
    const modulePath = '../resolve/resolution-dependency-index';
    let comparisons = 0;
    try {
      jest.doMock(modulePath, () => {
        const actual =
          jest.requireActual<typeof ResolutionDependencyIndex>(modulePath);
        const computeAffectedResolutionClosure: typeof actual.computeAffectedResolutionClosure =
          (index, seeds) => {
            const closure = actual.computeAffectedResolutionClosure(
              index,
              seeds,
            );
            if (closure.mode === 'full') return closure;
            return {
              mode: 'full',
              fallbackReason: 'repository-global-input',
              resetSourceFileIds: undefined,
              dependencyReplacementFileIds: undefined,
              counters: closure.counters,
              fullPassInspectedSourceFiles: null,
            };
          };
        return { ...actual, computeAffectedResolutionClosure };
      });
      await jest.isolateModulesAsync(async () => {
        const driver = await import('./w3-real-oracle-driver');
        const observations = await driver.runW3RealOracle({
          edits: driver.W3_ADVERSARIAL_EDITS,
          assertEqual: (actual, expected, context): void => {
            expect({ context, value: actual }).toEqual({
              context,
              value: expected,
            });
            comparisons += 1;
          },
        });
        expect(observations).toHaveLength(
          (driver.W3_ADVERSARIAL_EDITS.length + 1) * 3,
        );
        expect(comparisons).toBe((driver.W3_ADVERSARIAL_EDITS.length + 1) * 4);
        const supported = observations.find(
          (observation) =>
            observation.mode === 'incremental' && observation.step === 2,
        );
        if (supported === undefined)
          throw new Error('Missing actual supported-step observation');
        expect(() => qualifyW3Observation(supported)).toThrow(
          '2:ambiguity-to-unresolved:fixture: expected incremental strict-subset closure; got full',
        );
      });
    } finally {
      // isolateModulesAsync discards the control module graph; remove its mock
      // registration too, leaving the already imported positive driver intact.
      jest.dontMock(modulePath);
    }
  }, 120_000);
});
