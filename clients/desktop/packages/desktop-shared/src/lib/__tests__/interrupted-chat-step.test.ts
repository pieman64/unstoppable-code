import type { PersistedChatBlock, PersistedChatMessage } from '../../types';
import { describeLastAgentStep } from '../interrupted-chat-step';

function message(
  role: PersistedChatMessage['role'],
  blocks: PersistedChatBlock[],
): PersistedChatMessage {
  return { id: 'message', role, blocks, timestamp: 1 };
}
const prompt = message('user', [{ type: 'text', text: 'Fix it' }]);
function tool(input: string, toolName = 'Edit'): PersistedChatBlock {
  return { type: 'tool_use', toolUseId: 'tool', toolName, input };
}
function result(
  over: Partial<Extract<PersistedChatBlock, { type: 'tool_result' }>> = {},
): PersistedChatBlock {
  return {
    type: 'tool_result',
    toolUseId: 'tool',
    toolName: 'Edit',
    output: 'done',
    isError: false,
    ...over,
  };
}
function step(
  input: string,
  root?: string,
): ReturnType<typeof describeLastAgentStep> {
  return describeLastAgentStep(
    [prompt, message('assistant', [tool(input)])],
    root,
  );
}

describe('describeLastAgentStep', () => {
  it.each(['user', 'system', 'assistant'] as const)(
    'recognizes explicit success in a later %s result without mutating history',
    (role) => {
      const messages = [
        prompt,
        message('assistant', [tool('{}')]),
        message(role, [result()]),
      ];
      const before = structuredClone(messages);
      expect(describeLastAgentStep(messages)).toEqual({
        toolName: 'Edit',
        finished: true,
      });
      expect(messages).toEqual(before);
    },
  );

  it('matches only results strictly after the invocation, including the same message', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), result()]),
      ]),
    ).toEqual({ toolName: 'Edit', finished: true });
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [result(), tool('{}')]),
      ]),
    ).toEqual({ toolName: 'Edit' });
  });

  it.each(
    [
      [],
      [result({ isError: true })],
      [result({ toolUseId: 'other' })],
      [result({ toolUseId: '' })],
      [result({ toolUseId: '   ' })],
      [
        result({
          interruption: { reason: 'app_restart', at: 3 },
          isError: true,
        }),
      ],
      [result(), result({ isError: true })],
      [result({ isError: true }), result()],
      [result(), result({ output: 'different outcome' })],
    ].map((results) => ({ results })),
  )(
    'leaves missing, errored or ambiguous outcomes unknown (%j)',
    ({ results }) => {
      expect(
        describeLastAgentStep([
          prompt,
          message('assistant', [tool('{}')]),
          message('system', results),
        ]),
      ).toEqual({ toolName: 'Edit' });
    },
  );

  it('requires an explicit false error flag, even in older persisted data', () => {
    const unspecified = result();
    Reflect.deleteProperty(unspecified, 'isError');
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), unspecified]),
      ]),
    ).toEqual({ toolName: 'Edit' });
  });

  it('leaves a result without an ID unknown', () => {
    const completion = result();
    Reflect.deleteProperty(completion, 'toolUseId');
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), completion]),
      ]),
    ).toEqual({ toolName: 'Edit' });
  });

  it('does not attach a status to an unusable step name', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}', '  '), result()]),
      ]),
    ).toBeUndefined();
  });

  it.each(['', '   ', undefined])(
    'requires a nonblank invocation ID (%s)',
    (id) => {
      const invocation = tool('{}');
      if (id === undefined) Reflect.deleteProperty(invocation, 'toolUseId');
      else Reflect.set(invocation, 'toolUseId', id);
      const completion = result();
      if (id === undefined) Reflect.deleteProperty(completion, 'toolUseId');
      else Reflect.set(completion, 'toolUseId', id);
      expect(
        describeLastAgentStep([
          prompt,
          message('assistant', [invocation, completion]),
        ]),
      ).toEqual({ toolName: 'Edit' });
    },
  );

  it('accepts identical duplicate successes when the invocation is unique', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}')]),
        message('user', [result()]),
        message('system', [result()]),
      ]),
    ).toEqual({ toolName: 'Edit', finished: true });
  });

  it('does not attribute an earlier invocation result to the last invocation', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [
          tool('{}'),
          {
            type: 'tool_use',
            toolUseId: 'last',
            toolName: 'Bash',
            input: '{}',
          },
          result(),
        ]),
      ]),
    ).toEqual({ toolName: 'Bash' });
  });

  it('matches the last of several distinct invocations by its exact ID', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [
          tool('{}'),
          {
            type: 'tool_use',
            toolUseId: 'last',
            toolName: 'Bash',
            input: '{}',
          },
          result(),
          result({ toolUseId: 'last', toolName: 'Bash' }),
        ]),
      ]),
    ).toEqual({ toolName: 'Bash', finished: true });
  });

  it('never matches results from an earlier turn', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), result()]),
        prompt,
        message('assistant', [tool('{}')]),
      ]),
    ).toEqual({ toolName: 'Edit' });
  });

  it('allows an ID reused in a different turn but not within the selected turn', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), result()]),
        prompt,
        message('assistant', [tool('{}'), result()]),
      ]),
    ).toEqual({ toolName: 'Edit', finished: true });
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}'), result(), tool('{}'), result()]),
      ]),
    ).toEqual({ toolName: 'Edit' });
  });

  it('does not treat incomplete history as evidence of unfinished execution', () => {
    expect(
      describeLastAgentStep([message('assistant', [tool('{}')])]),
    ).toBeUndefined();
    expect(
      describeLastAgentStep([prompt, message('assistant', [tool('{}')])]),
    ).toEqual({ toolName: 'Edit' });
  });

  it('omits missing steps and excludes earlier turns', () => {
    expect(describeLastAgentStep([])).toBeUndefined();
    expect(
      describeLastAgentStep([message('assistant', [tool('{}')])]),
    ).toBeUndefined();
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}')]),
        prompt,
      ]),
    ).toBeUndefined();
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [tool('{}')]),
        message('user', []),
      ]),
    ).toBeUndefined();
  });

  it('selects the last invocation and does not reset on tool results', () => {
    const result: PersistedChatBlock = {
      type: 'tool_result',
      toolUseId: 'tool',
      toolName: 'Edit',
      output: 'done',
      isError: false,
    };
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [
          tool('{}'),
          tool('{"path":"src/last.ts"}', 'Read'),
        ]),
        message('user', [result]),
        message('system', [result]),
      ]),
    ).toEqual({ toolName: 'Read', detail: 'src/last.ts' });
  });

  it('prefers the persisted display projection and normalizes whitespace', () => {
    expect(
      describeLastAgentStep([
        prompt,
        message('assistant', [
          {
            type: 'tool_use',
            toolUseId: 'tool',
            toolName: 'provider_tool',
            input: '{"path":"private.txt"}',
            display: {
              toolName: '  Edit\n file  ',
              input: '{"file_path":"src/hello   world.ts"}',
            },
          },
        ]),
      ]),
    ).toEqual({ toolName: 'Edit file', detail: 'src/hello world.ts' });
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{"path":42}',
    '{"path":{}}',
    '{"command":"secret"}',
    '{"pattern":"secret","url":"https://user:secret@example.test"}',
    '{"path":"https://user:secret@example.test/file"}',
    '{"path":"src/https://user:secret@example.test/file"}',
    '{"path":"./C:/private/file.ts"}',
  ])('safely omits unsupported input %s', (input) => {
    expect(step(input)).toEqual({ toolName: 'Edit' });
  });

  it.each([
    ['/repo/src/a.ts', '/repo', 'src/a.ts'],
    ['/repo-sibling/private/a.ts', '/repo', 'a.ts'],
    ['/repo/../private/a.ts', '/repo', 'a.ts'],
    ['/repo/src/../a.ts', '/repo', 'a.ts'],
    ['../private/a.ts', '/repo', 'a.ts'],
    ['src/../a.ts', '/repo', 'a.ts'],
    ['/private/a.ts', undefined, 'a.ts'],
    ['src/a.ts', undefined, 'src/a.ts'],
    ['C:\\Repo\\src\\a.ts', 'c:\\repo', 'src/a.ts'],
    ['C:\\Repo-other\\private\\a.ts', 'C:\\Repo', 'a.ts'],
    ['C:\\Repo\\..\\private\\a.ts', 'C:\\Repo', 'a.ts'],
    ['D:\\Repo\\private\\a.ts', 'C:\\Repo', 'a.ts'],
    [
      '\\\\server\\share\\repo\\src\\a.ts',
      '\\\\server\\share\\repo',
      'src/a.ts',
    ],
  ])('projects %s within %s', (path, root, detail) => {
    expect(step(JSON.stringify({ notebook_path: path }), root)).toEqual({
      toolName: 'Edit',
      detail,
    });
  });

  it('bounds the final detail including the ellipsis', () => {
    expect(
      step(JSON.stringify({ path: `src/${'a'.repeat(100)}` }))?.detail,
    ).toBe(`src/${'a'.repeat(75)}…`);
  });
});
