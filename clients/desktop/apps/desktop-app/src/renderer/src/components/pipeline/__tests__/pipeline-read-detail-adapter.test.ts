import type {
  NormalizedPipeline,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import { toPipelineRunDefinitionViewModel } from '@canopy/desktop-shared/pipelines/pipeline-read-detail-adapter';
import { toPipelineDefinitionViewModel } from '../pipeline-read-detail-adapter';

describe('toPipelineDefinitionViewModel', () => {
  it('projects desktop definitions in their declared order', () => {
    const pipeline: Pipeline = {
      name: 'Release',
      description: 'Ship it',
      version: '3',
      icon: '🚀',
      on: { dispatch: {}, plan_ready: {} },
      scope: ['global', 'worktree'],
      jobs: {
        test: { steps: [{ name: 'Test', run: 'npm test\n--ci' }] },
        ship: {
          needs: 'test',
          steps: [{ id: 'publish', uses: 'builtin/agent-prompt' }],
        },
      },
    };
    expect(toPipelineDefinitionViewModel(pipeline)).toMatchObject({
      name: 'Release',
      triggerSummary: 'Manual, Plan ready',
      scopes: ['global', 'worktree'],
      jobs: [
        {
          id: 'test',
          steps: [
            { id: 'test-step-1', kind: 'script', usesSummary: 'npm test' },
          ],
        },
        {
          id: 'ship',
          dependencies: ['test'],
          steps: [
            {
              id: 'publish',
              kind: 'action',
              usesSummary: 'builtin/agent-prompt',
            },
          ],
        },
      ],
    });
    expect(toPipelineDefinitionViewModel(pipeline).canonicalYaml).toContain(
      'name: Release',
    );
  });

  it('falls back to no scopes when a definition declares duplicate scopes', () => {
    const pipeline: Pipeline = {
      name: 'Invalid scopes',
      on: 'dispatch',
      scope: ['directory', 'directory'],
      jobs: {
        review: { steps: [{ run: 'npm test' }] },
      },
    };

    expect(() => toPipelineDefinitionViewModel(pipeline)).not.toThrow();
    expect(toPipelineDefinitionViewModel(pipeline).scopes).toEqual([]);
  });

  it('keeps alias-heavy repository YAML bounded without recursively expanding aliases', () => {
    const pipeline = parsePipelineText(`
name: Alias heavy
on: dispatch
env:
  seed: &seed [aaaaaaaaaa, aaaaaaaaaa, aaaaaaaaaa, aaaaaaaaaa]
  level1: &level1 [*seed, *seed, *seed, *seed, *seed, *seed, *seed, *seed]
  level2: &level2 [*level1, *level1, *level1, *level1, *level1, *level1, *level1, *level1]
  level3: &level3 [*level2, *level2, *level2, *level2, *level2, *level2, *level2, *level2]
  level4: [*level3, *level3, *level3, *level3, *level3, *level3, *level3, *level3]
jobs:
  test:
    steps:
      - run: npm test
`);

    const result = toPipelineDefinitionViewModel(pipeline);

    expect(
      new TextEncoder().encode(result.canonicalYaml).byteLength,
    ).toBeLessThan(10_000);
    expect(result.canonicalYaml).toContain('&ref_');
    expect(result.canonicalYamlTruncated).not.toBe(true);
  });

  it('keeps canonical YAML complete regardless of the portal transfer budget', () => {
    const largeValue = 'x'.repeat(300_000);
    const pipeline: Pipeline = {
      name: 'Large',
      on: 'dispatch',
      env: { LARGE_VALUE: largeValue },
      jobs: { test: { steps: [{ run: 'npm test' }] } },
    };

    const result = toPipelineDefinitionViewModel(pipeline);

    expect(result.canonicalYaml).toContain(largeValue);
    expect(result.canonicalYamlTruncated).not.toBe(true);
  });
  it('row-bounds canonical YAML for pathologically large pipelines', () => {
    const jobs: Pipeline['jobs'] = {};
    for (let index = 0; index < 4_000; index += 1) {
      jobs[`job-${index}`] = { steps: [{ run: `echo ${index}` }] };
    }
    const pipeline: Pipeline = { name: 'Huge', on: 'dispatch', jobs };

    const started = Date.now();
    const result = toPipelineDefinitionViewModel(pipeline);
    const elapsedMs = Date.now() - started;

    expect(result.canonicalYamlTruncated).toBe(true);
    expect(result.canonicalYaml).toContain('job-0');
    expect(result.canonicalYaml).not.toContain('job-3999');
    expect(result.jobs).toHaveLength(4_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('keeps alias-expanded non-string step fields out of the view model', () => {
    const pipeline = parsePipelineText(`
name: Alias uses
on: dispatch
jobs:
  test:
    steps:
      - uses: &bomb [x, x, x, x, x, x, x, x]
      - uses: [*bomb, *bomb, *bomb, *bomb, *bomb, *bomb, *bomb, *bomb]
        name: 2
      - run: { nested: value }
`);

    const result = toPipelineDefinitionViewModel(pipeline);
    const steps = result.jobs[0].steps;

    expect(steps.map((step) => step.usesSummary)).toEqual([
      'Not configured',
      'Not configured',
      'Not configured',
    ]);
    expect(steps.map((step) => step.kind)).toEqual([
      'incomplete',
      'incomplete',
      'incomplete',
    ]);
    expect(
      new TextEncoder().encode(JSON.stringify(steps)).byteLength,
    ).toBeLessThan(2_000);
  });
});

describe('toPipelineRunDefinitionViewModel', () => {
  const snapshot: NormalizedPipeline = {
    name: 'Release',
    description: 'Ship it',
    scope: ['worktree'],
    jobs: {
      test: {
        name: 'Test',
        needs: [],
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [
          {
            id: 'unit',
            run: 'npm test\n--ci',
            shell: 'bash',
            continue_on_error: false,
            timeout_minutes: 30,
            skip_on_missing_action: false,
          },
        ],
      },
      ship: {
        name: 'Ship',
        needs: ['test'],
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [
          {
            id: 'publish',
            name: 'Publish',
            uses: 'builtin/agent-prompt',
            shell: 'bash',
            continue_on_error: false,
            timeout_minutes: 30,
            skip_on_missing_action: false,
          },
        ],
      },
    },
  };

  it("projects a run's recorded snapshot like a definition", () => {
    const result = toPipelineRunDefinitionViewModel(snapshot);
    expect(result).toMatchObject({
      name: 'Release',
      description: 'Ship it',
      // The normalized snapshot keeps no triggers.
      triggerSummary: '',
      scopes: ['worktree'],
      jobs: [
        {
          id: 'test',
          name: 'Test',
          dependencies: [],
          steps: [{ id: 'unit', kind: 'script', usesSummary: 'npm test' }],
        },
        {
          id: 'ship',
          name: 'Ship',
          dependencies: ['test'],
          steps: [
            {
              id: 'publish',
              name: 'Publish',
              kind: 'action',
              usesSummary: 'builtin/agent-prompt',
            },
          ],
        },
      ],
    });
    expect(result.canonicalYaml).toContain('name: Release');
    expect(result.canonicalYamlTruncated).not.toBe(true);
  });

  it('row-bounds the canonical YAML of a very large snapshot', () => {
    const jobs: NormalizedPipeline['jobs'] = {};
    for (let index = 0; index < 4_000; index += 1) {
      jobs[`job-${index}`] = {
        name: `job-${index}`,
        needs: [],
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [],
      };
    }
    const result = toPipelineRunDefinitionViewModel({
      name: 'Huge',
      scope: ['directory'],
      jobs,
    });
    expect(result.canonicalYamlTruncated).toBe(true);
    expect(result.canonicalYaml).not.toContain('job-3999');
    expect(result.jobs).toHaveLength(4_000);
  });
});
