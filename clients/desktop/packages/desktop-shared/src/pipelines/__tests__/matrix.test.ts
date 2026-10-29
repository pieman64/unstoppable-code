import {
  createMatrixPhysicalJobId,
  expandStaticMatrix,
  MAX_MATRIX_FILTER_ENTRIES,
  normalizeMatrixStrategy,
} from '../matrix';
import { normalizePipeline } from '../normalize-pipeline';
import { parsePipelineText } from '../parse-pipeline';
import {
  materializeInitialJobs,
  refreshJobGroup,
} from '../../node/pipelines/executor/job-scheduler';

function isPipelineFixture(
  value: unknown,
): value is Parameters<typeof normalizePipeline>[0] {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseUncheckedPipelineFixture(
  value: unknown,
): Parameters<typeof normalizePipeline>[0] {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isPipelineFixture(parsed)) {
    throw new Error('Expected pipeline fixture');
  }
  return parsed;
}

describe('pipeline matrices', () => {
  it('expands axes in declaration order', () => {
    const strategy = normalizeMatrixStrategy('test', {
      matrix: {
        os: ['macos', 'windows'],
        node: [20, 22],
      },
    });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([
      { os: 'macos', node: 20 },
      { os: 'macos', node: 22 },
      { os: 'windows', node: 20 },
      { os: 'windows', node: 22 },
    ]);
  });

  it('applies partial excludes and ordered includes', () => {
    const strategy = normalizeMatrixStrategy('test', {
      matrix: {
        os: ['macos', 'windows'],
        version: [1, 2],
        exclude: [{ os: 'windows', version: 1 }],
        include: [
          { os: 'macos', label: 'native' },
          { os: 'macos', label: 'preferred' },
          { os: 'linux', version: 3, label: 'extra' },
        ],
      },
    });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([
      { os: 'macos', version: 1, label: 'preferred' },
      { os: 'macos', version: 2, label: 'preferred' },
      { os: 'windows', version: 2 },
      { os: 'linux', version: 3, label: 'extra' },
    ]);
  });

  it('does not merge later includes into earlier standalone entries', () => {
    const strategy = normalizeMatrixStrategy('test', {
      matrix: {
        fruit: ['apple', 'pear'],
        include: [
          { fruit: 'banana', animal: 'monkey' },
          { fruit: 'banana', color: 'yellow' },
        ],
      },
    });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([
      { fruit: 'apple' },
      { fruit: 'pear' },
      { fruit: 'banana', animal: 'monkey' },
      { fruit: 'banana', color: 'yellow' },
    ]);
  });

  it('preserves duplicate and structured values', () => {
    const strategy = normalizeMatrixStrategy('test', {
      matrix: {
        value: [null, null, { nested: [true, 2] }],
      },
    });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([
      { value: null },
      { value: null },
      { value: { nested: [true, 2] } },
    ]);
  });

  it('treats include-only entries as distinct standalone variants', () => {
    const strategy = normalizeMatrixStrategy('test', {
      matrix: {
        include: [{ target: 'one' }, { target: 'two' }],
      },
    });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([
      { target: 'one' },
      { target: 'two' },
    ]);
  });

  it('expands an empty definition to zero variants', () => {
    const strategy = normalizeMatrixStrategy('test', { matrix: {} });
    expect(strategy && expandStaticMatrix('test', strategy)).toEqual([]);
  });

  it('recognizes dynamic fields without evaluating them', () => {
    expect(
      normalizeMatrixStrategy('test', {
        matrix: {
          target: '${{ parseJson(needs.prepare.outputs.targets) }}',
          provider: ['claude', 'codex'],
        },
        fail_fast: false,
        max_parallel: 2,
      }),
    ).toMatchObject({ dynamic: true, fail_fast: false, max_parallel: 2 });
  });

  it('validates axis names and concurrency', () => {
    expect(() =>
      normalizeMatrixStrategy('test', { matrix: { 'bad-key': [1] } }),
    ).toThrow('axis "bad-key"');
    expect(() =>
      normalizeMatrixStrategy('test', {
        matrix: { item: [1] },
        max_parallel: 257,
      }),
    ).toThrow('1 through 256');
  });

  it('rejects a __proto__ axis parsed from YAML', () => {
    const parsed = parsePipelineText(
      [
        'name: Reserved matrix axis',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    strategy:',
        '      matrix:',
        '        __proto__: [safe]',
        '    steps:',
        '      - run: echo test',
      ].join('\n'),
    );

    expect(() => normalizePipeline(parsed)).toThrow(
      'strategy.matrix axis "__proto__" is reserved',
    );
  });

  it('rejects a __proto__ job key parsed from YAML', () => {
    const parsed = parsePipelineText(
      [
        'name: Reserved job key',
        'on: dispatch',
        'jobs:',
        '  __proto__:',
        '    steps:',
        '      - run: echo unsafe',
      ].join('\n'),
    );

    expect(() => normalizePipeline(parsed)).toThrow(
      'Job key "__proto__" is reserved',
    );
  });

  it('generates stable physical IDs', () => {
    expect(createMatrixPhysicalJobId('review', 12)).toBe(
      '__matrix__review__12',
    );
  });

  it('rejects a static matrix that exceeds the per-execution generation cap', () => {
    expect(() =>
      expandStaticMatrix('oversized', {
        dynamic: false,
        matrix: {
          first: Array.from({ length: 17 }, (_, index) => index),
          second: Array.from({ length: 17 }, (_, index) => index),
        },
      }),
    ).toThrow('matrix generates more than 256 variants');
  });

  it('rejects oversized products before materializing the next axis', () => {
    const firstAxis = Array.from({ length: 256 }, (_, index) => index);
    const secondAxis = Array.from({ length: 100_000 }, (_, index) => index);
    expect(() =>
      expandStaticMatrix('oversized-product', {
        dynamic: false,
        matrix: { first: firstAxis, second: secondAxis },
      }),
    ).toThrow('matrix generates more than 256 variants');
  });

  it('rejects excessive singleton axes before expanding them', () => {
    const matrix = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `axis_${String(index)}`,
        [index],
      ]),
    );
    expect(() =>
      expandStaticMatrix('oversized-axes', {
        dynamic: false,
        matrix,
      }),
    ).toThrow('matrix defines more than 256 axes');
  });

  it('rejects oversized include lists before cloning entries', () => {
    const include = Array.from(
      { length: MAX_MATRIX_FILTER_ENTRIES + 1 },
      (_, index) => ({ variant: index }),
    );
    expect(() =>
      normalizeMatrixStrategy('oversized-include', {
        matrix: { include },
      }),
    ).toThrow('strategy.matrix.include cannot contain more than 256 entries');
  });

  it('rejects oversized exclude lists before comparison work', () => {
    const exclude = Array.from(
      { length: MAX_MATRIX_FILTER_ENTRIES + 1 },
      (_, index) => ({ variant: index }),
    );
    expect(() =>
      normalizeMatrixStrategy('oversized-exclude', {
        matrix: { variant: [1], exclude },
      }),
    ).toThrow('strategy.matrix.exclude cannot contain more than 256 entries');
  });

  it('keeps a failed matrix group nonterminal until every variant settles', () => {
    const materialized = materializeInitialJobs(
      normalizePipeline({
        name: 'Mixed matrix state',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { variant: ['failed', 'paused'] } },
            steps: [{ run: 'echo test' }],
          },
        },
      }),
    );
    materialized.jobs.__matrix__build__0.status = 'failure';
    materialized.jobs.__matrix__build__0.outcome = 'failure';
    materialized.jobs.__matrix__build__0.conclusion = 'failure';
    materialized.jobs.__matrix__build__1.status = 'paused';

    const group = refreshJobGroup(
      {
        jobs: materialized.jobs,
        job_groups: materialized.jobGroups,
      },
      'build',
    );

    expect(group).toMatchObject({
      status: 'paused',
      outcome: 'failure',
    });
    expect(group.conclusion).toBeUndefined();
  });

  it('preserves failed status when continue_on_error allows success', () => {
    const materialized = materializeInitialJobs(
      normalizePipeline({
        name: 'Allowed matrix failure',
        on: 'dispatch',
        jobs: {
          build: {
            strategy: { matrix: { variant: ['allowed_failure', 'pass'] } },
            steps: [{ run: 'echo test' }],
          },
        },
      }),
    );
    materialized.jobs.__matrix__build__0.status = 'failure';
    materialized.jobs.__matrix__build__0.outcome = 'failure';
    materialized.jobs.__matrix__build__0.conclusion = 'success';
    materialized.jobs.__matrix__build__1.status = 'success';
    materialized.jobs.__matrix__build__1.outcome = 'success';
    materialized.jobs.__matrix__build__1.conclusion = 'success';

    const group = refreshJobGroup(
      {
        jobs: materialized.jobs,
        job_groups: materialized.jobGroups,
      },
      'build',
    );

    expect(group).toMatchObject({
      status: 'failure',
      outcome: 'failure',
      conclusion: 'success',
    });
  });

  it('enforces the generation cap across static matrix groups', () => {
    const values = Array.from({ length: 129 }, (_, index) => index);
    expect(() =>
      materializeInitialJobs(
        normalizePipeline({
          name: 'Oversized execution',
          on: 'dispatch',
          jobs: {
            first: {
              strategy: { matrix: { value: values } },
              steps: [{ run: 'echo first' }],
            },
            second: {
              strategy: { matrix: { value: values } },
              steps: [{ run: 'echo second' }],
            },
          },
        }),
      ),
    ).toThrow('execution limit is 256');
  });

  it('normalizes strategy and rejects removed source fields', () => {
    const pipeline = normalizePipeline({
      name: 'Matrix',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: {
            matrix: { track: ['security', 'quality'] },
            max_parallel: 1,
          },
          continue_on_error: '${{ matrix.track == "quality" }}',
          steps: [{ run: 'echo ok' }],
        },
      },
    });
    expect(pipeline.jobs.review.strategy).toMatchObject({
      fail_fast: true,
      max_parallel: 1,
      dynamic: false,
    });
    expect(pipeline.jobs.review.continue_on_error_expression).toBe(
      '${{ matrix.track == "quality" }}',
    );

    expect(() =>
      normalizePipeline(
        parseUncheckedPipelineFixture({
          name: 'Legacy',
          on: 'dispatch',
          jobs: {
            review: {
              foreach: [1],
              max_parallel: 1,
              steps: [{ run: 'echo ok' }],
            },
          },
        }),
      ),
    ).toThrow(/uses removed field "foreach"[\s\S]*legacy top-level/);
  });
});
