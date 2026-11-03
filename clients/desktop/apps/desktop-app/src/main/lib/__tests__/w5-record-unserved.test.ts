// CAN-5531: the work counter for W5 records the daemon record port cannot serve.
jest.mock('../main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { logMainProcessWarn } from '../main-process-logging';
import {
  recordW5RecordUnserved,
  w5RecordUnservedCounts,
} from '../w5-record-unserved';

const warn = jest.mocked(logMainProcessWarn);

it('counts every refusal by operation and class, and logs the count at each power of two', () => {
  for (let index = 0; index < 9; index += 1)
    recordW5RecordUnserved('core.workspaceRecords.capture', 'limit-exceeded');
  recordW5RecordUnserved('w5.worktree_list.write', 'unsupported-id');

  expect(Object.fromEntries(w5RecordUnservedCounts())).toEqual({
    'core.workspaceRecords.capture limit-exceeded': 9,
    'w5.worktree_list.write unsupported-id': 1,
  });
  expect(warn.mock.calls).toEqual(
    [1, 2, 4, 8]
      .map((count) => [
        'W5 record port cannot serve a record',
        {
          operation: 'core.workspaceRecords.capture',
          reason: 'limit-exceeded',
          count,
        },
      ])
      .concat([
        [
          'W5 record port cannot serve a record',
          {
            operation: 'w5.worktree_list.write',
            reason: 'unsupported-id',
            count: 1,
          },
        ],
      ]),
  );
});
