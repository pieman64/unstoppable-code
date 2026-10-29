import {
  IPC_CHANNELS,
  type ResourceMonitorSnapshot,
} from '@canopy/desktop-shared/types';
import { getResourceMonitorService } from '../resource-monitor';
import { registerIpcHandler } from './register';

export function registerResourceMonitorHandlers(): void {
  registerIpcHandler<[], ResourceMonitorSnapshot>(
    IPC_CHANNELS.resourceMonitorGetSnapshot,
    () => getResourceMonitorService().getSnapshot(),
  );
}
