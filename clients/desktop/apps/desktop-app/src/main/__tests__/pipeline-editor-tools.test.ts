import {
  PIPELINE_EDITOR_TOOL_ENTRIES,
  getCanonicalPipelineEditorToolKey,
  getPipelineEditorProviderToolName,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { buildPipelineEditorDynamicToolSpecs } from '../pipeline-editor/codex-dynamic-tools';
import { executePipelineEditorTool } from '../pipeline-editor/tool-executor';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';

function createRuntime(
  overrides: Partial<PipelineEditorToolRuntime> = {},
): PipelineEditorToolRuntime {
  return {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    dispatchEditorAction: jest.fn().mockResolvedValue({
      requestId: 'request-1',
      ok: true,
      pipelineYaml: 'name: test',
      isDirty: false,
      validation: [],
    }),
    requestEditorState: jest.fn().mockResolvedValue({
      requestId: 'request-1',
      ok: true,
      pipelineYaml: 'name: test',
      isDirty: false,
      validation: [],
    }),
    listPipelines: jest.fn().mockResolvedValue([
      {
        pipelineId: 'pipeline-1',
        name: 'Pipeline 1',
        source: 'user',
        pipelineFilePath: '/tmp/pipeline.yml',
        readonly: false,
      },
    ]),
    getBuiltinActionDefinition: jest.fn().mockReturnValue({
      found: true,
      name: 'agent-prompt',
      uses: 'builtin/agent-prompt',
      description: 'Run a single prompt.',
      yaml: 'name: Agent Prompt\n',
    }),
    ...overrides,
  };
}

describe('Pipeline Editor tool registry', () => {
  it('keeps Claude and Codex names resolvable to canonical keys', () => {
    for (const entry of PIPELINE_EDITOR_TOOL_ENTRIES) {
      expect(
        getPipelineEditorProviderToolName(entry.canonicalKey, 'claude'),
      ).toBe(entry.claudeToolName);
      expect(
        getPipelineEditorProviderToolName(entry.canonicalKey, 'codex'),
      ).toBe(entry.codexToolName);
      expect(getCanonicalPipelineEditorToolKey(entry.claudeToolName)).toBe(
        entry.canonicalKey,
      );
      expect(getCanonicalPipelineEditorToolKey(entry.codexToolName)).toBe(
        entry.canonicalKey,
      );
    }
  });

  it('marks every Codex dynamic tool as a function tool', () => {
    expect(
      buildPipelineEditorDynamicToolSpecs().map((tool) => tool.name),
    ).toEqual(PIPELINE_EDITOR_TOOL_ENTRIES.map((entry) => entry.codexToolName));
    for (const tool of buildPipelineEditorDynamicToolSpecs()) {
      expect(tool).toHaveProperty('type', 'function');
    }
  });
});

describe('executePipelineEditorTool', () => {
  it('validates set_yaml arguments before dispatching', async () => {
    const dispatchEditorAction = jest.fn();
    const runtime = createRuntime({ dispatchEditorAction });

    const invalid = await executePipelineEditorTool(
      'pipeline_set_yaml',
      {},
      runtime,
    );

    expect(invalid).toEqual({
      text: 'Invalid arguments for SetPipelineYaml.',
      isError: true,
    });
    expect(dispatchEditorAction).not.toHaveBeenCalled();
  });

  it('dispatches set_yaml through the renderer runtime with the provider-owned request id', async () => {
    const dispatchEditorAction = jest.fn().mockResolvedValue({
      requestId: 'tool-1',
      ok: true,
      pipelineYaml: 'name: new',
    });
    const runtime = createRuntime({ dispatchEditorAction });

    const result = await executePipelineEditorTool(
      'pipeline_set_yaml',
      { yaml: 'name: new' },
      runtime,
      { toolUseId: 'tool-1' },
    );

    expect(dispatchEditorAction).toHaveBeenCalledWith(
      { type: 'pipeline.set_yaml', yaml: 'name: new' },
      'tool-1',
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"pipelineYaml": "name: new"');
  });

  it('lists source-aware pipeline rows from the runtime', async () => {
    const listPipelines = jest.fn().mockResolvedValue([
      {
        pipelineId: 'pipeline-1',
        name: 'Pipeline 1',
        source: 'user',
        pipelineFilePath: '/tmp/pipeline.yml',
        readonly: false,
      },
    ]);
    const runtime = createRuntime({ listPipelines });

    const result = await executePipelineEditorTool(
      'pipeline_list',
      {},
      runtime,
    );

    expect(listPipelines).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('"source": "user"');
    expect(result.text).toContain('"pipelineFilePath": "/tmp/pipeline.yml"');
  });

  it('dispatches sharedRemoteId-only open locators for shared pipelines', async () => {
    const dispatchEditorAction = jest.fn().mockResolvedValue({
      requestId: 'open-shared-1',
      ok: true,
    });
    const runtime = createRuntime({ dispatchEditorAction });

    const result = await executePipelineEditorTool(
      'pipeline_open',
      { sharedRemoteId: 'remote-1' },
      runtime,
      { toolUseId: 'open-shared-1' },
    );

    expect(dispatchEditorAction).toHaveBeenCalledWith(
      {
        type: 'pipeline.open',
        locator: { sharedRemoteId: 'remote-1' },
      },
      'open-shared-1',
    );
    expect(result.isError).toBe(false);
  });

  it('rejects open locators that name neither a pipelineId nor a sharedRemoteId', async () => {
    const dispatchEditorAction = jest.fn();
    const runtime = createRuntime({ dispatchEditorAction });

    for (const rawArgs of [
      {},
      { cwd: '/tmp' },
      { pipelineFilePath: '/a.yml' },
    ]) {
      const result = await executePipelineEditorTool(
        'pipeline_open',
        rawArgs,
        runtime,
      );
      expect(result).toEqual({
        text: 'Invalid arguments for OpenPipeline.',
        isError: true,
      });
    }
    expect(dispatchEditorAction).not.toHaveBeenCalled();
  });

  it('dispatches the empty-argument editor tools to the right actions', async () => {
    const dispatchEditorAction = jest.fn().mockResolvedValue({
      requestId: 'req',
      ok: true,
    });
    const requestEditorState = jest.fn().mockResolvedValue({
      requestId: 'req',
      ok: true,
      pipelineYaml: 'name: test',
    });
    const runtime = createRuntime({ dispatchEditorAction, requestEditorState });

    await executePipelineEditorTool('pipeline_create', {}, runtime, {
      toolUseId: 'c1',
    });
    expect(dispatchEditorAction).toHaveBeenCalledWith(
      { type: 'pipeline.create' },
      'c1',
    );

    await executePipelineEditorTool('pipeline_save', {}, runtime, {
      toolUseId: 's1',
    });
    expect(dispatchEditorAction).toHaveBeenCalledWith(
      { type: 'pipeline.save' },
      's1',
    );

    await executePipelineEditorTool('navigation_to_list', {}, runtime, {
      toolUseId: 'n1',
    });
    expect(dispatchEditorAction).toHaveBeenCalledWith(
      { type: 'navigation.to_list' },
      'n1',
    );

    const getCurrent = await executePipelineEditorTool(
      'pipeline_get_current',
      {},
      runtime,
      { toolUseId: 'g1' },
    );
    expect(requestEditorState).toHaveBeenCalledWith('g1');
    expect(getCurrent.isError).toBe(false);
  });

  it('rejects non-object arguments for empty-argument tools', async () => {
    const dispatchEditorAction = jest.fn();
    const requestEditorState = jest.fn();
    const runtime = createRuntime({ dispatchEditorAction, requestEditorState });

    const result = await executePipelineEditorTool(
      'pipeline_save',
      'not-an-object',
      runtime,
    );
    expect(result).toEqual({
      text: 'Invalid arguments for SavePipeline.',
      isError: true,
    });
    expect(dispatchEditorAction).not.toHaveBeenCalled();
  });

  it('returns the builtin action definition for a normalized name', async () => {
    const getBuiltinActionDefinition = jest.fn().mockReturnValue({
      found: true,
      name: 'agent-prompt',
      uses: 'builtin/agent-prompt',
      yaml: 'name: Agent Prompt\n',
    });
    const runtime = createRuntime({ getBuiltinActionDefinition });

    const result = await executePipelineEditorTool(
      'pipeline_get_action_definition',
      { name: 'builtin/agent-prompt' },
      runtime,
    );

    expect(getBuiltinActionDefinition).toHaveBeenCalledWith(
      'builtin/agent-prompt',
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"uses": "builtin/agent-prompt"');
  });

  it('flags a not-found builtin action as an error result', async () => {
    const getBuiltinActionDefinition = jest.fn().mockReturnValue({
      found: false,
      error: 'No bundled builtin action named "nope".',
      availableActions: ['agent-prompt'],
    });
    const runtime = createRuntime({ getBuiltinActionDefinition });

    const result = await executePipelineEditorTool(
      'pipeline_get_action_definition',
      { name: 'nope' },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('availableActions');
  });

  it('validates get-action-definition arguments before dispatching', async () => {
    const getBuiltinActionDefinition = jest.fn();
    const runtime = createRuntime({ getBuiltinActionDefinition });

    const result = await executePipelineEditorTool(
      'pipeline_get_action_definition',
      {},
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for GetBuiltinActionDefinition.',
      isError: true,
    });
    expect(getBuiltinActionDefinition).not.toHaveBeenCalled();
  });

  it('delegates ask_user_question to the Canopy-injected runtime', async () => {
    const requestUserAnswers = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({ requestUserAnswers });

    await executePipelineEditorTool(
      'ask_user_question',
      { questions: [{ question: 'Pick one', options: ['a', 'b'] }] },
      runtime,
      { toolUseId: 'ask-1' },
    );

    expect(requestUserAnswers).toHaveBeenCalledWith(
      [{ question: 'Pick one', options: ['a', 'b'], multiSelect: undefined }],
      { toolUseId: 'ask-1' },
    );
  });
});
