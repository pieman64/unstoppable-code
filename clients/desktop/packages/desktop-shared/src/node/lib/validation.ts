const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateId(value: string, label: string): void {
  if (!value || !SAFE_ID_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: must be lowercase alphanumeric with hyphens`,
    );
  }
}
