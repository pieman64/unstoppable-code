import { isPlanProposal } from '../plan-review';

test.each([
  [{ source: 'cursor', reviewMode: 'proposal' }, true],
  [{ source: 'codex' }, true],
  [{ source: 'opencode' }, true],
  [{ source: 'opencode', reviewMode: 'manual' }, false],
  [{ source: 'codex', reviewMode: 'manual' }, false],
  [{ source: 'cursor' }, false],
  [{ reviewMode: 'proposal' }, true],
  [undefined, false],
])('classifies proposal semantics %j', (value, expected) => {
  expect(isPlanProposal(value)).toBe(expected);
});
