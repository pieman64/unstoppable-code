import { LinearClient } from '@linear/sdk';

export function createLinearClient(apiKey: string): unknown {
  const clientConstructor: unknown = LinearClient;
  if (typeof clientConstructor !== 'function') {
    throw new Error('Linear client is unavailable');
  }

  // UI-automation seam (Doc 9 §2): redirect the SDK off api.linear.app only
  // when the action bundle was built with the E2E build-time define. This is
  // intentionally NOT runtime env-controlled, because the Linear API key is in
  // this process env and must not be redirectable in production.
  const apiUrl =
    typeof __CANOPY_E2E__ !== 'undefined' &&
    __CANOPY_E2E__ &&
    typeof __CANOPY_LINEAR_API_BASE_URL__ === 'string'
      ? __CANOPY_LINEAR_API_BASE_URL__.trim()
      : undefined;
  const options: { apiKey: string; apiUrl?: string } =
    apiUrl && apiUrl.length > 0 ? { apiKey, apiUrl } : { apiKey };

  return Reflect.construct(clientConstructor, [options]);
}
