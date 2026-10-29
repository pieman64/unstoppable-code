import { canopyModelName } from '@canopy/desktop-shared/lib/cursor-models';
import { parseCursorModelVariant } from '@canopy/desktop-shared/lib/cursor-thinking';
import { getMockApiKey, getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { isRecord } from '../lib/type-guards';
import { readCursorAccessToken } from './account-credentials';
import { cursorBackendHeaders, readCursorBackendJson } from './backend-request';

const AVAILABLE_MODELS =
  'https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels';
// The parameterized listing was about 390 KB for 43 models when verified.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_NAME_LENGTH = 100;
/** The account can accept the policy itself; any other reason needs an admin. */
const SELF_SERVE_REASON = 'individual_settings_blocked';
const FALLBACK_NAME = 'this model';

function displayName(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_NAME;
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return FALLBACK_NAME;
  return canopyModelName(name);
}

/**
 * Explains why Cursor refused a model with its settings notice, when the
 * reason is a data retention policy the account has not accepted. The pinned
 * CLI drops the backend's own detail, so this asks the backend's model listing
 * (one bounded, read-only request with the existing sign-in) whether the
 * selected model is blocked on consent. Any failure yields `undefined` so the
 * caller keeps its generic copy; nothing here changes account state.
 */
export async function cursorDataPolicyMessage(
  rawModelId: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const base = parseCursorModelVariant(rawModelId).base;
    const lookupSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    ]);
    const mock = __CANOPY_E2E__ ? getMockLlmOrigin() : null;
    const token = mock
      ? getMockApiKey()
      : await readCursorAccessToken(env, lookupSignal);
    if (!token) return undefined;
    let url = AVAILABLE_MODELS;
    if (__CANOPY_E2E__) {
      if (mock) url = `${mock}/__mock/cursor/AvailableModels`;
    }
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ useModelParameters: true }),
      redirect: 'error',
      signal: lookupSignal,
      headers: cursorBackendHeaders(token),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const listing = await readCursorBackendJson(response, MAX_RESPONSE_BYTES);
    if (!listing || !Array.isArray(listing.models)) return undefined;
    const models: unknown[] = listing.models;
    const model = models.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.name === base,
    );
    if (!model || model.requiresDataRetention !== true) return undefined;
    const reason = model.reasonForZdrConsentBlock;
    if (typeof reason !== 'string' || reason.length === 0) return undefined;
    const name = displayName(model.clientDisplayName);
    return reason === SELF_SERVE_REASON
      ? `To use ${name}, accept its data retention policy in your Cursor dashboard, then try again, or choose another model.`
      : `Ask your Cursor team admin to accept ${name}'s data retention policy, or choose another model.`;
  } catch {
    return undefined;
  }
}
