export interface AgentActionField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface AgentActionCatalogEntry<
  TType extends string = string,
  TExample extends object = object,
> {
  type: TType;
  category: string;
  summary: string;
  fields: readonly AgentActionField[];
  example: TExample;
  additionalExamples?: readonly TExample[];
  keywords: readonly string[];
  notes?: readonly string[];
  requiredFeatureFlag?: string;
  requiredFeatureFlags?: readonly string[];
}
