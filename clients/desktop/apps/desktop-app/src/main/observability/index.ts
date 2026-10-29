import { ObservabilityService } from './service';

let service: ObservabilityService | null = null;

export function getObservabilityService(): ObservabilityService {
  if (!service) {
    service = new ObservabilityService();
  }
  return service;
}

/**
 * The service if something already created it, without creating one. For
 * best-effort diagnostics from modules that must not bring the service up
 * themselves (main creates it at startup).
 */
export function peekObservabilityService(): ObservabilityService | null {
  return service;
}

export async function initializeObservabilityService(): Promise<ObservabilityService> {
  const instance = getObservabilityService();
  await instance.start();
  return instance;
}
