import { MAX_ITERATIONS_LIMIT } from '@canopy/desktop-shared/pipelines/normalize-pipeline';

export function parseMaxIterationsInput(
  value: string,
): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_ITERATIONS_LIMIT
  ) {
    return null;
  }
  return parsed;
}
