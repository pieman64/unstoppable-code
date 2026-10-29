export const BILLING_TOP_UP_MIN_USD = 5;
export const BILLING_TOP_UP_MAX_USD = 1000;

export const MODEL_LIBRARY_UNLOCK_SOURCES = [
  'picker',
  'banner',
  'proxy_error',
  'pricing',
  'desktop',
  'billing',
] as const;
export type ModelLibraryUnlockSource =
  (typeof MODEL_LIBRARY_UNLOCK_SOURCES)[number];
export function isModelLibraryUnlockSource(
  value: unknown,
): value is ModelLibraryUnlockSource {
  return MODEL_LIBRARY_UNLOCK_SOURCES.some((source) => source === value);
}
export interface BillingTopUpIntent {
  amountUsd?: number;
  reason: 'credits' | 'unlock_models';
  source: ModelLibraryUnlockSource;
  modelId?: string;
  chatId?: string;
  requestId?: string;
  webReturnPath?: string;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_./:\[\]-]{0,191}$/;
const REQUEST = /^[a-zA-Z0-9_-]{1,128}$/;
export function isBillingIntentIdentifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
export function isBillingRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST.test(value);
}
export function isBillingWebReturnPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  )
    return false;
  try {
    return (
      new URL(value, 'https://billing.invalid').origin ===
      'https://billing.invalid'
    );
  } catch {
    return false;
  }
}
export function parseBillingTopUpIntent(
  params: URLSearchParams,
): BillingTopUpIntent | null {
  const keys = [
    'topUp',
    'amountUsd',
    'reason',
    'source',
    'modelId',
    'chatId',
    'requestId',
    'webReturnPath',
  ];
  if (
    keys.some((key) => params.getAll(key).length > 1) ||
    params.get('topUp') !== '1'
  )
    return null;
  const reason = params.get('reason');
  const source = params.get('source');
  if (
    (reason !== 'credits' && reason !== 'unlock_models') ||
    !isModelLibraryUnlockSource(source)
  )
    return null;
  const intent: BillingTopUpIntent = { reason, source };
  const amount = params.get('amountUsd');
  if (amount !== null) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
    const value = Number(amount);
    if (
      !Number.isFinite(value) ||
      value < BILLING_TOP_UP_MIN_USD ||
      value > BILLING_TOP_UP_MAX_USD
    )
      return null;
    intent.amountUsd = value;
  }
  for (const key of ['modelId', 'chatId'] as const) {
    const value = params.get(key);
    if (value !== null) {
      if (!isBillingIntentIdentifier(value)) return null;
      intent[key] = value;
    }
  }
  const requestId = params.get('requestId');
  if (requestId !== null) {
    if (!isBillingRequestId(requestId)) return null;
    intent.requestId = requestId;
  }
  const path = params.get('webReturnPath');
  if (path !== null) {
    if (!isBillingWebReturnPath(path)) return null;
    intent.webReturnPath = path;
  }
  return intent;
}
/** Append intent to the existing owner-specific path, retaining unrelated queries. */
export function buildBillingTopUpIntentPath(
  billingPath: string,
  intent: BillingTopUpIntent,
): string {
  if (!isBillingWebReturnPath(billingPath))
    throw new Error('Invalid billing path');
  const url = new URL(billingPath, 'https://billing.invalid');
  for (const key of [
    'topUp',
    'amountUsd',
    'reason',
    'source',
    'modelId',
    'chatId',
    'requestId',
    'webReturnPath',
  ])
    url.searchParams.delete(key);
  url.searchParams.set('topUp', '1');
  for (const [key, value] of Object.entries(intent))
    if (value !== undefined) url.searchParams.set(key, String(value));
  if (!parseBillingTopUpIntent(url.searchParams))
    throw new Error('Invalid top-up intent');
  return url.pathname + url.search + url.hash;
}
export interface DesktopBillingDeepLink {
  requestId: string;
  modelId?: string;
  chatId?: string;
}
export function parseDesktopBillingDeepLink(
  raw: string,
  scheme: string,
): DesktopBillingDeepLink | null {
  if (raw.length > 2048 || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== 'billing' ||
      url.pathname !== '/unlocked' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    const keys = ['requestId', 'modelId', 'chatId'];
    if (
      Array.from(url.searchParams.keys()).some(
        (key) =>
          !keys.includes(key) || url.searchParams.getAll(key).length !== 1,
      )
    )
      return null;
    const requestId = url.searchParams.get('requestId');
    if (!isBillingRequestId(requestId)) return null;
    const result: DesktopBillingDeepLink = { requestId };
    for (const key of ['modelId', 'chatId'] as const) {
      const value = url.searchParams.get(key);
      if (value !== null) {
        if (!isBillingIntentIdentifier(value)) return null;
        result[key] = value;
      }
    }
    return result;
  } catch {
    return null;
  }
}
export function buildDesktopBillingDeepLink(
  intent: DesktopBillingDeepLink,
  scheme: string,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(intent))
    if (value !== undefined) params.set(key, String(value));
  const raw = `${scheme}://billing/unlocked?${params}`;
  if (!parseDesktopBillingDeepLink(raw, scheme))
    throw new Error('Invalid desktop billing link');
  return raw;
}

export const BILLING_NO_SAVED_CARD_CODE = 'no_saved_card';
export interface BillingPaymentMethodSummary {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}
export interface TopUpChargeBreakdown {
  baseCents: number;
  feeCents: number;
  totalCents: number;
}
export function computeTopUpChargeBreakdown(
  baseCents: number,
  feePercent: number,
): TopUpChargeBreakdown {
  const feeCents = Math.round((baseCents * feePercent) / 100);
  return { baseCents, feeCents, totalCents: baseCents + feeCents };
}
