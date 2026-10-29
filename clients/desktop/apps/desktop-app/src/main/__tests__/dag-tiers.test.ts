import { computeDagTiers } from '../../renderer/src/components/activity/dag-tiers';
import type { NormalizedJob } from '@canopy/desktop-shared/pipelines/types';

function makeJob(name: string, needs: string[] = []): NormalizedJob {
  return {
    name,
    needs,
    env: undefined,
    outputs: undefined,
    timeout_minutes: 30,
    max_retries: 0,
    continue_on_error: false,
    steps: [],
  };
}

describe('computeDagTiers', () => {
  it('returns empty array for no jobs', () => {
    expect(computeDagTiers({})).toEqual([]);
  });

  it('puts all independent jobs into tier 0', () => {
    const jobs: Record<string, NormalizedJob> = {
      a: makeJob('A'),
      b: makeJob('B'),
      c: makeJob('C'),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('sorts a linear chain into sequential tiers', () => {
    const jobs: Record<string, NormalizedJob> = {
      first: makeJob('First'),
      second: makeJob('Second', ['first']),
      third: makeJob('Third', ['second']),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toEqual(['first']);
    expect(tiers[1]).toEqual(['second']);
    expect(tiers[2]).toEqual(['third']);
  });

  it('handles diamond DAG correctly', () => {
    // [a] -> [b, c] -> [d]
    const jobs: Record<string, NormalizedJob> = {
      a: makeJob('A'),
      b: makeJob('B', ['a']),
      c: makeJob('C', ['a']),
      d: makeJob('D', ['b', 'c']),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toEqual(['a']);
    expect(tiers[1].sort()).toEqual(['b', 'c']);
    expect(tiers[2]).toEqual(['d']);
  });

  it('handles the spec example DAG', () => {
    // [research, discovery] -> [plan] -> [implement] -> [test_a, test_b] -> [summary]
    const jobs: Record<string, NormalizedJob> = {
      research: makeJob('research'),
      discovery: makeJob('discovery'),
      plan: makeJob('plan', ['research', 'discovery']),
      implement: makeJob('implement', ['plan']),
      test_a: makeJob('test_a', ['implement']),
      test_b: makeJob('test_b', ['implement']),
      summary: makeJob('summary', ['test_a', 'test_b']),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(5);
    expect(tiers[0].sort()).toEqual(['discovery', 'research']);
    expect(tiers[1]).toEqual(['plan']);
    expect(tiers[2]).toEqual(['implement']);
    expect(tiers[3].sort()).toEqual(['test_a', 'test_b']);
    expect(tiers[4]).toEqual(['summary']);
  });

  it('handles multi-parent dependency where one parent is an ancestor of the other', () => {
    // root -> a -> b, and c depends on both a and b:
    // [root] -> [a] -> [b]
    //              \------^
    // and [c] -> [a, b]
    const jobs: Record<string, NormalizedJob> = {
      root: makeJob('root'),
      a: makeJob('a', ['root']),
      b: makeJob('b', ['a']),
      c: makeJob('c', ['a', 'b']),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(4);
    expect(tiers[0]).toEqual(['root']);
    expect(tiers[1]).toEqual(['a']);
    expect(tiers[2]).toEqual(['b']);
    expect(tiers[3]).toEqual(['c']);
  });

  it('puts a single job into tier 0', () => {
    const jobs: Record<string, NormalizedJob> = {
      only: makeJob('Only'),
    };
    const tiers = computeDagTiers(jobs);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toEqual(['only']);
  });

  it('does not stack-overflow on cyclic dependencies', () => {
    const jobs: Record<string, NormalizedJob> = {
      a: makeJob('A', ['b']),
      b: makeJob('B', ['a']),
    };
    expect(() => computeDagTiers(jobs)).not.toThrow();
    const tiers = computeDagTiers(jobs);
    expect(tiers.length).toBeGreaterThanOrEqual(1);
  });

  it('handles dangling dependency references gracefully', () => {
    const jobs: Record<string, NormalizedJob> = {
      a: makeJob('A', ['missing']),
      b: makeJob('B'),
    };
    expect(() => computeDagTiers(jobs)).not.toThrow();
    const tiers = computeDagTiers(jobs);
    expect(tiers.length).toBeGreaterThanOrEqual(1);
  });
});
