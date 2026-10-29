/** Closed set of model family identifiers declared by model configuration. */
export const MODEL_FAMILY_IDENTIFIERS = [
  'claude',
  'codex',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'gpt-5.6',
  'gpt-5.5',
  'gpt-5.3-codex',
] as const;

export type ModelFamilyIdentifier = (typeof MODEL_FAMILY_IDENTIFIERS)[number];

/** Declared family metadata used to group and sort model picker rows. */
export interface ModelFamilyMetadata {
  readonly family: ModelFamilyIdentifier;
  readonly familyLabel: string;
  readonly vendor: string;
  readonly sortOrder: number;
}
