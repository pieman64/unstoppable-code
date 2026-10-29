import type { BrowserWindow } from 'electron';
import { ResourceMonitorService } from './service';

let singleton: ResourceMonitorService | null = null;

export function getResourceMonitorService(): ResourceMonitorService {
  if (!singleton) {
    singleton = new ResourceMonitorService();
  }
  return singleton;
}

export function disposeResourceMonitorService(): void {
  singleton?.dispose();
  singleton = null;
}

export function initializeResourceMonitorService(
  getWindow: () => BrowserWindow | null,
): ResourceMonitorService {
  const service = getResourceMonitorService();
  service.start(getWindow);
  return service;
}

export { ResourceGuardError } from './service';
export type {
  ResourceGuardReservation,
  ResourceProcessRegistration,
  ResourceRegistrationHandle,
} from './service';
