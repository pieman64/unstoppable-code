import { isW5CommitLogWorkerData } from '../worker-contract';

const data = { dbPath: '/data/w5/log.sqlite', root: '/data/workspaces' };

// CAN-5153: hosts and workers without the field still interoperate.
describe('W5 commit log worker contract: data root', () => {
  it('accepts worker data with or without a data root', () => {
    expect(isW5CommitLogWorkerData(data)).toBe(true);
    expect(isW5CommitLogWorkerData({ ...data, dataRoot: '/data' })).toBe(true);
  });

  it.each<{ dataRoot: unknown }>([
    { dataRoot: '' },
    { dataRoot: 7 },
    { dataRoot: ['/data'] },
  ])('rejects a data root of the wrong shape: $dataRoot', ({ dataRoot }) => {
    expect(isW5CommitLogWorkerData({ ...data, dataRoot })).toBe(false);
  });
});
