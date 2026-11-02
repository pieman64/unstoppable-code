import type {
  Pipeline,
  ExecutionState,
  JobResult,
} from '@canopy/desktop-shared/types/pipeline';
import {
  buildDefinitionFlow,
  buildExecutionFlow,
} from '@/lib/pipelineFlowGraph';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';

const pipeline: Pipeline = {
  name: 'demo',
  on: 'dispatch',
  jobs: {
    build: { steps: [{ run: 'npm ci' }] },
    test: { needs: 'build', steps: [{ run: 'npm test' }] },
    deploy: { needs: ['test'], steps: [{ run: 'deploy' }] },
  },
};

describe('buildDefinitionFlow', () => {
  it('creates one job node per job (steps nested in node data)', () => {
    const { nodes } = buildDefinitionFlow(pipeline, [
      'build',
      'test',
      'deploy',
    ]);
    expect(nodes.map((n) => n.id).sort()).toEqual(['build', 'deploy', 'test']);
    expect(nodes.every((n) => n.type === 'pipelineJob')).toBe(true);
    const build = nodes.find((n) => n.id === 'build');
    expect(build?.data.steps).toHaveLength(1);
    expect(build?.data.steps[0]).toMatchObject({
      stepIndex: 0,
      status: 'none',
    });
  });

  it('nests every step as a card inside its job node', () => {
    const multiStep: Pipeline = {
      name: 'multi',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            { id: 'install', name: 'Install', run: 'npm ci' },
            { id: 'unit', name: 'Unit', run: 'npm test' },
          ],
        },
      },
    };
    const { nodes } = buildDefinitionFlow(multiStep, ['build']);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.steps.map((s) => s.label)).toEqual([
      'Install',
      'Unit',
    ]);
  });

  it('creates dependency edges only between jobs (no step edges)', () => {
    const { edges } = buildDefinitionFlow(pipeline, [
      'build',
      'test',
      'deploy',
    ]);
    const pairs = edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toEqual(['build->test', 'test->deploy']);
  });

  it('assigns dagre positions (non-zero spread)', () => {
    const { nodes } = buildDefinitionFlow(pipeline, [
      'build',
      'test',
      'deploy',
    ]);
    const ys = new Set(nodes.map((n) => Math.round(n.position.y)));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('drops edges referencing unknown jobs', () => {
    const broken: Pipeline = {
      name: 'x',
      on: 'dispatch',
      jobs: { a: { needs: 'ghost', steps: [] } },
    };
    const { edges } = buildDefinitionFlow(broken, ['a']);
    expect(edges).toEqual([]);
  });

  it('excludes jobs absent from jobOrder', () => {
    const { nodes, edges } = buildDefinitionFlow(pipeline, ['build']);
    expect(nodes.map((n) => n.id)).toEqual(['build']);
    expect(edges).toEqual([]);
  });

  it('returns empty nodes and edges for empty jobOrder', () => {
    const { nodes, edges } = buildDefinitionFlow(pipeline, []);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

function execState(): ExecutionState {
  const pipelineSnapshot = normalizePipeline({
    name: 'demo',
    on: 'dispatch',
    jobs: {
      build: { steps: [{ id: 's0', run: 'npm ci' }] },
      test: { needs: 'build', steps: [{ id: 's0', run: 'npm test' }] },
    },
  });
  return {
    version: 10,
    id: 'e1',
    pipeline_id: 'p1',
    pipeline_snapshot: pipelineSnapshot,
    status: 'running',
    jobs: {
      build: { status: 'success', steps: {}, outputs: {} },
      test: { status: 'running', steps: {}, outputs: {} },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-06-16T00:00:00Z',
    cwd: '/tmp',
    inputs: {},
    env: {},
  };
}

describe('buildExecutionFlow', () => {
  it('maps job status onto job nodes', () => {
    const { nodes } = buildExecutionFlow(execState(), ['build', 'test']);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.data.status]));
    expect(byId.build).toBe('success');
    expect(byId.test).toBe('running');
  });

  it('keeps dependency edges only between jobs', () => {
    const { edges } = buildExecutionFlow(execState(), ['build', 'test']);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'build->test',
    ]);
  });

  it('defaults missing job results to pending status', () => {
    const s = execState();
    delete s.jobs.test;
    const { nodes } = buildExecutionFlow(s, ['build', 'test']);
    expect(nodes.find((n) => n.id === 'test')?.data.status).toBe('pending');
  });

  it('renders job nodes only (no nested step cards in the details modal)', () => {
    const s = execState();
    s.jobs.build.steps = {
      s0: { status: 'success', outputs: {}, dynamic_env: {} },
    };
    const { nodes } = buildExecutionFlow(s, ['build', 'test']);
    for (const node of nodes) {
      expect(node.data.steps).toEqual([]);
    }
  });

  it('lays out left-to-right by default (horizontal x-spread, LR handles)', () => {
    const { nodes } = buildExecutionFlow(execState(), ['build', 'test']);
    const xs = new Set(nodes.map((n) => Math.round(n.position.x)));
    expect(xs.size).toBeGreaterThan(1);
    for (const node of nodes) {
      expect(node.sourcePosition).toBe('right');
      expect(node.targetPosition).toBe('left');
    }
  });
});

describe('layout direction', () => {
  it('buildDefinitionFlow defaults to top-to-bottom (vertical handles)', () => {
    const { nodes } = buildDefinitionFlow(pipeline, [
      'build',
      'test',
      'deploy',
    ]);
    for (const node of nodes) {
      expect(node.sourcePosition).toBe('bottom');
      expect(node.targetPosition).toBe('top');
    }
  });

  it('honors an explicit LR direction for the definition flow', () => {
    const { nodes } = buildDefinitionFlow(
      pipeline,
      ['build', 'test', 'deploy'],
      'LR',
    );
    for (const node of nodes) {
      expect(node.sourcePosition).toBe('right');
      expect(node.targetPosition).toBe('left');
    }
  });
});

/**
 * `foreach` fan-out graphs.
 *
 * The binding rule is that the DAG keeps the shape the author wrote: exactly
 * one node per YAML job, with children summarized *inside* the parent node and
 * never emitted as nodes or edges of their own.
 */
interface LegacyForeachChildResult {
  id: string;
  index: number;
  item: string;
  name: string;
  status: JobResult['status'];
  outcome?: JobResult['outcome'];
  conclusion?: JobResult['conclusion'];
  steps: JobResult['steps'];
  outputs: JobResult['outputs'];
}

type LegacyForeachJobResult = JobResult & {
  resolved_max_parallel?: number;
  children?: LegacyForeachChildResult[];
};

type LegacyForeachJob = NonNullable<Pipeline['jobs'][string]> & {
  foreach?: string[];
};

function foreachChild(
  index: number,
  status: JobResult['status'],
  outcome?: JobResult['outcome'],
): LegacyForeachChildResult {
  return {
    id: `child-${index.toString(36).padStart(6, '0')}`,
    index,
    item: `item-${String(index)}`,
    name: '',
    status,
    ...(outcome ? { outcome, conclusion: outcome } : {}),
    steps: {},
    outputs: {},
  };
}

function foreachExecState(
  jobResult: LegacyForeachJobResult,
  jobName?: string,
): ExecutionState {
  const legacyPipeline: Pipeline & { jobs: Record<string, LegacyForeachJob> } =
    {
      name: 'demo',
      on: 'dispatch',
      jobs: {
        prepare: { steps: [{ id: 's0', run: 'echo prepare' }] },
        fanout: {
          needs: 'prepare',
          ...(jobName !== undefined ? { name: jobName } : {}),
          foreach: ['a', 'b', 'c', 'd', 'e'],
          steps: [{ id: 'work', run: 'echo work' }],
        },
      },
    };
  const pipelineSnapshot = normalizePipeline(legacyPipeline);
  return {
    version: 7,
    id: 'e-foreach',
    pipeline_id: 'p1',
    pipeline_snapshot: pipelineSnapshot,
    status: 'running',
    jobs: {
      prepare: { status: 'success', steps: {}, outputs: {} },
      fanout: jobResult,
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    started_at: '2026-06-16T00:00:00Z',
    cwd: '/tmp',
    inputs: {},
    env: {},
    status_reasons: [],
  };
}

describe.skip('legacy PR 2047 foreach flow graph', () => {
  it('produces ONE node for a five-child fan-out, with the summary counts', () => {
    const state = foreachExecState({
      status: 'running',
      steps: {},
      outputs: {},
      resolved_max_parallel: 3,
      children: [
        foreachChild(0, 'success', 'success'),
        foreachChild(1, 'success', 'success'),
        foreachChild(2, 'success', 'success'),
        foreachChild(3, 'failure', 'failure'),
        foreachChild(4, 'running'),
      ],
    });

    const { nodes, edges } = buildExecutionFlow(state, ['prepare', 'fanout']);

    // One node per YAML job — children are never promoted.
    expect(nodes.map((n) => n.id).sort()).toEqual(['fanout', 'prepare']);
    expect(nodes.filter((n) => n.id.startsWith('child-'))).toHaveLength(0);
    // ...and never gain edges of their own.
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'prepare->fanout',
    ]);

    const fanout = nodes.find((n) => n.id === 'fanout');
    expect(fanout?.data.foreach).toEqual({
      childCountLabel: '5 children',
      completionLabel: '4 / 5 complete',
      breakdownLabel: '3 succeeded · 1 failed · 1 running',
      maxParallelLabel: 'Max parallel: 3',
    });
    // The parent's own `steps` is `{}`; the node carries no step cards.
    expect(fanout?.data.steps).toEqual([]);
  });

  it('marks a still-expanding parent instead of rendering it as ordinary', () => {
    // `children === undefined` on a running `foreach` job means the collection
    // has not been materialized yet.
    const state = foreachExecState({
      status: 'running',
      steps: {},
      outputs: {},
    });
    const { nodes } = buildExecutionFlow(state, ['prepare', 'fanout']);
    expect(nodes.find((n) => n.id === 'fanout')?.data.foreach).toEqual({
      expandingLabel: 'Preparing children…',
    });
  });

  it('does not label pending or terminal unmaterialized parents as expanding', () => {
    const pendingState = foreachExecState({
      status: 'pending',
      steps: {},
      outputs: {},
    });
    const skippedState = foreachExecState({
      status: 'skipped',
      outcome: 'skipped',
      conclusion: 'skipped',
      steps: {},
      outputs: {},
    });
    const failedState = foreachExecState({
      status: 'failure',
      outcome: 'failure',
      conclusion: 'failure',
      steps: {},
      outputs: {},
    });

    for (const state of [pendingState, skippedState, failedState]) {
      const { nodes } = buildExecutionFlow(state, ['prepare', 'fanout']);
      expect(nodes.find((node) => node.id === 'fanout')?.data.foreach).toEqual(
        {},
      );
    }
  });

  it('treats a materialized empty collection as a fan-out, not an ordinary job', () => {
    const state = foreachExecState({
      status: 'success',
      steps: {},
      outputs: {},
      children: [],
    });
    const { nodes } = buildExecutionFlow(state, ['prepare', 'fanout']);
    expect(nodes.find((n) => n.id === 'fanout')?.data.foreach).toEqual({
      emptyLabel: 'No children were generated for this job.',
    });
  });

  it('falls back to the job id when the job name is a per-child template', () => {
    const state = foreachExecState(
      {
        status: 'running',
        steps: {},
        outputs: {},
        children: [foreachChild(0, 'running')],
      },
      'Item ${{ matrix.index }}',
    );
    const { nodes } = buildExecutionFlow(state, ['prepare', 'fanout']);
    expect(nodes.find((n) => n.id === 'fanout')?.data.label).toBe('fanout');
  });

  it('presents a continue_on_error parent by outcome, not conclusion', () => {
    const state = foreachExecState({
      status: 'success',
      conclusion: 'success',
      outcome: 'failure',
      steps: {},
      outputs: {},
      children: [
        foreachChild(0, 'success', 'success'),
        foreachChild(1, 'failure', 'failure'),
      ],
    });
    const { nodes } = buildExecutionFlow(state, ['prepare', 'fanout']);
    expect(nodes.find((n) => n.id === 'fanout')?.data.status).toBe('failure');
  });

  it('leaves a non-foreach pipeline graph unchanged', () => {
    const { nodes, edges } = buildExecutionFlow(execState(), ['build', 'test']);
    for (const node of nodes) {
      expect(node.data.foreach).toBeUndefined();
    }
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'build->test',
    ]);

    const definition = buildDefinitionFlow(pipeline, [
      'build',
      'test',
      'deploy',
    ]);
    for (const node of definition.nodes) {
      expect(node.data.foreach).toBeUndefined();
    }
  });
});
