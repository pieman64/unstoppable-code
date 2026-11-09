import { CANOPY_JSON_ID_PATTERN } from '@canopy/protocol/canopy-json';

export function validateId(value: string, label: string): void {
  if (!value || !CANOPY_JSON_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label}: must be lowercase alphanumeric with hyphens`,
    );
  }
}
