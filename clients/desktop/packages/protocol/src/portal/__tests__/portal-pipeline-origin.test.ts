import { projectPortalPipelineMetadata } from '../index';

/**
 * CAN-3021 widened {@link PortalPipelineOrigin} with `'shared'` so the desktop
 * can produce cloud pipeline rows into the per-worktree inventory document the
 * plan picker reads.
 *
 * The projector is the browser-facing narrowing step for every one of those
 * rows, and it silently drops an origin it does not recognise. That is the
 * deliberate forward-compatibility behavior — an unknown value degrades to
 * "project" at the consumer rather than escaping the union — but it is also
 * exactly what would have swallowed `'shared'` on an older web deployment, so
 * both halves are pinned here.
 */
describe('projectPortalPipelineMetadata origin', () => {
  it.each(['bundled', 'user', 'project', 'shared'] as const)(
    'preserves the known origin %s',
    (origin) => {
      expect(projectPortalPipelineMetadata({ origin }).origin).toBe(origin);
    },
  );

  it.each([
    ['unknown string', 'org'],
    ['empty string', ''],
    ['wrong case', 'Shared'],
    ['number', 7],
    ['null', null],
  ])('drops an unrecognised origin (%s)', (_label, origin) => {
    const projected = projectPortalPipelineMetadata({ origin });
    expect(projected.origin).toBeUndefined();
  });

  it('carries plan_ready inputs alongside a shared origin', () => {
    // The plan picker hydrates a shared row's inputs through
    // `portal.pipeline.get`, and they come back through this same projector.
    const projected = projectPortalPipelineMetadata({
      origin: 'shared',
      planReadyInputs: {
        environment: {
          type: 'choice',
          required: true,
          options: ['staging', 'production'],
        },
      },
    });
    expect(projected.origin).toBe('shared');
    expect(projected.planReadyInputs?.environment).toEqual({
      type: 'choice',
      required: true,
      options: ['staging', 'production'],
    });
  });
});
