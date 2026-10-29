export const SECRET_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
]);

export function isSecretAutocomplete(
  value: string | null | undefined,
): boolean {
  if (value === null || value === undefined) return false;

  return value
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE_TOKENS.has(token));
}

export function classifySecretField(input: {
  tagName: string;
  type?: string | null;
  autocomplete?: string | null;
  insideSecretSelect: boolean;
  everPassword: boolean;
}): boolean {
  if (input.insideSecretSelect) return true;

  const tagName = input.tagName.toLowerCase();
  if (
    tagName === 'input' &&
    (input.type?.toLowerCase() === 'password' || input.everPassword)
  ) {
    return true;
  }

  if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') {
    return false;
  }

  return isSecretAutocomplete(input.autocomplete);
}

export const PASSWORD_HISTORY_RESOLVER_KEY =
  '__canopyBrowserPasswordHistoryResolver_v1';
export const INSPECT_RESOLVER_KEY = '__canopyBrowserInspectResolver_v1';
