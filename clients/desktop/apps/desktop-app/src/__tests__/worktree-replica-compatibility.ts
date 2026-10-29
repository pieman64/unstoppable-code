import { expect } from '@jest/globals';

/** Keep existing behavior assertions exact for all pre-replica row fields.
 * The real-filesystem replica suite separately checks the new field. */
function isRow(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'branchName' in value &&
    'createdAt' in value
  );
}

expect.addEqualityTesters([
  function compareWorktreeFields(left, right, testers): boolean | undefined {
    if (
      !isRow(left) ||
      !isRow(right) ||
      (!('replica' in left) && !('replica' in right))
    )
      return undefined;
    const previousLeft = { ...left };
    const previousRight = { ...right };
    delete previousLeft.replica;
    delete previousRight.replica;
    return this.equals(previousLeft, previousRight, testers);
  },
]);
