import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type ResourceMonitorSnapshot,
} from '@canopy/desktop-shared/types';
import {
  readResourceMonitorSnapshotThroughCore,
  type ExecutionStatusDispatcher,
} from '../canopy-runtime/resource-monitor-dispatch';
import { registerIpcHandler } from './register';

export function registerResourceMonitorHandlers(
  dispatcher: ExecutionStatusDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  // core.execution.status.get
  registerIpcHandler<[], ResourceMonitorSnapshot>(
    IPC_CHANNELS.resourceMonitorGetSnapshot,
    (event) =>
      readResourceMonitorSnapshotThroughCore(dispatcher, resolveCaller(event)),
  );
}
