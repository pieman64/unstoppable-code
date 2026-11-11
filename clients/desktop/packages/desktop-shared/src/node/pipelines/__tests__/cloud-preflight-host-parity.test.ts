// CAN-6169 (plan CP-18): cloud run preflight refuses, before a sandbox
// starts, the steps the pipeline host would refuse at start. The cloud runner
// is that host, and the web core cannot read the bundled action manifests,
// so preflight carries the host's verdict for each bundled action. This
// golden runs the host's own classifier over the real manifests and fails
// when the two disagree or a bundled action is missing from preflight.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import {
  CLOUD_RUN_BUNDLED_ACTIONS,
  CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL,
  CLOUD_RUN_HOST_ACTIONS,
  CLOUD_RUN_PORTABLE_MODEL_ACTIONS,
  preflightCloudRun,
} from '@canopy/pipeline-interop/cloud-preflight';
import { isPipelineHostActionId } from '@canopy/execution-engine/pipelines/host-actions';
import { resolveActionRuntime } from '../action-resolver';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  DAEMON_PORTABLE_MODEL_ACTIONS,
  classifyDaemonPipeline,
} from '../daemon-eligibility';

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../resources/actions');

/** A global pipeline of one step, the shape preflight accepts. */
function oneStep(step: Step, extra: Partial<Pipeline> = {}): Pipeline {
  return {
    name: 't',
    scope: 'global',
    on: 'dispatch',
    jobs: { j: { steps: [step] } },
    ...extra,
  };
}

/** What the cloud runner's host decides, with the options the web core owner serves. */
function hostVerdict(pipeline: Pipeline): string {
  const result = classifyDaemonPipeline(
    pipeline,
    {
      runtime: {
        bundledActionsDir: BUNDLED_ACTIONS,
        getProjectActionsDir,
        getProjectActionsDirCandidates,
      },
    },
    { modelSteps: 'claude_codex', hostSteps: 'owner' },
  );
  return result.eligible ? 'portable' : result.reason;
}

function preflightVerdict(pipeline: Pipeline): string {
  return preflightCloudRun(pipeline)[0]?.reason ?? 'portable';
}

const bundled = readdirSync(BUNDLED_ACTIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

it('carries the host verdict for every bundled action and nothing else', () => {
  expect(Object.keys(CLOUD_RUN_BUNDLED_ACTIONS).sort()).toEqual(bundled);
  const host = Object.fromEntries(
    bundled.map((name) => [
      name,
      hostVerdict(oneStep({ uses: `builtin/${name}` })),
    ]),
  );
  expect(CLOUD_RUN_BUNDLED_ACTIONS).toEqual(host);
});

it('refuses the bundled actions whose scope leaves out global runs', () => {
  const runtime = {
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  };
  const outsideGlobal = bundled.filter((name) => {
    const resolved = resolveActionRuntime(`builtin/${name}`, runtime);
    if (resolved === null) throw new Error(`builtin/${name} does not resolve`);
    return !resolved.definition.scopes.includes('global');
  });
  expect([...CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL].sort()).toEqual(
    outsideGlobal,
  );
  const portable = outsideGlobal.filter(
    (name) => CLOUD_RUN_BUNDLED_ACTIONS[name] === 'portable',
  );
  for (const name of portable)
    expect(preflightVerdict(oneStep({ uses: `builtin/${name}` }))).toBe(
      'action_scope',
    );
});

it('checks the same host and model actions the host does', () => {
  expect(bundled.filter((name) => isPipelineHostActionId(name)).sort()).toEqual(
    [...CLOUD_RUN_HOST_ACTIONS].sort(),
  );
  expect([...CLOUD_RUN_PORTABLE_MODEL_ACTIONS].sort()).toEqual(
    [...DAEMON_PORTABLE_MODEL_ACTIONS.keys()].sort(),
  );
});

it.each<[string, Pipeline]>([
  ['a tsx run step', oneStep({ run: 'console.log(1)', shell: 'tsx' })],
  [
    'a tsx job default',
    {
      name: 't',
      scope: 'global',
      on: 'dispatch',
      jobs: {
        j: { defaults: { run: { shell: 'tsx' } }, steps: [{ run: 'x' }] },
      },
    },
  ],
  ['an expression action', oneStep({ uses: '${{ inputs.action }}' })],
  ['an aliased bundled path', oneStep({ uses: 'builtin/./run-pipeline' })],
  ['a bundled name in another case', oneStep({ uses: 'builtin/Run-Pipeline' })],
  ['a name the table inherits', oneStep({ uses: 'builtin/constructor' })],
  ['an unknown bundled action', oneStep({ uses: 'builtin/no-such-action' })],
  [
    'an expression model',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', model: '${{ inputs.model }}' },
    }),
  ],
  [
    'a model alias the core did not resolve',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      { model_aliases: [{ id: 'fast', name: 'Fast' }] },
    ),
  ],
  [
    'a plugin collection on a model step',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', plugin_collection_id: 'tools' },
    }),
  ],
  [
    'message attachments',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', attachments: 'a.txt' },
    }),
  ],
  [
    'message file references',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', file_references: 'a.txt' },
    }),
  ],
  [
    'a message with its own model',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', model: 'sonnet' },
    }),
  ],
  ['an agent-hinted run step', oneStep({ run: 'x', log_format_hint: 'agent' })],
  ['a plain shell step', oneStep({ run: 'echo hi' })],
])('refuses %s for the reason the host does', (_name, pipeline) => {
  expect(preflightVerdict(pipeline)).toBe(hostVerdict(pipeline));
});
