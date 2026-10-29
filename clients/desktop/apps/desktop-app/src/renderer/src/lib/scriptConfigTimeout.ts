import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';

export function parseCustomTimeoutDraft(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SCRIPT_TIMEOUT_SECONDS
  ) {
    return undefined;
  }
  return parsed;
}

export function getCustomTimeoutDraft(
  timeoutSeconds: number | null | undefined,
): string {
  return typeof timeoutSeconds === 'number' ? String(timeoutSeconds) : '';
}
