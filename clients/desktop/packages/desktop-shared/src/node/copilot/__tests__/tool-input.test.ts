import { headlessCopilotDecision } from '../headless-policy';
import { resolve } from 'node:path';
import { copilotNativeOperations, isCopilotShellControl } from '../tool-input';
import { CopilotToolCorrelation } from '../tool-correlation';
import type { SessionEvent } from '@github/copilot-sdk';

describe('Copilot native tool normalization', () => {
  it('admits only the pinned read/stop/list shell controls', () => {
    expect(isCopilotShellControl('list_bash', {})).toBe(true);
    expect(
      isCopilotShellControl('read_bash', { shellId: 'owned', delay: 1 }),
    ).toBe(true);
    expect(isCopilotShellControl('stop_powershell', { shellId: 'owned' })).toBe(
      true,
    );
    for (const args of [
      {},
      { shellId: [] },
      { shellId: 'owned', delay: Infinity },
      { shellId: 'owned', delay: 1, chars: 'rm file' },
    ])
      expect(isCopilotShellControl('read_bash', args)).toBe(false);
  });
  it('retains every search root for independent approval', () => {
    expect(
      copilotNativeOperations(
        'grep',
        { pattern: 'secret', paths: ['src', '../other'] },
        '/workspace',
      ),
    ).toEqual(
      ['src', '../other'].map((path) => ({
        tool: 'Grep',
        mutates: false,
        input: {
          pattern: 'secret',
          paths: ['src', '../other'],
          path: resolve('/workspace', path),
        },
      })),
    );
  });
  it('normalizes mutations without losing content or the full shell command', () => {
    expect(
      copilotNativeOperations(
        'create',
        { path: 'new', file_text: '' },
        '/workspace',
      ),
    ).toEqual([
      {
        tool: 'Write',
        mutates: true,
        input: { file_path: resolve('/workspace/new'), content: '' },
      },
    ]);
    expect(
      copilotNativeOperations(
        'bash',
        { command: 'echo harmless; rm important' },
        '/workspace',
      ),
    ).toEqual([
      {
        tool: 'Bash',
        mutates: true,
        input: { command: 'echo harmless; rm important' },
      },
    ]);
  });
  it.each([
    ['view', { path: 'bad\0path' }],
    ['create', { path: 'new' }],
    ['edit', { path: 'file', old_str: 'a' }],
    ['grep', { pattern: 'x', paths: [null] }],
    ['glob', { pattern: '*.ts', paths: [] }],
    ['bash', { command: 'run', detach: true }],
    ['web_fetch', { url: 'file:///etc/passwd' }],
    ['web_fetch', { url: 'https://secret@example.com' }],
    ['task', { prompt: 'launch child' }],
    ['future_tool', {}],
  ])('fails closed for %s with unsupported arguments', (name, input) => {
    expect(copilotNativeOperations(name, input, '/workspace')).toBeUndefined();
  });
});

describe('headless presets', () => {
  it.each(['web_fetch', 'web_search'])(
    'keeps %s behind network-enabled presets',
    (toolName) => {
      for (const preset of [
        'none',
        'read_only',
        'plan',
        'dangerous_all',
      ] as const) {
        expect(
          headlessCopilotDecision(
            preset,
            {
              sessionId: 's',
              timestamp: new Date(0),
              workingDirectory: '/workspace',
              toolName,
              toolArgs: { url: 'https://example.com', query: 'example' },
            },
            '/workspace',
          ).decision,
        ).toBe(
          preset === 'plan' || preset === 'dangerous_all' ? 'allow' : 'deny',
        );
      }
    },
  );
  it.each(['none', 'read_only', 'plan', 'dangerous_all'] as const)(
    '%s authorizes only its declared native operations',
    (preset) => {
      for (const [toolName, toolArgs, mutates] of [
        ['view', { path: '/workspace/read.txt' }, false],
        ['create', { path: '/workspace/new.txt', file_text: 'new' }, true],
        ['bash', { command: 'pwd' }, true],
      ] as const) {
        const result = headlessCopilotDecision(
          preset,
          {
            sessionId: 's',
            timestamp: new Date(0),
            workingDirectory: '/workspace',
            toolName,
            toolArgs,
          },
          '/workspace',
        );
        expect(result.decision).toBe(
          preset === 'dangerous_all' || (preset !== 'none' && !mutates)
            ? 'allow'
            : 'deny',
        );
      }
      expect(
        headlessCopilotDecision(
          preset,
          {
            sessionId: 's',
            timestamp: new Date(0),
            workingDirectory: '/workspace',
            toolName: 'task',
            toolArgs: { prompt: 'escape' },
          },
          '/workspace',
        ).decision,
      ).toBe('deny');
    },
  );
});

test('replayed start events cannot impersonate a later identical tool call', () => {
  const correlation = new CopilotToolCorrelation();
  const event: SessionEvent = {
    id: 'first-event',
    type: 'tool.execution_start',
    timestamp: '2026-09-29T00:00:00Z',
    parentId: null,
    ephemeral: false,
    data: {
      toolCallId: 'first-call',
      toolName: 'view',
      arguments: { path: 'file' },
    },
  };
  correlation.observe(event);
  correlation.observe(event);
  expect(correlation.take('view', { path: 'file' })?.id).toBe('first-call');
  correlation.observe(event);
  correlation.observe({
    ...event,
    id: 'second-event',
    data: { ...event.data, toolCallId: 'second-call' },
  });
  expect(correlation.take('view', { path: 'file' })?.id).toBe('second-call');
  expect(correlation.take('view', { path: 'file' })).toBeUndefined();
});
