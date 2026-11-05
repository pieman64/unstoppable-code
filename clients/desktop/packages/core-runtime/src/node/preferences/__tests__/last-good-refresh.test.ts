import { createLastGoodRefresher } from '../last-good-refresh';
import { MemoryPreferencesDocument } from './fixtures/memory-document';

describe('last-good refresh qualification (CAN-4471)', () => {
  it('installs only the newest pending bytes, one at a time, in order', async () => {
    const document = new MemoryPreferencesDocument();
    const refresher = createLastGoodRefresher({ error: jest.fn() });
    const gate = document.holdInstall('lastGood');
    refresher.schedule(document, 'A');
    await gate.started;
    refresher.schedule(document, 'B');
    refresher.schedule(document, 'C');
    expect(refresher.running()).toHaveLength(1);
    gate.release();
    await refresher.wait(document);
    expect(document.installs).toEqual([
      { slot: 'lastGood', content: 'A' },
      { slot: 'lastGood', content: 'C' },
    ]);
    expect(document.slots.get('lastGood')).toBe('C');
    expect(refresher.running()).toEqual([]);
  });

  it('wait resolves after a failed refresh and logs it', async () => {
    const document = new MemoryPreferencesDocument();
    const failure = new Error('install failed');
    document.installFailures.set('lastGood', failure);
    const error = jest.fn();
    const refresher = createLastGoodRefresher({ error });
    refresher.schedule(document, 'confirmed');
    await expect(refresher.wait(document)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'Failed to refresh the last-good preferences backup:',
      failure,
    );
    expect(refresher.running()).toEqual([]);
  });
});
