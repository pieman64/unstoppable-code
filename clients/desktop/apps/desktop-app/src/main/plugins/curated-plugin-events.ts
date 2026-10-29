import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import type { CuratedPluginEventRequest } from '@canopy/protocol/plugin-catalog';
import { requestCanopyCloudNoContent } from '../canopy-cloud/client';

/**
 * Reports curated plugin installs to the catalog so adoption can be measured.
 *
 * Background sync materializes every curated plugin on every client, so
 * server-side content fetches say nothing about what a user actually chose.
 * This is the only signal that carries intent.
 *
 * Reporting is strictly best-effort and never blocks or fails an install: a
 * telemetry write must not be able to break the user's action. Failures are
 * dropped rather than retried in-process — the idempotency key exists so a
 * future retry (or a replayed queue) cannot double-count.
 */

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

/**
 * Fire-and-forget report that `curatedPluginKey` was installed.
 *
 * Resolves `true` when the catalog accepted the event, `false` on any failure
 * (cloud not configured, signed out, network, non-2xx). Callers may ignore the
 * result; it exists so tests can assert delivery.
 */
export async function reportCuratedPluginInstalled(
  curatedPluginKey: string,
  now: Date = new Date(),
): Promise<boolean> {
  const event: CuratedPluginEventRequest = {
    clientEventId: randomUUID(),
    curatedPluginKey,
    eventType: 'INSTALLED',
    occurredAt: now.toISOString(),
  };
  try {
    await requestCanopyCloudNoContent(`${API_PREFIX}/plugins/curated/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    return true;
  } catch {
    return false;
  }
}
