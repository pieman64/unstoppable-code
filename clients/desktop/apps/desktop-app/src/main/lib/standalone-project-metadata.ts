import type { StandaloneProjectFile } from '@canopy/desktop-shared/types';

export function readStandaloneProjectMetadataFields(
  parsed: Record<string, unknown>,
): Pick<
  StandaloneProjectFile,
  'color' | 'description' | 'defaultModel' | 'defaultPresetId'
> {
  return {
    ...(typeof parsed.color === 'string' ? { color: parsed.color } : {}),
    ...(typeof parsed.description === 'string'
      ? { description: parsed.description }
      : {}),
    ...(typeof parsed.defaultModel === 'string'
      ? { defaultModel: parsed.defaultModel }
      : {}),
    ...(typeof parsed.defaultPresetId === 'string'
      ? { defaultPresetId: parsed.defaultPresetId }
      : {}),
  };
}
