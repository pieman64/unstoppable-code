import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type TerminalSettings,
  type UpdateTerminalSettingsRequest,
  type UpdateTerminalSettingsResponse,
} from '@canopy/desktop-shared/types';
import {
  readTerminalSettingsThroughCore,
  updateTerminalSettingsThroughCore,
  type TerminalSettingsDispatcher,
} from '../canopy-runtime/terminal-settings-dispatch';
import { registerIpcHandler } from './register';

export function registerTerminalSettingsHandlers(
  dispatcher: TerminalSettingsDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  // core.terminal.settings.get
  registerIpcHandler<[], TerminalSettings>(
    IPC_CHANNELS.terminalGetSettings,
    (event) =>
      readTerminalSettingsThroughCore(dispatcher, resolveCaller(event)),
  );
  // core.terminal.settings.update
  registerIpcHandler<
    [UpdateTerminalSettingsRequest],
    UpdateTerminalSettingsResponse
  >(IPC_CHANNELS.terminalUpdateSettings, (event, request) =>
    updateTerminalSettingsThroughCore(
      dispatcher,
      resolveCaller(event),
      request,
    ),
  );
}
