import { foldToolResultsIntoToolUses } from '../tool-result-fold';

const call = {
  role: 'assistant',
  parts: [
    {
      kind: 'tool_use',
      data: { toolUseId: 'edit', toolName: 'Edit', input: '{}' },
    },
  ],
};
const interruption = { reason: 'app_restart', at: 180 };
const result = {
  role: 'system',
  parts: [
    {
      kind: 'tool_result',
      data: {
        toolUseId: 'edit',
        output: 'Interrupted by app restart',
        isError: true,
        interruption,
      },
    },
  ],
};

it('preserves interruption metadata when a result arrives in a later message', () => {
  expect(foldToolResultsIntoToolUses([call, result])[0].parts).toMatchObject([
    { data: { result: { interruption, isError: true } } },
  ]);
});

it('never pairs a later turn result with an older unresolved call', () => {
  const prompt = { role: 'user', parts: [], text: 'New work' };
  expect(foldToolResultsIntoToolUses([call, prompt, result])[0].parts).toEqual(
    call.parts,
  );
});

it('preserves native user-role results and in-turn steering', () => {
  const steering = {
    role: 'user',
    parts: [{ kind: 'steering', data: { startsTurn: false } }],
    text: 'Also check the heading',
  };
  expect(
    foldToolResultsIntoToolUses([
      call,
      steering,
      { ...result, role: 'user' },
    ])[0].parts,
  ).toMatchObject([{ data: { result: { interruption } } }]);
});
