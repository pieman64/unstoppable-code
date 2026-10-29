import { isOpenCodeHarnessEnabled } from './feature-flag';
/** Cheap projection; checking a catalog must never start the provider. */
let availability: boolean | undefined;
let revision = 0;
export function peekOpenCodeRuntimeAvailability(): boolean | undefined {
  return isOpenCodeHarnessEnabled() ? availability : false;
}
export function beginOpenCodeAvailabilityProbe(): (available: boolean) => void {
  const epoch = ++revision;
  return (value) => {
    if (epoch === revision) availability = value;
  };
}
export function invalidateOpenCodeRuntimeAvailability(): void {
  revision++;
  availability = false;
}
export async function isOpenCodeRuntimeAvailable(): Promise<boolean> {
  try {
    if (!isOpenCodeHarnessEnabled()) {
      invalidateOpenCodeRuntimeAvailability();
      return false;
    }
    const { opencodeConnectionStatus } = await import('./connection');
    const status = await opencodeConnectionStatus();
    return status.supported && status.installed && status.enabled;
  } catch {
    invalidateOpenCodeRuntimeAvailability();
    return false;
  }
}
