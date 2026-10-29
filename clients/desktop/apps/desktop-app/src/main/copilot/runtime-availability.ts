/** Cheap projections never import the runtime, installer or SDK. */
let availability: boolean | undefined;
let generation = 0;

export function peekCopilotRuntimeAvailability(): boolean | undefined {
  return availability;
}

export function beginCopilotAvailabilityProbe(): (available: boolean) => void {
  const epoch = ++generation;
  return (available) => {
    if (epoch === generation) availability = available;
  };
}

export function invalidateCopilotRuntimeAvailability(): void {
  generation++;
  availability = false;
}

/** An explicit execution or cold Portal probe may load the managed status reader. */
export async function isCopilotRuntimeAvailable(): Promise<boolean> {
  try {
    const { isCopilotHarnessEnabled } = await import('./feature-flag');
    if (!isCopilotHarnessEnabled()) {
      invalidateCopilotRuntimeAvailability();
      return false;
    }
    const { copilotConnectionStatus } = await import('./connection');
    const status = await copilotConnectionStatus();
    return (
      status.supported && status.installed && status.enabled && !!status.account
    );
  } catch {
    invalidateCopilotRuntimeAvailability();
    return false;
  }
}
