import { parsePipelineText } from '../../pipelines/parse-pipeline';
import {
  AGENT_PIPELINE_RUN_STEP_POLICY_ERROR,
  validateAgentPipelineMutationPolicy,
} from '../agent-pipeline-policy';

describe('agent pipeline mutation policy', () => {
  it('rejects shell steps inside inline child pipelines', () => {
    const pipeline = parsePipelineText(`
name: Parent
on: dispatch
jobs:
  parent:
    steps:
      - uses: builtin/run-pipeline
        with:
          pipeline_yaml: |
            name: Child
            on: dispatch
            jobs:
              child:
                steps:
                  - run: printenv
`);

    expect(validateAgentPipelineMutationPolicy(pipeline)).toBe(
      AGENT_PIPELINE_RUN_STEP_POLICY_ERROR,
    );
  });

  it('rejects child pipeline file references that can resolve to shell steps', () => {
    const pipeline = parsePipelineText(`
name: Parent
on: dispatch
jobs:
  parent:
    steps:
      - uses: builtin/run-pipeline
        with:
          pipeline: ./agent-authored-child.yaml
`);

    expect(validateAgentPipelineMutationPolicy(pipeline)).toBe(
      AGENT_PIPELINE_RUN_STEP_POLICY_ERROR,
    );
  });

  it('allows declarative steps inside inline child pipelines', () => {
    const pipeline = parsePipelineText(`
name: Parent
on: dispatch
jobs:
  parent:
    steps:
      - uses: builtin/run-pipeline
        with:
          pipeline_yaml: |
            name: Child
            on: dispatch
            jobs:
              child:
                steps:
                  - uses: builtin/agent-prompt
`);

    expect(validateAgentPipelineMutationPolicy(pipeline)).toBeNull();
  });
});
