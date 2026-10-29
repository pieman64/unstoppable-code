import {
  redactCopilotTextParts,
  redactCopilotToolValue,
} from '../text-redaction';

test('masks overlapping values across empty blocks and chunk boundaries', () => {
  expect(
    redactCopilotTextParts(
      ['before ABC', '', 'DEF', 'GH after'],
      ['ABCDEF', 'CDEFGH'],
    ),
  ).toEqual(['before ***', '', '', ' after']);
});

test('preserves unrelated blocks and masks escaped secret forms', () => {
  expect(
    redactCopilotTextParts(['one', 'two', 'three'], ['secret-value']),
  ).toEqual(['one', 'two', 'three']);
  expect(
    redactCopilotTextParts(['key=secret\\n', 'value'], ['secret\nvalue']),
  ).toEqual(['key=***', '']);
});

test('masks normalized and whitespace-only values across blocks without changing surrounding layout', () => {
  expect(
    redactCopilotTextParts(
      ['  before secret\n', '\t', 'value after\n'],
      ['secret value'],
    ),
  ).toEqual(['  before ***', '', ' after\n']);
  expect(redactCopilotTextParts(['x   ', '   y'], ['      '])).toEqual([
    'x***',
    'y',
  ]);
});

test('masks reflowed tool argument keys without losing collisions or renaming ordinary keys', () => {
  const input = {
    'secret\nvalue': { 'secret\tvalue': 'nested' },
    'secret   value': 'second',
    '***': 'ordinary',
    '***__1': 'reserved',
    list: [{ 'secret\r\nvalue': 'third' }],
  };
  expect(redactCopilotToolValue(input, ['secret value'])).toEqual({
    '***__2': { '***': 'nested' },
    '***__3': 'second',
    '***': 'ordinary',
    '***__1': 'reserved',
    list: [{ '***': 'third' }],
  });
  expect(Object.keys(input)[0]).toBe('secret\nvalue');
});
