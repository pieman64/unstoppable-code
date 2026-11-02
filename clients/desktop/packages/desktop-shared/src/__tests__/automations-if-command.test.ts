import { MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS } from '@canopy/protocol/automations';
import type { AutomationAction } from '../types';
import {
  AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES,
  AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES,
  AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES,
  MAX_AUTOMATION_IF_COMMAND_CHARS,
  MAX_AUTOMATION_IF_COMMAND_IDEMPOTENCY_KEY_CHARS,
  createAutomationPromptVariableToken,
  getAutomationIfCommandVariableDefinitions,
  interpolateAutomationActionIfCommandOutput,
  interpolateAutomationIfCommandOutput,
  parseAutomationIfCommandOutput,
  validateAutomationIfCommand,
} from '../lib/automations';

describe('automation If Command helpers', () => {
  it('exposes the brand-prefixed output variable as the primary name', () => {
    expect(AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0]).toBe(
      'CANOPY_AUTOMATION_IF_CMD_OUTPUT',
    );
    const defs = getAutomationIfCommandVariableDefinitions();
    expect(defs[0]?.name).toBe('CANOPY_AUTOMATION_IF_CMD_OUTPUT');
    expect(defs[0]?.description.length).toBeGreaterThan(0);
  });

  it('builds a {{ }} prompt token', () => {
    expect(
      createAutomationPromptVariableToken('CANOPY_AUTOMATION_IF_CMD_OUTPUT'),
    ).toBe('{{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}');
  });

  it('substitutes the supported token and leaves unknown ones intact', () => {
    expect(
      interpolateAutomationIfCommandOutput(
        'value: {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}} keep: {{CANOPY_UNKNOWN}}',
        'hello',
      ),
    ).toBe('value: hello keep: {{CANOPY_UNKNOWN}}');
  });

  it('interpolates prompt-bearing actions only', () => {
    const promptAction: AutomationAction = {
      type: 'app_advisor_prompt',
      prompt: 'Got: {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}',
    };
    const result = interpolateAutomationActionIfCommandOutput(
      promptAction,
      'X',
    );
    expect(result.type === 'app_advisor_prompt' && result.prompt).toBe(
      'Got: X',
    );

    const pipelineAction: AutomationAction = {
      type: 'worktree_pipeline',
      workspaceId: 'w',
      pipelineId: 'p',
      inputs: { note: '{{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}' },
    };
    const pipelineResult = interpolateAutomationActionIfCommandOutput(
      pipelineAction,
      'X',
    );
    expect(pipelineResult).toEqual(pipelineAction);
  });

  it('keeps configured reference offsets aligned after If Command output expands', () => {
    const prompt = 'Got: {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}} Read src/a.ts';
    const action: AutomationAction = {
      type: 'worktree_prompt',
      workspaceId: 'project',
      prompt,
      promptReferences: [
        {
          kind: 'file',
          textStart: prompt.indexOf('src/a.ts'),
          displayText: 'src/a.ts',
          root: { kind: 'workspace' },
          relativePath: 'src/a.ts',
        },
      ],
    };
    const result = interpolateAutomationActionIfCommandOutput(action, 'X');
    if (result.type !== 'worktree_prompt') {
      throw new Error('Expected a worktree prompt action');
    }
    expect(result.prompt).toBe('Got: X Read src/a.ts');
    expect(result.promptReferences?.[0]?.textStart).toBe(
      result.prompt.indexOf('src/a.ts'),
    );
  });

  it('validates the If Command string', () => {
    expect(validateAutomationIfCommand(undefined)).toBeNull();
    expect(validateAutomationIfCommand('')).toBeNull();
    expect(validateAutomationIfCommand('exit 0')).toBeNull();
    expect(validateAutomationIfCommand(42)).toMatch(/string/);
    expect(validateAutomationIfCommand('x'.repeat(20_001))).toMatch(/too long/);
  });

  it('parses and strips idempotency control lines from stdout', () => {
    const keyName =
      AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES[0] ??
      'CANOPY_IDEMPOTENCY_KEY';
    const scopeName =
      AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES[0] ??
      'CANOPY_IDEMPOTENCY_SCOPE';

    expect(
      parseAutomationIfCommandOutput(
        [
          'prompt line 1',
          `${keyName}=first`,
          `${scopeName}=GLOBAL`,
          `${keyName}=second`,
          `${scopeName}=invalid`,
          `${keyName}=   `,
          'prompt line 2',
        ].join('\n'),
      ),
    ).toEqual({
      output: 'prompt line 1\nprompt line 2',
      idempotencyKey: 'second',
      idempotencyScope: 'global',
    });
  });

  it('defaults idempotency scope to self when absent or invalid', () => {
    const keyName =
      AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES[0] ??
      'CANOPY_IDEMPOTENCY_KEY';
    const scopeName =
      AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES[0] ??
      'CANOPY_IDEMPOTENCY_SCOPE';

    expect(
      parseAutomationIfCommandOutput(`${keyName}=ticket-1\n${scopeName}=later`),
    ).toEqual({
      output: '',
      idempotencyKey: 'ticket-1',
      idempotencyScope: 'self',
    });
  });

  it('ignores oversized idempotency key markers', () => {
    const keyName =
      AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES[0] ??
      'CANOPY_IDEMPOTENCY_KEY';

    expect(
      parseAutomationIfCommandOutput(
        `${keyName}=${'x'.repeat(MAX_AUTOMATION_IF_COMMAND_IDEMPOTENCY_KEY_CHARS + 1)}\npayload`,
      ),
    ).toEqual({
      output: 'payload',
      idempotencyScope: 'self',
    });
  });

  it('accepts idempotency markers from both product brands', () => {
    expect(
      parseAutomationIfCommandOutput(
        'UNSTOPPABLE_CODE_IDEMPOTENCY_KEY=item-1\nUNSTOPPABLE_CODE_IDEMPOTENCY_SCOPE=global',
      ),
    ).toEqual({
      output: '',
      idempotencyKey: 'item-1',
      idempotencyScope: 'global',
    });
  });
});

describe('shared run-condition limits', () => {
  it('matches the protocol cap to the local If Command cap', () => {
    expect(MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS).toBe(
      MAX_AUTOMATION_IF_COMMAND_CHARS,
    );
  });
});
