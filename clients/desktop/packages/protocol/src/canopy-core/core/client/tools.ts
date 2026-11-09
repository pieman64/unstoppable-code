import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { defineCanopyInstruction } from '../../definitions';
import { CanopyJsonValueSchema } from '../../errors';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

/*
 * Lease-bound interface agent tools (CAN-4131). An interface registers the
 * catalog tools it implements on its own lease; core advertises them only to
 * sessions bound while the lease lives and delivers each call to exactly one
 * lease. The catalog is closed: core, not the interface, decides what a tool
 * means and what the model sees.
 */
export const CORE_CLIENT_TOOLS_REGISTER = 'core.client.tools.register';
export const CORE_CLIENT_TOOLS_UNREGISTER = 'core.client.tools.unregister';
export const INTERFACE_TOOL_ERROR_CODES = [
  'core.client.tools.invalidState',
  'core.client.tools.revisionConflict',
  'core.client.tools.notFound',
] as const;
export const INTERFACE_TOOL_CATEGORIES = [
  'presentation',
  'editor_context',
  'native_intent',
] as const;
export type InterfaceToolCategory = (typeof INTERFACE_TOOL_CATEGORIES)[number];
/** Categories a registration may use. native_intent is never admitted on this path. */
export const ADMITTED_INTERFACE_TOOL_CATEGORIES: readonly InterfaceToolCategory[] =
  ['presentation', 'editor_context'];
export const INTERFACE_SURFACES = ['main', 'app-advisor'] as const;
export type InterfaceSurface = (typeof INTERFACE_SURFACES)[number];
export const INTERFACE_TOOL_INPUT_MAX_BYTES = 262_144;
export const INTERFACE_TOOL_REPLY_MAX_BYTES = 1_048_576;
export const INTERFACE_TOOL_DEFAULT_DEADLINE_MS = 30_000;

export interface InterfaceToolCatalogEntry {
  readonly version: number;
  readonly category: InterfaceToolCategory;
  /** Interface surfaces allowed to serve the tool. */
  readonly surfaces: readonly InterfaceSurface[];
  readonly deadlineMs: number;
  /** Always false: no catalog tool feeds canonical domain state. */
  readonly affectsCanonicalState: false;
  readonly description: string;
}

/**
 * The Pipeline Editor's draft is editor context, not canonical state: core
 * saves pipelines itself (CAN-5822), so none of these tools writes one.
 */
function pipelineEditorTool(description: string): InterfaceToolCatalogEntry {
  return Object.freeze({
    version: 1,
    category: 'editor_context',
    surfaces: Object.freeze(['main'] as const),
    deadlineMs: INTERFACE_TOOL_DEFAULT_DEADLINE_MS,
    affectsCanonicalState: false,
    description,
  });
}

export const INTERFACE_TOOL_CATALOG = Object.freeze({
  'ui.app_advisor.present': Object.freeze({
    version: 1,
    category: 'presentation',
    surfaces: Object.freeze(['main'] as const),
    deadlineMs: INTERFACE_TOOL_DEFAULT_DEADLINE_MS,
    affectsCanonicalState: false,
    description:
      'Run one App Advisor navigation, panel or window action in the main window for the user.',
  }),
  'ui.app_advisor.show_files': Object.freeze({
    version: 1,
    category: 'presentation',
    surfaces: Object.freeze(['app-advisor'] as const),
    deadlineMs: INTERFACE_TOOL_DEFAULT_DEADLINE_MS,
    affectsCanonicalState: false,
    description:
      "Open files in the App Advisor window's file panel for the user.",
  }),
  'ui.show_files': Object.freeze({
    version: 1,
    category: 'presentation',
    surfaces: Object.freeze(['main'] as const),
    deadlineMs: INTERFACE_TOOL_DEFAULT_DEADLINE_MS,
    affectsCanonicalState: false,
    description: 'Open workspace files in the main window for the user.',
  }),
  'ui.get_current_ui_state': Object.freeze({
    version: 1,
    category: 'presentation',
    surfaces: Object.freeze(['main'] as const),
    deadlineMs: INTERFACE_TOOL_DEFAULT_DEADLINE_MS,
    affectsCanonicalState: false,
    description: 'Read a snapshot of what the main window shows.',
  }),
  'ui.pipeline_editor.list': pipelineEditorTool(
    "List the pipelines the main window's Pipeline Editor can open.",
  ),
  'ui.pipeline_editor.open': pipelineEditorTool(
    'Open one pipeline in the Pipeline Editor.',
  ),
  'ui.pipeline_editor.create': pipelineEditorTool(
    'Start a new pipeline draft in the Pipeline Editor.',
  ),
  'ui.pipeline_editor.get_current': pipelineEditorTool(
    "Read the Pipeline Editor's current draft, dirty state and validation.",
  ),
  'ui.pipeline_editor.set_yaml': pipelineEditorTool(
    "Replace the Pipeline Editor's draft with new YAML, without saving it.",
  ),
  'ui.pipeline_editor.to_list': pipelineEditorTool(
    'Return the Pipeline Editor to the pipeline list.',
  ),
  'ui.pipeline_editor.prepare_save': pipelineEditorTool(
    'Read the draft the Pipeline Editor would save and the revision it loaded.',
  ),
  'ui.pipeline_editor.adopt_saved': pipelineEditorTool(
    'Show a pipeline that core saved as the saved state of the Pipeline Editor.',
  ),
} satisfies Record<string, InterfaceToolCatalogEntry>);
export type InterfaceToolName = keyof typeof INTERFACE_TOOL_CATALOG;
export const INTERFACE_TOOL_NAMES: readonly InterfaceToolName[] = Object.freeze(
  Object.keys(INTERFACE_TOOL_CATALOG).filter(isInterfaceToolName).sort(),
);

export function isInterfaceToolName(
  value: unknown,
): value is InterfaceToolName {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(INTERFACE_TOOL_CATALOG, value)
  );
}

const json = CanopyJsonValueSchema;
const jsonObject = z.object({}).catchall(json);
const toolName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);

export const CoreClientToolDescriptorSchema = z
  .object({
    name: toolName,
    description: z.string().min(1).max(4_096),
    category: z.enum(INTERFACE_TOOL_CATEGORIES),
    version: z.number().int().min(1),
    inputSchema: jsonObject,
    outputSchema: jsonObject,
  })
  .catchall(json);
export type CoreClientToolDescriptor = z.output<
  typeof CoreClientToolDescriptorSchema
>;

// The binding resolves the lease from the authenticated caller, never params.
export const CoreClientToolsRegisterParamsSchema = z.strictObject({
  tools: z.array(CoreClientToolDescriptorSchema).max(128),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});
export const CoreClientToolsRegisterResultSchema = z
  .object({
    registrationRevision: z.number().int().nonnegative(),
    effectiveToolNames: z.array(z.string()),
  })
  .catchall(json);
export type CoreClientToolsRegisterResult = z.output<
  typeof CoreClientToolsRegisterResultSchema
>;

export const CoreClientToolsUnregisterParamsSchema = z
  .strictObject({
    toolNames: z.array(toolName).max(128).optional(),
    all: z.boolean().optional(),
    _meta: CanopyRequestMetadataSchema.optional(),
  })
  .refine(
    (params) => (params.all === true) !== (params.toolNames !== undefined),
    { message: 'Pass either toolNames or all: true.' },
  );
export const CoreClientToolsUnregisterResultSchema = z
  .object({
    registrationRevision: z.number().int().nonnegative(),
    removedToolNames: z.array(z.string()),
  })
  .catchall(json);
export type CoreClientToolsUnregisterResult = z.output<
  typeof CoreClientToolsUnregisterResultSchema
>;

export const CoreClientToolsRegisterErrorSchema = keyedOperationErrorSchema(
  INTERFACE_TOOL_ERROR_CODES,
);
export const CoreClientToolsUnregisterErrorSchema =
  inherentOperationErrorSchema(INTERFACE_TOOL_ERROR_CODES);

/** Served only where a host binds leases to them (the desktop renderer relay, CAN-4131). Not in the transport registry. */
export const CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS = {
  'core.client.tools.register': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: ['core.client.manage'],
    params: CoreClientToolsRegisterParamsSchema,
    result: CoreClientToolsRegisterResultSchema,
    error: CoreClientToolsRegisterErrorSchema,
  }),
  'core.client.tools.unregister': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.client.manage'],
    params: CoreClientToolsUnregisterParamsSchema,
    result: CoreClientToolsUnregisterResultSchema,
    error: CoreClientToolsUnregisterErrorSchema,
  }),
};

/** The descriptor an interface sends for a catalog tool (renderer helper). */
export function interfaceToolDescriptor(
  name: InterfaceToolName,
): CoreClientToolDescriptor {
  const entry = INTERFACE_TOOL_CATALOG[name];
  return {
    name,
    description: entry.description,
    category: entry.category,
    version: entry.version,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  };
}
