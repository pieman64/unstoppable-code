import { BRAND } from '@canopy/brand/current';
import { getCanopyCloudBaseUrl } from '../../canopy-cloud/config';

/**
 * Fetch the published campaign config.
 *
 * Unauthenticated on purpose: the endpoint is public because this journey
 * targets users who have often never signed in, and sending a bearer token
 * they do not have would 401 exactly that cohort. See the route handler.
 *
 * Every failure — unconfigured base URL, offline, non-2xx, unparseable body —
 * throws, and the caller keeps whatever campaigns are already active. There is
 * no partial success to represent.
 */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchServedCampaignConfig(): Promise<unknown> {
  const baseUrl = getCanopyCloudBaseUrl();
  const url = `${baseUrl}/api/v1/${BRAND.web.apiNamespace}/notification-campaigns`;

  // Bounded: this runs during journey start, and an endpoint that accepts the
  // connection then stalls must not hold the startup path open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Campaign config request failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
