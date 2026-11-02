import { parsePipelineText } from '../../pipelines/parse-pipeline';
import { SEND_AGENT_MESSAGE_AUTHORITY_INPUTS } from '../../pipelines/host-send-agent-message';
import {
  AGENT_PIPELINE_RUN_STEP_POLICY_ERROR,
  AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR,
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

describe('agent pipeline send-agent-message authority', () => {
  function sendStep(
    withLines: string[],
    uses = 'builtin/send-agent-message',
  ): string {
    return `
name: Send
on: dispatch
jobs:
  send:
    steps:
      - uses: ${JSON.stringify(uses)}
        with:
          project_id: p
          task_id: t
          text: hi
${withLines.map((line) => `          ${line}`).join('\n')}
`;
  }

  const policy = (yaml: string): string | null =>
    validateAgentPipelineMutationPolicy(parsePipelineText(yaml));

  const values: Record<string, string> = {
    approval_mode: 'auto',
    model: 'opus',
    plan_mode: 'true',
    plugins: `'[{"type":"skill","source":{"type":"builtin","id":"app"},"skill_name":"x"}]'`,
  };

  it.each(SEND_AGENT_MESSAGE_AUTHORITY_INPUTS)(
    'refuses %s with a literal or expression chat_id',
    (input) => {
      for (const chat of [
        'chat_id: c',
        "chat_id: '${{ steps.a.outputs.chat_id }}'",
      ]) {
        expect(policy(sendStep([chat, `${input}: ${values[input]}`]))).toBe(
          AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR,
        );
      }
    },
  );

  it.each(SEND_AGENT_MESSAGE_AUTHORITY_INPUTS)(
    'allows %s without chat_id, for a new chat',
    (input) => {
      expect(policy(sendStep([`${input}: ${values[input]}`]))).toBeNull();
    },
  );

  it.each([
    'builtin/send-agent-message/',
    'builtin/./send-agent-message',
    'builtin/x/../send-agent-message',
    'builtin/ send-agent-message ',
    'builtin/x\\..\\send-agent-message',
  ])('refuses %s, which resolves to the same action', (uses) => {
    expect(policy(sendStep(['chat_id: c', 'model: opus'], uses))).toBe(
      AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR,
    );
  });

  it('allows inputs outside the shared authority list', () => {
    expect(
      policy(
        sendStep(['chat_id: c', 'thinking_effort: high', 'fast_mode: true']),
      ),
    ).toBeNull();
  });

  it('refuses plugin and expression text_references with chat_id', () => {
    const plugin = JSON.stringify([
      {
        kind: 'plugin',
        textStart: 0,
        displayText: 'hi',
        plugin: { kind: 'installed', marketplaceId: 'm', pluginName: 'p' },
      },
    ]);
    expect(
      policy(sendStep(['chat_id: c', `text_references: '${plugin}'`])),
    ).toBe(AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR);
    expect(
      policy(sendStep(['chat_id: c', "text_references: '${{ inputs.refs }}'"])),
    ).toBe(AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR);
  });

  it('allows file-only text_references with chat_id', () => {
    const file = JSON.stringify([
      {
        kind: 'file',
        textStart: 0,
        displayText: 'hi',
        root: { kind: 'workspace' },
        relativePath: 'a.md',
      },
    ]);
    expect(
      policy(sendStep(['chat_id: c', `text_references: '${file}'`])),
    ).toBeNull();
  });

  it.each([
    'builtin/run-pipeline',
    'builtin/run-pipeline/',
    'builtin/./run-pipeline',
  ])('refuses the step inside an inline child of %s', (runPipeline) => {
    const yaml = `
name: Parent
on: dispatch
jobs:
  parent:
    steps:
      - uses: ${runPipeline}
        with:
          pipeline_yaml: |
            name: Child
            on: dispatch
            jobs:
              child:
                steps:
                  - uses: builtin/send-agent-message
                    with:
                      project_id: p
                      task_id: t
                      chat_id: c
                      text: hi
                      model: opus
`;
    expect(policy(yaml)).toBe(AGENT_PIPELINE_SESSION_AUTHORITY_POLICY_ERROR);
  });
});
