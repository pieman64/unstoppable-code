// How GitHub refuses a pull request create or update. Shared by the direct
// create flow and the `core.pullRequest.*` request handle (CAN-4109).

function property(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, name)
    : undefined;
}

function mentionsBaseBranch(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /\bbase\b/i.test(value) &&
    /\b(branch|ref|sha)\b/i.test(value)
  );
}

function mentionsExisting(value: unknown): boolean {
  return typeof value === 'string' && /already exists/i.test(value);
}

/** GitHub's 422 validation errors, or `[]`. */
function validationErrors(error: unknown): unknown[] {
  if (property(error, 'status') !== 422) return [];
  const errors = property(
    property(property(error, 'response'), 'data'),
    'errors',
  );
  return Array.isArray(errors) ? errors : [];
}

/** GitHub refused the base branch: it does not exist, or is no valid base. */
export function isPrBaseBranchCreationError(error: unknown): boolean {
  const stderr = property(error, 'stderr');
  if (
    mentionsBaseBranch(property(error, 'message')) ||
    (typeof stderr === 'string' && mentionsBaseBranch(stderr))
  )
    return true;
  if (property(error, 'status') !== 422) return false;
  if (
    mentionsBaseBranch(
      property(property(property(error, 'response'), 'data'), 'message'),
    )
  )
    return true;
  return validationErrors(error).some((entry) => {
    const field = property(entry, 'field');
    return (
      property(entry, 'resource') === 'PullRequest' &&
      (field === 'base' ||
        field === 'base_ref' ||
        mentionsBaseBranch(property(entry, 'message')))
    );
  });
}

/** GitHub reports an open pull request for the head branch already. */
export function isDuplicatePrError(error: unknown): boolean {
  if (error instanceof Error && mentionsExisting(error.message)) return true;
  return validationErrors(error).some((entry) =>
    mentionsExisting(property(entry, 'message')),
  );
}
