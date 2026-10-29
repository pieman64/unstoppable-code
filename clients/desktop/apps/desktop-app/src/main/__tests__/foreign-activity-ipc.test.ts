import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerForeignActivityHandlers } from '../ipc/foreign-activity';
import { sendToAllWindows } from '../lib/window-send';

let mockListener: ((projection: ForeignActivityProjection) => void) | undefined;
jest.mock('../services/foreign-activity-carryover-service', () => ({
  getForeignActivityCarryoverService: (): object => ({
    subscribe: (listener: typeof mockListener): void => {
      mockListener = listener;
    },
  }),
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));

it('broadcasts foreign activity through the safe window sender', (): void => {
  registerForeignActivityHandlers();
  const projection: ForeignActivityProjection = {
    epoch: 'epoch',
    sequence: 1,
    groups: [],
  };
  mockListener?.(projection);
  expect(sendToAllWindows).toHaveBeenCalledWith(
    IPC_CHANNELS.foreignActivityChanged,
    projection,
  );
});
