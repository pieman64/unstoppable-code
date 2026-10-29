import { IPC_CHANNELS } from '../types';
import { SCRIPT_ACTIONS_CHANNELS } from '@canopy/protocol/script-actions';
it('keeps IPC catalog names aligned with the portable bridge', () => {
  expect([
    IPC_CHANNELS.scriptActionsList,
    IPC_CHANNELS.scriptActionsRescan,
    IPC_CHANNELS.scriptActionsReview,
    IPC_CHANNELS.scriptActionsSetShortcut,
    IPC_CHANNELS.scriptActionsSetPinned,
    IPC_CHANNELS.scriptActionsEnableShellAliasScan,
    IPC_CHANNELS.scriptActionsReceipt,
    IPC_CHANNELS.scriptActionsChanged,
    IPC_CHANNELS.scriptActionsFound,
  ]).toEqual(Object.values(SCRIPT_ACTIONS_CHANNELS));
});
