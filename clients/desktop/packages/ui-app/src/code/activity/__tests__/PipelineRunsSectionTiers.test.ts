/**
 * CAN-2511 — the Remote Control pipeline preview must group job dots by
 * dependency tier, matching the desktop. Tommy reported it rendering one flat
 * group with no concurrency-based gaps, because `buildDagInputs` hardcoded a
 * single tier.
 */
import { buildDagInputs } from '../sections/PipelineRunsSection';
import type { PortalPipelineRunJob } from '@canopy/protocol/portal';

function job(
  jobId: string,
  needs?: string[],
  status = 'success',
): PortalPipelineRunJob {
  return {
    jobId,
    name: jobId,
    status,
    ...(needs ? { needs } : {}),
    steps: [],
  };
}

describe('buildDagInputs tiers', () => {
  it('returns no tiers for an absent or empty job list', () => {
    expect(buildDagInputs(undefined).tiers).toEqual([]);
    expect(buildDagInputs([]).tiers).toEqual([]);
  });

  it('groups independent jobs into one tier', () => {
    const { tiers } = buildDagInputs([job('a', []), job('b', [])]);
    expect(tiers).toEqual([['a', 'b']]);
  });

  it('splits dependent jobs into successive tiers', () => {
    const { tiers } = buildDagInputs([
      job('build', []),
      job('test', ['build']),
      job('lint', ['build']),
      job('publish', ['test', 'lint']),
    ]);
    expect(tiers).toEqual([['build'], ['test', 'lint'], ['publish']]);
  });

  it('places a job after its deepest dependency', () => {
    const { tiers } = buildDagInputs([
      job('a', []),
      job('b', ['a']),
      job('c', ['a', 'b']),
    ]);
    expect(tiers).toEqual([['a'], ['b'], ['c']]);
  });

  it('falls back to a single tier when NO job carries needs (older desktop)', () => {
    // Distinct from "every job has needs: []" — with no dependency data at all,
    // claiming everything is parallel would be a guess.
    const { tiers } = buildDagInputs([job('a'), job('b'), job('c')]);
    expect(tiers).toEqual([['a', 'b', 'c']]);
  });

  it('treats a job with needs omitted as dependency-free once any job has needs', () => {
    const { tiers } = buildDagInputs([job('a'), job('b', ['a'])]);
    expect(tiers).toEqual([['a'], ['b']]);
  });

  it('ignores dependencies on jobs absent from the run', () => {
    // A dependency that never expanded must not push its dependents down a
    // tier and leave a leading empty group.
    const { tiers } = buildDagInputs([job('a', ['ghost']), job('b', ['a'])]);
    expect(tiers).toEqual([['a'], ['b']]);
  });

  it('ignores a self-dependency instead of stalling the job', () => {
    const { tiers } = buildDagInputs([job('a', ['a']), job('b', ['a'])]);
    expect(tiers).toEqual([['a'], ['b']]);
  });

  it('never emits an empty tier', () => {
    const { tiers } = buildDagInputs([
      job('a', []),
      job('b', ['a']),
      job('c', ['ghost']),
    ]);
    expect(tiers.every((tier) => tier.length > 0)).toBe(true);
  });

  it('keeps every job represented exactly once across tiers', () => {
    const jobs = [
      job('a', []),
      job('b', ['a']),
      job('c', ['a']),
      job('d', ['b', 'c']),
    ];
    const { tiers } = buildDagInputs(jobs);
    expect(tiers.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still projects job metadata alongside the tiers', () => {
    const { jobs } = buildDagInputs([job('build', [], 'running')]);
    expect(jobs.build).toMatchObject({ jobId: 'build', name: 'build' });
  });
});
