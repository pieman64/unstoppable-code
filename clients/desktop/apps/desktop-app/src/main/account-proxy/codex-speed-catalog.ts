// The account proxy's own Codex catalog, for Ultra fast on proxied Codex
// turns (CAN-4302). CLIProxyAPI answers `GET /v1/models?client_version=` with
// the Codex `/models` wire catalog of the models its accounts serve, and
// clears `service_tiers` for a model any non-Codex account also serves. The
// tiers are the proxy's, not one account's: if the proxy moves a request to an
// account that refuses the tier, that refusal becomes a temporary denial on
// the proxy route, and nothing is retried at another speed.

import { isRecord } from '../lib/type-guards';
import { parseCodexSpeedCatalogWireModel } from '@canopy/desktop-shared/lib/codex-speed-availability';
import type { CodexSpeedCatalogModel } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  setCodexSpeedRouteCatalogSource,
  type CodexSpeedRouteCatalogFetch,
} from '../model-routing/codex-account-models';
import { ACCOUNT_PROXY_OPEN_SERVER_TOKEN } from './client-key';
import {
  accountProxyServingSignal,
  accountProxySettingsSignature,
  getAccountProxyRouteTarget,
  revealAccountProxyClientKey,
} from './service';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 2_000;

/** Reads at most {@link MAX_RESPONSE_BYTES}, counting bytes as they arrive. */
async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The account proxy model list is too large.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The models of a Codex `/models` wire catalog body. */
export function parseAccountProxyCodexCatalog(
  body: unknown,
): CodexSpeedRouteCatalogFetch {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error('The account proxy returned an invalid model list.');
  }
  const models: CodexSpeedCatalogModel[] = [];
  for (const entry of body.models.slice(0, MAX_MODELS)) {
    const model = parseCodexSpeedCatalogWireModel(entry);
    if (model) models.push(model);
  }
  return { models, truncated: body.models.length > MAX_MODELS };
}

/**
 * Read the proxy's Codex catalog with this device's client key, or null when
 * the proxy would not take Codex work now.
 */
export async function fetchAccountProxyCodexCatalog(): Promise<CodexSpeedRouteCatalogFetch | null> {
  const target = await getAccountProxyRouteTarget('codex');
  if (!target) return null;
  const token =
    target.clientKey === null
      ? ACCOUNT_PROXY_OPEN_SERVER_TOKEN
      : revealAccountProxyClientKey(target.clientKey);
  // The proxy on this device stopped after the target was read.
  if (token === null) return null;
  const url = new URL(`${target.connection.url}/v1/models`);
  url.searchParams.set('client_version', __DEP_CODEX_CLI__);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      accountProxyServingSignal(),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `The account proxy model list failed (${String(response.status)}).`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(response));
  } catch {
    throw new Error('The account proxy returned an invalid model list.');
  }
  return parseAccountProxyCodexCatalog(body);
}

/** Make the proxy's catalog the account proxy route's speed catalog. */
export function registerAccountProxyCodexSpeedCatalog(): void {
  setCodexSpeedRouteCatalogSource('account-proxy', {
    key: () => accountProxySettingsSignature('codex'),
    fetch: fetchAccountProxyCodexCatalog,
  });
}
