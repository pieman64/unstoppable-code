export type E2eBuildUnit = 'main' | 'preload' | 'renderer';

export const E2E_BUILD_UNITS: readonly E2eBuildUnit[];

export function isE2eBuildInput(
  unit: E2eBuildUnit,
  relativePath: string,
): boolean;

export function toRepoRelativeInputPath(
  repoRoot: string,
  id: unknown,
): string | null;

export function findE2eBuildInputViolations(
  unit: E2eBuildUnit,
  repoRoot: string,
  ids: Iterable<unknown>,
): string[];

export function formatE2eBuildInputViolations(
  unit: E2eBuildUnit,
  violations: readonly string[],
): string;
