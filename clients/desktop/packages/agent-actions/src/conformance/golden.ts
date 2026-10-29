import { environmentActionCatalog } from '../families/environment/catalog';
import type { AgentJson } from '../response';
import {
  createReferenceHost,
  REFERENCE_HOST_CAPABILITIES,
} from './reference-host';
import { loadConformanceWorld } from './world';

/**
 * The golden surface: the reference host's tool definitions and the
 * environment catalog, for the conformance world's brand. Regenerate it with
 * `npm run agent-actions:golden`; the drift test fails when it is stale.
 */
export function buildAgentActionConformanceGolden(): AgentJson {
  const world = loadConformanceWorld();
  const host = createReferenceHost(world);
  const capabilities = REFERENCE_HOST_CAPABILITIES;
  return {
    brand: { ...world.brand },
    capabilities: {
      executionScope: capabilities.executionScope,
      actionTypes: [...capabilities.actionTypes],
      chatCreatePlacements: [...capabilities.chatCreatePlacements],
      watcherTriggers: [...capabilities.watcherTriggers],
      watcherTargetScope: capabilities.watcherTargetScope,
      split: { ...capabilities.split },
      hiddenInstructions: capabilities.hiddenInstructions,
      limits: capabilities.limits,
    },
    tools: host.surface.toolDefinitions().map(
      (definition): AgentJson => ({
        key: definition.key,
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    ),
    environmentCatalog: environmentActionCatalog(world.brand).map(
      (entry): AgentJson => ({
        type: entry.type,
        category: entry.category,
        summary: entry.summary,
        fields: entry.fields.map(
          (field): AgentJson => ({
            name: field.name,
            type: field.type,
            required: field.required,
            description: field.description,
          }),
        ),
        example: entry.example,
        ...(entry.additionalExamples
          ? { additionalExamples: [...entry.additionalExamples] }
          : {}),
        keywords: [...entry.keywords],
        ...(entry.notes ? { notes: [...entry.notes] } : {}),
      }),
    ),
  };
}
