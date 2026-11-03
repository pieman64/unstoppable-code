/** A caller-supplied identifier failed {@link validateId}. */
export class IdentifierValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentifierValidationError';
  }
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The workspace, worktree and repository id charset. */
export function validateId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !value || !SAFE_ID_RE.test(value)) {
    throw new IdentifierValidationError(
      `Invalid ${label}: must be lowercase alphanumeric with hyphens`,
    );
  }
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** `baseId`, or the first free `baseId-<n>` from 2. */
export function uniqueId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) return baseId;
  let n = 2;
  while (existingIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}
