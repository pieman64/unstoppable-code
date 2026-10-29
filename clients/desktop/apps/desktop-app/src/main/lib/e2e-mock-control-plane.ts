import { isRecord } from './type-guards';

/**
 * Shared client for the UI-automation mock server's control plane
 * (`/__mock/...` endpoints), so the endpoint contract — origin normalization,
 * bearer scheme, and payload validation — lives in one place instead of being
 * re-implemented per consumer.
 *
 * Every function gates its env reads on the build-time `__CANOPY_E2E__`
 * constant internally, so even if a production bundle retains this module the
 * mock env names fold away with the dead branches and no runtime env var can
 * activate a redirect in a shipped app.
 */

/**
 * Origin of the UI-automation mock server, or null when the redirect is not
 * configured (or in production builds, where this folds to `return null`).
 */
export function getMockLlmOrigin(): string | null {
  if (__CANOPY_E2E__) {
    const baseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL?.trim();
    return baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  }
  return null;
}

/** Bearer credential expected by the mock server's control plane. */
export function getMockApiKey(): string {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_MOCK_API_KEY ?? 'mock';
  }
  return 'mock';
}

/**
 * Optional UI-automation endpoint that receives external URLs instead of
 * launching the host browser. Production builds fold this entire env read
 * away; E2E builds without a receiver preserve the historical no-op.
 */
export function getE2eExternalOpenCaptureUrl(): string | null {
  if (__CANOPY_E2E__) {
    const captureUrl = process.env.CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL?.trim();
    return captureUrl || null;
  }
  return null;
}

/**
 * GET a JSON record from the mock control plane. Throws on non-OK responses
 * and non-record payloads so callers fail closed instead of falling through
 * to real binaries or live endpoints.
 */
export async function fetchMockControlPlaneRecord(
  origin: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${getMockApiKey()}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Mock control plane ${path} responded ${response.status}`);
  }
  const payload: unknown = JSON.parse(await response.text());
  if (!isRecord(payload)) {
    throw new Error(
      `Mock control plane ${path} returned a non-record payload.`,
    );
  }
  return payload;
}
