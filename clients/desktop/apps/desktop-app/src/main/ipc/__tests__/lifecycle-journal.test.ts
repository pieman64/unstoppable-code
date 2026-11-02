import { homedir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { lifecycleJournalLocationLabel } from '../../lib/w5-lifecycle-journal-quarantine';
import { registerLifecycleJournalHandlers } from '../lifecycle-journal';

const handlers = new Map<
  string,
  (event: unknown, request?: unknown) => Promise<unknown>
>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request?: unknown) => Promise<unknown>,
  ): void => {
    handlers.set(channel, handler);
  },
}));

const mockInspect = jest.fn<Promise<unknown>, unknown[]>();
const mockQuarantine = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../lib/w5-lifecycle-journal-quarantine', () => ({
  ...jest.requireActual<object>('../../lib/w5-lifecycle-journal-quarantine'),
  inspectLifecycleJournal: (...args: unknown[]): Promise<unknown> =>
    mockInspect(...args),
  quarantineLifecycleJournalEntry: (...args: unknown[]): Promise<unknown> =>
    mockQuarantine(...args),
}));

function label(projector: unknown, path: string): unknown {
  if (typeof projector !== 'function') throw new Error('No label projector');
  return Reflect.apply(projector, undefined, [path]);
}

it('shows the desktop its local location, not the Portal default', async () => {
  mockInspect.mockResolvedValue({ status: 'clear', locationLabel: 'x' });
  mockQuarantine.mockResolvedValue({ status: 'quarantined' });
  registerLifecycleJournalHandlers();
  const request = { name: `${'a'.repeat(64)}.json`, identity: '1:2:3' };
  await handlers.get(IPC_CHANNELS.lifecycleJournalInspect)?.({});
  await handlers.get(IPC_CHANNELS.lifecycleJournalQuarantine)?.({}, request);
  const [inspectCall] = mockInspect.mock.calls;
  const [quarantineCall] = mockQuarantine.mock.calls;
  expect(quarantineCall?.[0]).toBe(request);
  const inHome = join(homedir(), 'data', 'w5');
  const outside = join('/', 'srv', 'canopy', 'w5');
  for (const projector of [inspectCall?.[0], quarantineCall?.[1]]) {
    expect(label(projector, inHome)).toBe(
      lifecycleJournalLocationLabel(inHome),
    );
    expect(label(projector, inHome)).not.toContain(homedir());
    expect(label(projector, outside)).toBe(outside);
  }
});
