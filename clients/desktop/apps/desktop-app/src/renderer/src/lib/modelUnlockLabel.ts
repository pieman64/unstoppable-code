import { getModelDisplayName } from '@canopy/desktop-shared/types';

/**
 * The label for a pending unlock's model (CAN-5030), or `undefined` when the
 * registry cannot name it. `getModelDisplayName` falls back to the raw ID,
 * which the unlock copy must never show; its generic wording stands in.
 */
export function modelUnlockIntentLabel(
  modelId: string | null | undefined,
): string | undefined {
  if (modelId === null || modelId === undefined || modelId === '') {
    return undefined;
  }
  const label = getModelDisplayName(modelId);
  return label === modelId ? undefined : label;
}
