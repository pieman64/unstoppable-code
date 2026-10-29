import type { AgentBrowserAction } from './types';
import {
  projectBrowserControlAction,
  projectBrowserPointerViewportAction,
} from './command';
import {
  BROWSER_TYPE_TEXT_LIMITS,
  browserTypeTextLimit,
} from './typing-budget';
import { z } from 'zod/v4';

const nonEmptyBrowserStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const browserKeySchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message:
      'key must name a key, such as "Enter", or "Space" for the space bar.',
  });

const browserFrameSchema = z
  .string()
  .min(1, 'frame must be a non-empty string.')
  .regex(/\S/, 'frame must be a non-empty string.')
  .describe(
    'Frame ref from browser.input_snapshot or CSS selector for the iframe element. Elements in iframes have their own refs; frame narrows a locator to one frame.',
  );

const browserActionIdSchema = z.string().trim().min(1).max(128).optional();

function browserActionTimeoutSchema(maxMs: number): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1).max(maxMs).optional();
}

function browserActionCommonFields(maxTimeoutMs: number): {
  actionId: typeof browserActionIdSchema;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
} {
  return {
    actionId: browserActionIdSchema,
    timeoutMs: browserActionTimeoutSchema(maxTimeoutMs),
  };
}

const browserMouseButtonSchema = z.enum(['left', 'right', 'middle']);
const browserKeyModifierSchema = z.enum(['Alt', 'Control', 'Meta', 'Shift']);
const browserWaitForStateSchema = z.enum([
  'visible',
  'hidden',
  'attached',
  'detached',
]);
const browserLoadStateSchema = z.enum([
  'load',
  'domcontentloaded',
  'network_idle',
]);
const browserClickPositionSchema = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
  })
  .strict();

/** Browser action schemas are intentionally audience-specific for phase-02 compatibility. */
export const browserConsoleLevelSchema = z.enum([
  'log',
  'info',
  'warning',
  'error',
  'debug',
]);
const browserTransferStatusSchema = z.enum([
  'in_progress',
  'paused',
  'complete',
  'cancelled',
  'interrupted',
  'failed',
]);
const browserListTransfersShape = {
  browserId: z.string().optional(),
  kind: z.enum(['download', 'copy', 'upload']).optional(),
  status: browserTransferStatusSchema.optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const browserCancelTransferShape = {
  browserId: z.string().optional(),
  transferId: z.string().min(1).regex(/\S/),
};
const browserSaveDownloadShape = {
  browserId: z.string().optional(),
  downloadId: z.string().min(1).regex(/\S/),
  path: z.string().min(1).max(4096).regex(/\S/),
  overwrite: z.boolean().optional(),
  ...browserActionCommonFields(120_000),
};

/** Saves the page as a PDF task file, the way Print → Save as PDF would. */
const browserSavePdfShape = {
  browserId: z.string().optional(),
  /** The name of the file, before `.pdf`; the page title when absent. */
  fileName: z.string().min(1).max(120).regex(/\S/).optional(),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
  scale: z.number().min(0.1).max(2).optional(),
  paperFormat: z.enum(['letter', 'legal', 'a4', 'a3', 'tabloid']).optional(),
  pageRanges: z.string().min(1).max(200).regex(/\S/).optional(),
  displayHeaderFooter: z.boolean().optional(),
  ...browserActionCommonFields(60_000),
};

export const browserDialogResponseSchema = z.object({
  accept: z.boolean(),
  promptText: z.string().max(10_000).optional(),
});
export const mcpBrowserProfileSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task') }).strict(),
  z
    .object({
      kind: z.literal('named'),
      profileId: nonEmptyBrowserStringSchema.max(256),
    })
    .strict(),
]);
export const advisorBrowserProfileSelectionSchema =
  mcpBrowserProfileSelectionSchema;
export const browserRuntimeTargetShape = {
  expectedRuntimeGeneration: z.number().int().positive().optional(),
};

export { BROWSER_ACTION_TYPES } from './actions';

const browserFocusAction = defineBrowserAction(
  'browser.focus',
  {
    ref: nonEmptyBrowserStringSchema.optional(),
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    ...browserActionCommonFields(60_000),
  },
  { target: 'ref-or-locator', timeoutMsMax: 60_000 },
);

export const browserDownloadWaitSchema = z.strictObject({
  downloadId: z.string().min(1).regex(/\S/).optional(),
});
export const browserUploadWaitSchema = z.strictObject({
  uploadId: z.string().min(1).regex(/\S/),
});

const browserWaitForAction = defineBrowserAction(
  'browser.wait_for',
  {
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    text: nonEmptyBrowserStringSchema.optional(),
    state: browserWaitForStateSchema.optional(),
    url: nonEmptyBrowserStringSchema.optional(),
    loadState: browserLoadStateSchema.optional(),
    download: browserDownloadWaitSchema.optional(),
    upload: browserUploadWaitSchema.optional(),
    ...browserActionCommonFields(120_000),
  },
  { waitFor: true, timeoutMsMax: 120_000 },
);

const pointerTargetFields = {
  ref: z.string().min(1).regex(/\S/).optional(),
  locator: z.string().min(1).regex(/\S/).optional(),
  frame: browserFrameSchema.optional(),
};
const browserElementTargetSchema = z.union([
  z.strictObject({ ref: z.string().min(1).regex(/\S/) }),
  z.strictObject({
    locator: z.string().min(1).regex(/\S/),
    frame: browserFrameSchema.optional(),
  }),
]);
const browserDragDestinationSchema = z.union([
  browserElementTargetSchema,
  browserClickPositionSchema,
  z.strictObject({ dx: z.number().finite(), dy: z.number().finite() }),
]);
const browserHoverAction = defineBrowserAction(
  'browser.hover',
  {
    ...pointerTargetFields,
    // Negative values move the pointer off the page.
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    ...browserActionCommonFields(60_000),
  },
  { target: 'ref-locator-or-point', timeoutMsMax: 60_000, strict: true },
);
const browserScrollAction = defineBrowserAction(
  'browser.scroll',
  {
    ...pointerTargetFields,
    direction: z.enum(['down', 'up', 'left', 'right']).optional(),
    pages: z
      .number({ error: 'browser.scroll pages must be from 0.1 to 10.' })
      .min(0.1, 'browser.scroll pages must be from 0.1 to 10.')
      .max(10, 'browser.scroll pages must be from 0.1 to 10.')
      .optional(),
    pixels: z
      .number({
        error: 'browser.scroll pixels must be an integer from 1 to 100,000.',
      })
      .int('browser.scroll pixels must be an integer from 1 to 100,000.')
      .min(1, 'browser.scroll pixels must be an integer from 1 to 100,000.')
      .max(
        100_000,
        'browser.scroll pixels must be an integer from 1 to 100,000.',
      )
      .optional(),
    intoView: z.literal(true).optional(),
    toText: z.string().min(1).regex(/\S/).optional(),
    ...browserActionCommonFields(60_000),
  },
  { scrollModes: true, timeoutMsMax: 60_000, strict: true },
);
const browserDragAction = defineBrowserAction(
  'browser.drag',
  {
    from: browserElementTargetSchema,
    to: browserDragDestinationSchema,
    steps: z
      .number({ error: 'browser.drag steps must be an integer from 1 to 100.' })
      .int('browser.drag steps must be an integer from 1 to 100.')
      .min(1, 'browser.drag steps must be an integer from 1 to 100.')
      .max(100, 'browser.drag steps must be an integer from 1 to 100.')
      .optional(),
    modifiers: z
      .array(browserKeyModifierSchema)
      .max(4)
      .refine(
        (modifiers) => new Set(modifiers).size === modifiers.length,
        'browser.drag modifiers must not contain duplicates.',
      )
      .optional(),
    ...browserActionCommonFields(60_000),
  },
  {
    nestedTargets: true,
    uniqueModifiers: true,
    timeoutMsMax: 60_000,
    strict: true,
  },
);
const browserSetCheckedAction = defineBrowserAction(
  'browser.set_checked',
  {
    ...pointerTargetFields,
    checked: z.boolean(),
    ...browserActionCommonFields(60_000),
  },
  { target: 'ref-or-locator', timeoutMsMax: 60_000, strict: true },
);
const browserSelectOptionAction = defineBrowserAction(
  'browser.select_option',
  {
    ...pointerTargetFields,
    values: z.array(z.string().max(500)).min(1).max(50).optional(),
    labels: z.array(z.string().min(1).max(500)).min(1).max(50).optional(),
    indexes: z
      .array(z.number().int().min(0).max(9_999))
      .min(1)
      .max(50)
      .optional(),
    searchText: z.string().min(1).max(200).optional(),
    ...browserActionCommonFields(60_000),
  },
  {
    optionChoice: true,
    target: 'ref-or-locator',
    timeoutMsMax: 60_000,
    strict: true,
  },
);
/** A file an agent may upload: a workspace path, a finished task download, or a chat attachment. */
const browserUploadSourceSchema = z.union([
  z.strictObject({ path: z.string().min(1).max(4096).regex(/\S/) }),
  z.strictObject({ downloadId: z.string().min(1).regex(/\S/) }),
  z.strictObject({ attachmentId: z.string().min(1).max(255).regex(/\S/) }),
]);
/** A file chooser an agent's action opened, from `effects.fileChooser`. */
const browserChooserIdSchema = z.string().min(1).regex(/\S/);
const browserUploadFilesAction = defineBrowserAction(
  'browser.upload_files',
  {
    ...pointerTargetFields,
    chooserId: browserChooserIdSchema.optional(),
    files: z.array(browserUploadSourceSchema).min(1).max(50),
    ...browserActionCommonFields(120_000),
  },
  { target: 'ref-locator-or-chooser', timeoutMsMax: 120_000, strict: true },
);
/** Waits for the user like an approval, so it has no timeout. */
const browserRequestFilesAction = defineBrowserAction(
  'browser.request_files',
  {
    ...pointerTargetFields,
    chooserId: browserChooserIdSchema.optional(),
    purpose: z.string().min(1).max(500).regex(/\S/).optional(),
    actionId: browserActionCommonFields(60_000).actionId,
  },
  { target: 'ref-locator-or-chooser', strict: true },
);
const browserDropFilesAction = defineBrowserAction(
  'browser.drop_files',
  {
    ...pointerTargetFields,
    files: z.array(browserUploadSourceSchema).min(1).max(50),
    ...browserActionCommonFields(120_000),
  },
  { target: 'ref-or-locator', timeoutMsMax: 120_000, strict: true },
);
const browserTypeTextMaxLength = 4_000;
const browserTypeDelayMaxMs = 500;
const browserTypeAction = defineBrowserAction(
  'browser.type',
  {
    ...pointerTargetFields,
    text: z.string().min(1).max(browserTypeTextMaxLength),
    delayMs: z.number().int().min(0).max(browserTypeDelayMaxMs).optional(),
    ...browserActionCommonFields(60_000),
  },
  {
    target: 'optional-ref-or-locator',
    timeoutMsMax: 60_000,
    typingBudget: true,
    strict: true,
  },
);

const browserJsonSchemaActionDefinitions = [
  browserHoverAction,
  browserScrollAction,
  browserDragAction,
  browserSetCheckedAction,
  browserSelectOptionAction,
  browserTypeAction,
  browserUploadFilesAction,
  browserRequestFilesAction,
  browserDropFilesAction,
] as const;

/** MCP members in installed union order. Each object retains its original field order. */
export const mcpBrowserActionSchemas = [
  z.object({
    type: z.literal('browser.profile.preview_clear'),
    profileId: nonEmptyBrowserStringSchema,
    storageGeneration: z.number().int().positive(),
    metadataRevision: z.number().int().positive(),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cache') }).strict(),
      z.object({ kind: z.literal('reset') }).strict(),
      z.object({ kind: z.literal('site'), origin: z.string() }).strict(),
    ]),
  }),
  z.object({
    type: z.literal('browser.profile.clear'),
    operationId: nonEmptyBrowserStringSchema,
    token: nonEmptyBrowserStringSchema,
  }),
  z.object({
    type: z.literal('browser.profile.job_get'),
    jobId: nonEmptyBrowserStringSchema,
  }),
  z.object({
    type: z.literal('browser.profile.job_cancel'),
    jobId: nonEmptyBrowserStringSchema,
  }),
  z.object({
    type: z.literal('browser.profile.list'),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('browser.profile.get'),
    profileId: nonEmptyBrowserStringSchema,
  }),
  z.object({
    type: z.literal('browser.profile.switch'),
    operationId: nonEmptyBrowserStringSchema,
    browserId: nonEmptyBrowserStringSchema,
    expectedRuntimeGeneration: z.number().int().positive(),
    selection: mcpBrowserProfileSelectionSchema,
    mode: z.enum(['replace', 'new-tab']),
  }),
  z.object({ type: z.literal('browser.list') }),
  z.object({
    type: z.literal('browser.open'),
    handoff: z.boolean().optional(),
    ...browserRuntimeTargetShape,
    selection: mcpBrowserProfileSelectionSchema.optional(),
    url: z
      .string()
      .optional()
      .describe('HTTP(S), file URL, or absolute local file path.'),
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.navigate'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    url: z.string().describe('HTTP(S), file URL, or absolute local file path.'),
  }),
  z.object({
    type: z.literal('browser.back'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.forward'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.reload'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.stop'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.get_dialog'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.handle_dialog'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    dialogId: z.string().min(1),
    accept: z.boolean(),
    promptText: z.string().max(10_000).optional(),
  }),
  z.object({
    type: z.literal('browser.click'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    ref: nonEmptyBrowserStringSchema.optional(),
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    dialogResponse: browserDialogResponseSchema.optional(),
    button: browserMouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: z
      .array(browserKeyModifierSchema)
      .max(4)
      .refine((modifiers) => new Set(modifiers).size === modifiers.length)
      .optional(),
    position: browserClickPositionSchema.optional(),
    force: z.boolean().optional(),
    ...browserActionCommonFields(60_000),
  }),
  z.object({
    type: z.literal('browser.fill'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    ref: nonEmptyBrowserStringSchema.optional(),
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    text: z.string(),
    ...browserActionCommonFields(60_000),
  }),
  z.object({
    type: z.literal('browser.press'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    key: browserKeySchema,
    ref: nonEmptyBrowserStringSchema.optional(),
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    dialogResponse: browserDialogResponseSchema.optional(),
    ...browserActionCommonFields(60_000),
  }),
  browserFocusAction.mcp,
  browserWaitForAction.mcp,
  z.object({
    type: z.literal('browser.screenshot'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    saveToAttachments: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('browser.input_snapshot'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    frame: browserFrameSchema.optional(),
    inputType: nonEmptyBrowserStringSchema.optional(),
    role: nonEmptyBrowserStringSchema.optional(),
    name: nonEmptyBrowserStringSchema.optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('browser.inspect'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    ref: nonEmptyBrowserStringSchema.optional(),
    locator: nonEmptyBrowserStringSchema.optional(),
    frame: browserFrameSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    type: z.literal('browser.get_console'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    level: browserConsoleLevelSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('browser.get_network'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    failed: z.boolean().optional(),
    status: z.number().int().optional(),
    urlContains: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal('browser.start_recording'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
  }),
  z.object({
    type: z.literal('browser.stop_recording'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    saveToAttachments: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('browser.open_external'),
    ...browserRuntimeTargetShape,
    browserId: z.string().optional(),
    url: z.string().optional(),
  }),
  browserHoverAction.mcp,
  browserScrollAction.mcp,
  browserDragAction.mcp,
  browserSetCheckedAction.mcp,
  browserSelectOptionAction.mcp,
  browserTypeAction.mcp,
  z.object({
    type: z.literal('browser.list_transfers'),
    ...browserRuntimeTargetShape,
    ...browserListTransfersShape,
  }),
  z.object({
    type: z.literal('browser.cancel_transfer'),
    ...browserRuntimeTargetShape,
    ...browserCancelTransferShape,
  }),
  z.object({
    type: z.literal('browser.save_download'),
    ...browserRuntimeTargetShape,
    ...browserSaveDownloadShape,
  }),
  browserUploadFilesAction.mcp,
  browserRequestFilesAction.mcp,
  browserDropFilesAction.mcp,
  z.object({
    type: z.literal('browser.save_pdf'),
    ...browserRuntimeTargetShape,
    ...browserSavePdfShape,
  }),
] as const;

/**
 * The App Advisor scope fields every Advisor browser member carries right
 * after `type`. The host supplies the project and worktree ID validators,
 * which are its own policy.
 */
export interface AdvisorBrowserScopeShape {
  readonly expectedRuntimeGeneration: z.ZodOptional<z.ZodNumber>;
  readonly projectId: z.ZodOptional<z.ZodString>;
  readonly worktreeId: z.ZodOptional<z.ZodString>;
}

type McpBrowserMemberShape<TIndex extends number> =
  (typeof mcpBrowserActionSchemas)[TIndex]['shape'];

/**
 * An Advisor member's shape: the MCP member's fields with the Advisor scope in
 * place of MCP's optional runtime generation. `TOverride` holds the fields
 * whose Advisor type differs from MCP's (the profile selection, and
 * browser.profile.switch's required generation); they replace, not intersect.
 */
type AdvisorBrowserMember<
  TIndex extends number,
  TOverride extends z.ZodRawShape = Record<never, never>,
> = z.ZodObject<
  { type: McpBrowserMemberShape<TIndex>['type'] } & Omit<
    AdvisorBrowserScopeShape,
    keyof TOverride
  > &
    Omit<
      McpBrowserMemberShape<TIndex>,
      'type' | 'expectedRuntimeGeneration' | keyof TOverride
    > &
    TOverride
>;

export type AdvisorBrowserActionSchemas = readonly [
  AdvisorBrowserMember<0>,
  AdvisorBrowserMember<1>,
  AdvisorBrowserMember<2>,
  AdvisorBrowserMember<3>,
  AdvisorBrowserMember<4>,
  AdvisorBrowserMember<5>,
  AdvisorBrowserMember<
    6,
    {
      expectedRuntimeGeneration: z.ZodNumber;
      selection: typeof advisorBrowserProfileSelectionSchema;
    }
  >,
  AdvisorBrowserMember<7>,
  AdvisorBrowserMember<
    8,
    { selection: z.ZodOptional<typeof advisorBrowserProfileSelectionSchema> }
  >,
  AdvisorBrowserMember<9>,
  AdvisorBrowserMember<10>,
  AdvisorBrowserMember<11>,
  AdvisorBrowserMember<12>,
  AdvisorBrowserMember<13>,
  AdvisorBrowserMember<14>,
  AdvisorBrowserMember<15>,
  AdvisorBrowserMember<16>,
  AdvisorBrowserMember<17>,
  AdvisorBrowserMember<18>,
  ReturnType<typeof browserFocusAction.advisor>,
  ReturnType<typeof browserWaitForAction.advisor>,
  AdvisorBrowserMember<21>,
  AdvisorBrowserMember<22>,
  AdvisorBrowserMember<23>,
  AdvisorBrowserMember<24>,
  AdvisorBrowserMember<25>,
  AdvisorBrowserMember<26>,
  AdvisorBrowserMember<27>,
  AdvisorBrowserMember<28>,
  ReturnType<typeof browserHoverAction.advisor>,
  ReturnType<typeof browserScrollAction.advisor>,
  ReturnType<typeof browserDragAction.advisor>,
  ReturnType<typeof browserSetCheckedAction.advisor>,
  ReturnType<typeof browserSelectOptionAction.advisor>,
  ReturnType<typeof browserTypeAction.advisor>,
  AdvisorBrowserMember<35>,
  AdvisorBrowserMember<36>,
  AdvisorBrowserMember<37>,
  ReturnType<typeof browserUploadFilesAction.advisor>,
  ReturnType<typeof browserRequestFilesAction.advisor>,
  ReturnType<typeof browserDropFilesAction.advisor>,
  AdvisorBrowserMember<41>,
];

/** Advisor members in installed union order, with its host-owned scope validators. */
export function createAdvisorBrowserActionSchemas(
  scopeShape: AdvisorBrowserScopeShape,
): AdvisorBrowserActionSchemas {
  return [
    z.object({
      type: z.literal('browser.profile.preview_clear'),
      ...scopeShape,
      profileId: nonEmptyBrowserStringSchema,
      storageGeneration: z.number().int().positive(),
      metadataRevision: z.number().int().positive(),
      operation: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('cache') }).strict(),
        z.object({ kind: z.literal('reset') }).strict(),
        z.object({ kind: z.literal('site'), origin: z.string() }).strict(),
      ]),
    }),
    z.object({
      type: z.literal('browser.profile.clear'),
      ...scopeShape,
      operationId: nonEmptyBrowserStringSchema,
      token: nonEmptyBrowserStringSchema,
    }),
    z.object({
      type: z.literal('browser.profile.job_get'),
      ...scopeShape,
      jobId: nonEmptyBrowserStringSchema,
    }),
    z.object({
      type: z.literal('browser.profile.job_cancel'),
      ...scopeShape,
      jobId: nonEmptyBrowserStringSchema,
    }),
    z.object({
      type: z.literal('browser.profile.list'),
      ...scopeShape,
      offset: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal('browser.profile.get'),
      ...scopeShape,
      profileId: nonEmptyBrowserStringSchema,
    }),
    z.object({
      type: z.literal('browser.profile.switch'),
      ...scopeShape,
      operationId: nonEmptyBrowserStringSchema,
      browserId: nonEmptyBrowserStringSchema,
      expectedRuntimeGeneration: z.number().int().positive(),
      selection: advisorBrowserProfileSelectionSchema,
      mode: z.enum(['replace', 'new-tab']),
    }),
    z.object({
      type: z.literal('browser.list'),
      ...scopeShape,
    }),
    z.object({
      type: z.literal('browser.open'),
      handoff: z.boolean().optional(),
      ...scopeShape,
      selection: advisorBrowserProfileSelectionSchema.optional(),
      browserId: z.string().optional(),
      url: z
        .string()
        .optional()
        .describe('HTTP(S), file URL, or absolute local file path.'),
    }),
    z.object({
      type: z.literal('browser.navigate'),
      ...scopeShape,
      browserId: z.string().optional(),
      url: z
        .string()
        .describe('HTTP(S), file URL, or absolute local file path.'),
    }),
    z.object({
      type: z.literal('browser.back'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.forward'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.reload'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.stop'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.get_dialog'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.handle_dialog'),
      ...scopeShape,
      browserId: z.string().optional(),
      dialogId: z.string().min(1),
      ...browserDialogResponseSchema.shape,
    }),
    z.object({
      type: z.literal('browser.click'),
      ...scopeShape,
      browserId: z.string().optional(),
      ref: nonEmptyBrowserStringSchema.optional(),
      locator: nonEmptyBrowserStringSchema.optional(),
      frame: browserFrameSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      dialogResponse: browserDialogResponseSchema.optional(),
      button: browserMouseButtonSchema.optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      modifiers: z
        .array(browserKeyModifierSchema)
        .max(4)
        .refine((modifiers) => new Set(modifiers).size === modifiers.length)
        .optional(),
      position: browserClickPositionSchema.optional(),
      force: z.boolean().optional(),
      ...browserActionCommonFields(60_000),
    }),
    z.object({
      type: z.literal('browser.fill'),
      ...scopeShape,
      browserId: z.string().optional(),
      ref: nonEmptyBrowserStringSchema.optional(),
      locator: nonEmptyBrowserStringSchema.optional(),
      frame: browserFrameSchema.optional(),
      text: z.string(),
      ...browserActionCommonFields(60_000),
    }),
    z.object({
      type: z.literal('browser.press'),
      ...scopeShape,
      browserId: z.string().optional(),
      key: browserKeySchema,
      ref: nonEmptyBrowserStringSchema.optional(),
      locator: nonEmptyBrowserStringSchema.optional(),
      frame: browserFrameSchema.optional(),
      dialogResponse: browserDialogResponseSchema.optional(),
      ...browserActionCommonFields(60_000),
    }),
    browserFocusAction.advisor(scopeShape),
    browserWaitForAction.advisor(scopeShape),
    z.object({
      type: z.literal('browser.screenshot'),
      ...scopeShape,
      browserId: z.string().optional(),
      saveToAttachments: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('browser.input_snapshot'),
      ...scopeShape,
      browserId: z.string().optional(),
      frame: browserFrameSchema.optional(),
      inputType: nonEmptyBrowserStringSchema.optional(),
      role: nonEmptyBrowserStringSchema.optional(),
      name: nonEmptyBrowserStringSchema.optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    z.object({
      type: z.literal('browser.inspect'),
      ...scopeShape,
      browserId: z.string().optional(),
      ref: nonEmptyBrowserStringSchema.optional(),
      locator: nonEmptyBrowserStringSchema.optional(),
      frame: browserFrameSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    z.object({
      type: z.literal('browser.get_console'),
      ...scopeShape,
      browserId: z.string().optional(),
      level: browserConsoleLevelSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    z.object({
      type: z.literal('browser.get_network'),
      ...scopeShape,
      browserId: z.string().optional(),
      failed: z.boolean().optional(),
      status: z.number().int().optional(),
      urlContains: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    z.object({
      type: z.literal('browser.start_recording'),
      ...scopeShape,
      browserId: z.string().optional(),
    }),
    z.object({
      type: z.literal('browser.stop_recording'),
      ...scopeShape,
      browserId: z.string().optional(),
      saveToAttachments: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('browser.open_external'),
      ...scopeShape,
      browserId: z.string().optional(),
      url: z.string().optional(),
    }),
    browserHoverAction.advisor(scopeShape),
    browserScrollAction.advisor(scopeShape),
    browserDragAction.advisor(scopeShape),
    browserSetCheckedAction.advisor(scopeShape),
    browserSelectOptionAction.advisor(scopeShape),
    browserTypeAction.advisor(scopeShape),
    z.object({
      type: z.literal('browser.list_transfers'),
      ...scopeShape,
      ...browserListTransfersShape,
    }),
    z.object({
      type: z.literal('browser.cancel_transfer'),
      ...scopeShape,
      ...browserCancelTransferShape,
    }),
    z.object({
      type: z.literal('browser.save_download'),
      ...scopeShape,
      ...browserSaveDownloadShape,
    }),
    browserUploadFilesAction.advisor(scopeShape),
    browserRequestFilesAction.advisor(scopeShape),
    browserDropFilesAction.advisor(scopeShape),
    z.object({
      type: z.literal('browser.save_pdf'),
      ...scopeShape,
      ...browserSavePdfShape,
    }),
  ] as const;
}

export const ADVISOR_EXISTING_TAB_BROWSER_ACTIONS = new Set<string>([
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.stop',
  'browser.get_dialog',
  'browser.handle_dialog',
  'browser.click',
  'browser.fill',
  'browser.press',
  'browser.focus',
  'browser.wait_for',
  'browser.screenshot',
  'browser.input_snapshot',
  'browser.inspect',
  'browser.get_console',
  'browser.get_network',
  'browser.start_recording',
  'browser.stop_recording',
  'browser.open_external',
  'browser.hover',
  'browser.scroll',
  'browser.drag',
  'browser.set_checked',
  'browser.select_option',
  'browser.type',
  'browser.list_transfers',
  'browser.cancel_transfer',
  'browser.save_download',
  'browser.upload_files',
  'browser.request_files',
  'browser.drop_files',
  'browser.save_pdf',
]);

export interface BrowserActionTarget {
  readonly type: string;
  readonly ref?: string;
  readonly locator?: string;
  readonly chooserId?: string;
  readonly frame?: string;
  readonly x?: number;
  readonly y?: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly force?: boolean;
  readonly checked?: boolean;
  readonly text?: string;
  readonly delayMs?: number;
  readonly values?: readonly string[];
  readonly labels?: readonly string[];
  readonly indexes?: readonly number[];
  readonly searchText?: string;
  readonly state?: string;
  readonly url?: string;
  readonly loadState?: string;
  readonly download?: { downloadId?: string };
  readonly upload?: { uploadId: string };
  readonly direction?: string;
  readonly pages?: number;
  readonly pixels?: number;
  readonly intoView?: boolean;
  readonly toText?: string;
}

export interface AdvisorBrowserAction extends BrowserActionTarget {
  readonly browserId?: string;
  readonly expectedRuntimeGeneration?: number;
  readonly projectId?: string;
  readonly worktreeId?: string;
}

export interface BrowserActionRules {
  readonly strict?: true;
  readonly scrollModes?: true;
  readonly nestedTargets?: true;
  readonly uniqueModifiers?: true;
  readonly clickOptions?: true;
  readonly dialogResponse?: true;
  readonly optionChoice?: true;
  readonly required?: readonly string[];
  readonly timeoutMsMax?: number;
  readonly target?:
    | 'ref-locator-or-point'
    | 'ref-or-locator'
    | 'optional-ref-or-locator'
    | 'ref-locator-or-chooser';
  readonly typingBudget?: true;
  readonly waitFor?: true;
}

export type BrowserActionRuleEntry = readonly [
  type: string,
  rules: BrowserActionRules,
];

/** Ordered legacy rule registrations. New actions append [definition type, definition.rules]. */
export const MCP_BROWSER_ACTION_RULES: readonly BrowserActionRuleEntry[] = [
  [
    'browser.click',
    {
      clickOptions: true,
      dialogResponse: true,
      target: 'ref-locator-or-point',
      timeoutMsMax: 60_000,
    },
  ],
  ['browser.inspect', { target: 'ref-locator-or-point' }],
  [
    'browser.fill',
    { required: ['text'], target: 'ref-or-locator', timeoutMsMax: 60_000 },
  ],
  [
    'browser.press',
    {
      dialogResponse: true,
      required: ['key'],
      target: 'optional-ref-or-locator',
      timeoutMsMax: 60_000,
    },
  ],
  ['browser.handle_dialog', { required: ['dialogId', 'accept'] }],
  ['browser.navigate', { required: ['url'] }],
  browserFocusAction.ruleEntry,
  browserWaitForAction.ruleEntry,
  browserHoverAction.ruleEntry,
  browserScrollAction.ruleEntry,
  browserDragAction.ruleEntry,
  browserSetCheckedAction.ruleEntry,
  browserSelectOptionAction.ruleEntry,
  browserTypeAction.ruleEntry,
  browserUploadFilesAction.ruleEntry,
  browserRequestFilesAction.ruleEntry,
  browserDropFilesAction.ruleEntry,
];

function browserActionRulesFor(
  type: string,
  extra: readonly BrowserActionRuleEntry[],
): BrowserActionRules | undefined {
  return [...MCP_BROWSER_ACTION_RULES, ...extra].find(
    ([registeredType]) => registeredType === type,
  )?.[1];
}

export function addMcpBrowserTargetIssues(
  action: BrowserActionTarget,
  context: z.RefinementCtx,
  extra: readonly BrowserActionRuleEntry[] = [],
): void {
  addBrowserActionRuleIssues(
    action,
    context,
    browserActionRulesFor(action.type, extra),
  );
}

function addBrowserActionRuleIssues(
  action: BrowserActionTarget,
  context: z.RefinementCtx,
  rules: BrowserActionRules | undefined,
): void {
  const target = rules?.target;
  if (
    target &&
    action.frame !== undefined &&
    (!action.locator?.trim() ||
      action.ref !== undefined ||
      action.x !== undefined ||
      action.y !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${action.type} frame applies only to locators; a ref already identifies its frame.`,
    });
  }

  if (target === 'ref-locator-or-point') {
    const hasRef = Boolean(action.ref?.trim());
    const hasLocator = Boolean(action.locator?.trim());
    const hasX = action.x !== undefined;
    const hasY = action.y !== undefined;
    if (hasX !== hasY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires both x and y when using coordinates.`,
      });
    }
    const targetCount =
      Number(hasRef) + Number(hasLocator) + Number(hasX && hasY);
    if (targetCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires exactly one target: ref, locator, or an x/y coordinate pair. Use browser.input_snapshot to discover refs.`,
      });
    }
  }
  if (target === 'ref-or-locator') {
    const targetCount =
      Number(Boolean(action.ref?.trim())) +
      Number(Boolean(action.locator?.trim()));
    if (targetCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires exactly one of ref or locator. Use browser.input_snapshot to discover refs.`,
      });
    }
  }
  if (target === 'ref-locator-or-chooser') {
    const targetCount =
      Number(Boolean(action.ref?.trim())) +
      Number(Boolean(action.locator?.trim())) +
      Number(Boolean(action.chooserId?.trim()));
    if (targetCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires exactly one of ref, locator, or chooserId. Use browser.input_snapshot to discover refs.`,
      });
    }
  }
  if (
    target === 'optional-ref-or-locator' &&
    Boolean(action.ref?.trim()) &&
    Boolean(action.locator?.trim())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${action.type} accepts ref or locator, but not both.`,
    });
  }
  if (rules?.optionChoice) {
    const choiceCount =
      Number(action.values !== undefined) +
      Number(action.labels !== undefined) +
      Number(action.indexes !== undefined);
    if (choiceCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'browser.select_option requires exactly one of values, labels, or indexes.',
      });
    }
  }
  // A delay outside every band is reported by its own bound.
  const typeTextLimit = browserTypeTextLimit(action.delayMs);
  if (
    rules?.typingBudget &&
    action.text !== undefined &&
    typeTextLimit > 0 &&
    action.text.length > typeTextLimit
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `The text is too long at this delay: at most ${typeTextLimit} characters. Shorten the text or the delay.`,
    });
  }
  if (rules?.clickOptions) {
    if (
      action.position !== undefined &&
      (action.x !== undefined ||
        action.y !== undefined ||
        (!action.ref?.trim() && !action.locator?.trim()))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'browser.click position requires ref or locator and cannot be combined with x/y coordinates.',
      });
    }
    if (action.position !== undefined && action.force === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'browser.click position cannot be combined with force.',
      });
    }
  }
  if (rules?.scrollModes) {
    const issue = (message: string): void =>
      context.addIssue({ code: 'custom', message });
    const modes =
      Number(action.direction !== undefined) +
      Number(action.intoView !== undefined) +
      Number(action.toText !== undefined);
    if (modes !== 1)
      issue(
        'browser.scroll requires exactly one mode: direction, intoView: true, or toText.',
      );
    if (action.pages !== undefined && action.pixels !== undefined)
      issue('browser.scroll accepts pages or pixels, but not both.');
    if (
      (action.pages !== undefined || action.pixels !== undefined) &&
      action.direction === undefined
    )
      issue('browser.scroll pages and pixels require direction.');
    if (action.ref !== undefined && action.locator !== undefined)
      issue('browser.scroll accepts ref or locator, but not both.');
    if (
      action.intoView !== undefined &&
      action.ref === undefined &&
      action.locator === undefined
    )
      issue('browser.scroll intoView requires ref or locator.');
    if (
      action.toText !== undefined &&
      (action.ref !== undefined || action.locator !== undefined)
    )
      issue('browser.scroll toText cannot be combined with ref or locator.');
    if (
      action.frame !== undefined &&
      (action.ref !== undefined ||
        (action.locator === undefined && action.toText === undefined))
    )
      issue(
        'browser.scroll frame requires locator or toText; a ref already identifies its frame.',
      );
  }
  if (rules?.waitFor) {
    if (
      action.frame !== undefined &&
      ((action.locator === undefined && action.text === undefined) ||
        action.url !== undefined ||
        action.loadState !== undefined ||
        action.download !== undefined ||
        action.upload !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          action.upload !== undefined
            ? 'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, download, or upload.'
            : action.download === undefined
              ? 'browser.wait_for frame requires locator or text and cannot be combined with url or loadState.'
              : 'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, or download.',
      });
    }

    const conditionCount =
      Number(action.locator !== undefined) +
      Number(action.text !== undefined) +
      Number(action.url !== undefined) +
      Number(action.loadState !== undefined) +
      Number(action.download !== undefined) +
      Number(action.upload !== undefined);
    if (conditionCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          action.upload !== undefined
            ? 'browser.wait_for requires exactly one of locator, text, url, loadState, download, or upload.'
            : action.download === undefined
              ? 'browser.wait_for requires exactly one of locator, text, url, or loadState.'
              : 'browser.wait_for requires exactly one of locator, text, url, loadState, or download.',
      });
    }
    if (
      action.state !== undefined &&
      action.locator === undefined &&
      action.text === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'browser.wait_for state requires locator or text.',
      });
    }
  }
}

export function addAdvisorBrowserRuntimeIssues(
  action: AdvisorBrowserAction,
  context: z.RefinementCtx,
): void {
  addAdvisorBrowserGenerationIssue(action, context);
}

function addAdvisorBrowserGenerationIssue(
  action: AdvisorBrowserAction,
  context: z.RefinementCtx,
): void {
  if (
    (ADVISOR_EXISTING_TAB_BROWSER_ACTIONS.has(action.type) ||
      (action.type === 'browser.open' && action.browserId !== undefined)) &&
    (!('expectedRuntimeGeneration' in action) ||
      action.expectedRuntimeGeneration === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Existing-tab browser actions require expectedRuntimeGeneration from browser.list.',
    });
  }
}

export function addAdvisorBrowserActionIssues(
  action: AdvisorBrowserAction,
  context: z.RefinementCtx,
): void {
  if (!action.type.startsWith('browser.')) return;
  addBrowserActionRuleIssues(
    action,
    context,
    browserActionRulesFor(action.type, []),
  );
  if ((action.projectId === undefined) !== (action.worktreeId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Advisor browser actions require projectId and worktreeId together.',
    });
  }
  addAdvisorBrowserGenerationIssue(action, context);
}

export type RawAdvisorBrowserAction = z.output<
  AdvisorBrowserActionSchemas[number]
>;

export type ParsedAdvisorBrowserAction =
  | Exclude<
      RawAdvisorBrowserAction,
      {
        type:
          | 'browser.hover'
          | 'browser.scroll'
          | 'browser.drag'
          | 'browser.set_checked'
          | 'browser.select_option'
          | 'browser.type'
          | 'browser.upload_files'
          | 'browser.request_files'
          | 'browser.drop_files';
      }
    >
  | Extract<
      AgentBrowserAction,
      {
        type:
          | 'browser.hover'
          | 'browser.scroll'
          | 'browser.drag'
          | 'browser.set_checked'
          | 'browser.select_option'
          | 'browser.type'
          | 'browser.upload_files'
          | 'browser.request_files'
          | 'browser.drop_files';
      }
    >;

export type AdvisorBrowserActionParseResult =
  | { readonly ok: true; readonly action: ParsedAdvisorBrowserAction }
  | { readonly ok: false; readonly message: string };

export function parseAdvisorBrowserAction(
  value: unknown,
  scopeShape: AdvisorBrowserScopeShape,
): AdvisorBrowserActionParseResult {
  const result = z
    .union(createAdvisorBrowserActionSchemas(scopeShape))
    .superRefine(addAdvisorBrowserActionIssues)
    .safeParse(value);
  if (result.success) {
    const action = result.data;
    return {
      ok: true,
      action:
        action.type === 'browser.hover' ||
        action.type === 'browser.scroll' ||
        action.type === 'browser.drag'
          ? projectBrowserPointerViewportAction(action)
          : action.type === 'browser.set_checked' ||
              action.type === 'browser.select_option' ||
              action.type === 'browser.type' ||
              action.type === 'browser.upload_files' ||
              action.type === 'browser.request_files' ||
              action.type === 'browser.drop_files'
            ? projectBrowserControlAction(action)
            : action,
    };
  }
  return {
    ok: false,
    message: result.error.issues.map((issue) => issue.message).join('; '),
  };
}

type BrowserJsonValue =
  | null
  | boolean
  | number
  | string
  | BrowserJsonValue[]
  | { [key: string]: BrowserJsonValue };

function isBrowserJsonObject(
  value: BrowserJsonValue | undefined,
): value is { [key: string]: BrowserJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Declares every name a rule requires in the properties beside it, as an
 * empty schema, at every level of the rule, so schema checks that reject
 * undeclared required properties accept it. An empty schema accepts any
 * value, so validation is unchanged.
 */
function declareConditionRequirements(
  rule: BrowserJsonValue,
): BrowserJsonValue {
  if (Array.isArray(rule)) return rule.map(declareConditionRequirements);
  if (!isBrowserJsonObject(rule)) return rule;
  const declared: { [key: string]: BrowserJsonValue } = {};
  for (const [key, value] of Object.entries(rule))
    declared[key] =
      key === 'properties' ? value : declareConditionRequirements(value);
  const { properties, required } = declared;
  if (isBrowserJsonObject(properties) && Array.isArray(required)) {
    const named = { ...properties };
    for (const name of required)
      if (typeof name === 'string' && !(name in named)) named[name] = {};
    declared.properties = named;
  }
  return declared;
}

const MCP_BROWSER_TARGET_MODE_ORDER = [
  'ref-locator-or-point',
  'ref-or-locator',
  'optional-ref-or-locator',
  'ref-locator-or-chooser',
] as const;

function browserActionTypeCondition(types: readonly string[]): {
  if: { properties: { type: BrowserJsonValue }; required: string[] };
} {
  return {
    if: {
      properties: {
        type: types.length === 1 ? { const: types[0] } : { enum: [...types] },
      },
      required: ['type'],
    },
  };
}

function browserTargetAlternatives(
  target: NonNullable<BrowserActionRules['target']>,
): BrowserJsonValue[] {
  if (target === 'ref-locator-or-point') {
    return [
      {
        required: ['ref'],
        not: {
          anyOf: [
            { required: ['locator'] },
            { required: ['x'] },
            { required: ['y'] },
          ],
        },
      },
      {
        required: ['locator'],
        not: {
          anyOf: [
            { required: ['ref'] },
            { required: ['x'] },
            { required: ['y'] },
          ],
        },
      },
      {
        required: ['x', 'y'],
        not: {
          anyOf: [{ required: ['ref'] }, { required: ['locator'] }],
        },
      },
    ];
  }
  if (target === 'ref-locator-or-chooser') {
    const only = (key: string, others: string[]): BrowserJsonValue => ({
      required: [key],
      not: { anyOf: others.map((other) => ({ required: [other] })) },
    });
    return [
      only('ref', ['locator', 'chooserId']),
      only('locator', ['ref', 'chooserId']),
      only('chooserId', ['ref', 'locator']),
    ];
  }
  if (target === 'optional-ref-or-locator') {
    return [
      { not: { anyOf: [{ required: ['ref'] }, { required: ['locator'] }] } },
      { required: ['ref'], not: { required: ['locator'] } },
      { required: ['locator'], not: { required: ['ref'] } },
    ];
  }
  return [
    { required: ['ref'], not: { required: ['locator'] } },
    { required: ['locator'], not: { required: ['ref'] } },
  ];
}

function appendBrowserTargetRules(
  result: BrowserJsonValue[],
  entries: readonly BrowserActionRuleEntry[],
): void {
  for (const target of MCP_BROWSER_TARGET_MODE_ORDER) {
    const groups = new Map<
      string,
      { types: string[]; rules: BrowserActionRules }
    >();
    for (const [type, rules] of entries) {
      if (rules.target !== target) continue;
      const key = JSON.stringify([rules.required ?? [], rules.strict === true]);
      const group = groups.get(key);
      if (group) group.types.push(type);
      else groups.set(key, { types: [type], rules });
    }
    groups.forEach(({ types, rules }) => {
      const then: { [key: string]: BrowserJsonValue } = {};
      if (rules.required) then.required = [...rules.required];
      if (target !== 'optional-ref-or-locator' || rules.strict) {
        then.oneOf = browserTargetAlternatives(target);
      }
      if (Object.keys(then).length > 0) {
        result.push({ ...browserActionTypeCondition(types), then });
      }
    });
  }
}

/**
 * Emit dialogResponse first; then non-target required rules in registration order;
 * then target modes in fixed order, grouping actions with identical required fields.
 * Optional ref/locator has no JSON target condition (phase-02 compatibility).
 */
export function mcpBrowserDispatchJsonSchemaRules(
  extra: readonly BrowserActionRuleEntry[] = [],
): BrowserJsonValue[] {
  const entries = [...MCP_BROWSER_ACTION_RULES, ...extra];
  const result: BrowserJsonValue[] = [];
  const dialogTypes = entries
    .filter(([, rules]) => rules.dialogResponse)
    .map(([type]) => type);
  if (dialogTypes.length > 0) {
    result.push({
      ...browserActionTypeCondition(dialogTypes),
      else: { not: { required: ['dialogResponse'] } },
    });
  }
  for (const [type, rules] of entries) {
    if (!rules.target && rules.required) {
      result.push({
        ...browserActionTypeCondition([type]),
        then: { required: [...rules.required] },
      });
    }
  }
  appendBrowserTargetRules(result, [
    ...MCP_BROWSER_ACTION_RULES.slice(0, 6),
    ...extra,
  ]);
  appendBrowserTargetRules(result, MCP_BROWSER_ACTION_RULES.slice(6, 8));
  const timeoutGroups = new Map<number, string[]>();
  for (const [type, rules] of entries) {
    if (rules.timeoutMsMax === undefined) continue;
    const group = timeoutGroups.get(rules.timeoutMsMax);
    if (group) group.push(type);
    else timeoutGroups.set(rules.timeoutMsMax, [type]);
  }
  timeoutGroups.forEach((types, maxMs) => {
    result.push({
      if: {
        properties: {
          type: types.length === 1 ? { const: types[0] } : { enum: types },
        },
        required: ['type', 'timeoutMs'],
      },
      then: { properties: { timeoutMs: { maximum: maxMs } } },
    });
  });
  const clickTypes = entries
    .filter(([, rules]) => rules.clickOptions)
    .map(([type]) => type);
  for (const type of clickTypes) {
    const positionCondition = browserActionTypeCondition([type]);
    result.push({
      if: {
        properties: positionCondition.if.properties,
        required: [...positionCondition.if.required, 'position'],
      },
      then: {
        anyOf: [{ required: ['ref'] }, { required: ['locator'] }],
        not: { anyOf: [{ required: ['x'] }, { required: ['y'] }] },
      },
    });
    result.push({
      if: {
        properties: positionCondition.if.properties,
        required: [...positionCondition.if.required, 'position', 'force'],
      },
      then: { properties: { force: { const: false } } },
    });
    result.push({
      ...positionCondition,
      then: { properties: { modifiers: { uniqueItems: true } } },
    });
  }
  const waitTypes = entries
    .filter(([, rules]) => rules.waitFor)
    .map(([type]) => type);
  result.push(...browserWaitForJsonSchemaRules(waitTypes));
  result.push(...browserFrameJsonSchemaRules(entries));
  result.push(...browserPointerViewportJsonSchemaRules());
  return result.map(declareConditionRequirements);
}

/** JSON Schema frame conditions shared by the advertised dispatch surfaces. */
export function browserFrameJsonSchemaRules(
  entries: readonly BrowserActionRuleEntry[] = MCP_BROWSER_ACTION_RULES,
): BrowserJsonValue[] {
  const result: BrowserJsonValue[] = [];
  const targetGroups = [
    {
      types: entries
        .filter(
          ([, rules]) =>
            rules.target === 'ref-locator-or-point' && !rules.strict,
        )
        .map(([type]) => type),
      forbidden: ['ref', 'x', 'y'],
    },
    {
      types: entries
        .filter(
          ([, rules]) =>
            rules.target &&
            rules.target !== 'ref-locator-or-point' &&
            !rules.strict,
        )
        .map(([type]) => type),
      forbidden: ['ref'],
    },
  ];
  for (const { types, forbidden } of targetGroups) {
    if (types.length === 0) continue;
    const condition = browserActionTypeCondition(types);
    result.push({
      if: { properties: condition.if.properties, required: ['type', 'frame'] },
      then: {
        required: ['locator'],
        not:
          forbidden.length === 1
            ? { required: forbidden }
            : { anyOf: forbidden.map((field) => ({ required: [field] })) },
        properties: { frame: { type: 'string', minLength: 1, pattern: '\\S' } },
      },
    });
  }
  const waitTypes = entries
    .filter(([, rules]) => rules.waitFor)
    .map(([type]) => type);
  if (waitTypes.length > 0) {
    const condition = browserActionTypeCondition(waitTypes);
    result.push({
      if: { properties: condition.if.properties, required: ['type', 'frame'] },
      then: {
        anyOf: [{ required: ['locator'] }, { required: ['text'] }],
        not: {
          anyOf: [
            { required: ['url'] },
            { required: ['loadState'] },
            { required: ['download'] },
            { required: ['upload'] },
          ],
        },
        properties: { frame: { type: 'string', minLength: 1, pattern: '\\S' } },
      },
    });
  }
  const snapshotCondition = browserActionTypeCondition([
    'browser.input_snapshot',
  ]);
  result.push({
    if: {
      properties: snapshotCondition.if.properties,
      required: ['type', 'frame'],
    },
    then: {
      properties: { frame: { type: 'string', minLength: 1, pattern: '\\S' } },
    },
  });
  return result.map(declareConditionRequirements);
}

/** New kinds advertise the same strict shape and rule table on both routes. */
export function browserPointerViewportJsonSchemaRules(
  audience: 'mcp' | 'advisor' = 'mcp',
): BrowserJsonValue[] {
  const scope = {
    expectedRuntimeGeneration: z.number().int().positive().optional(),
    projectId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    worktreeId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
  };
  return browserJsonSchemaActionDefinitions
    .map((definition) => {
      const schema = z.toJSONSchema(
        audience === 'advisor' ? definition.advisor(scope) : definition.mcp,
        { target: 'draft-7', io: 'input' },
      );
      // Zod's JSON Schema is JSON data; parsing narrows it without a type assertion.
      const shape = jsonSchemaRecord(schema);
      const properties = browserJsonSchema.parse(shape.properties);
      if (audience === 'mcp') {
        // The trusted-scope preprocessor deliberately removes these two keys.
        properties.projectId = {};
        properties.worktreeId = {};
      }
      const allOf: BrowserJsonValue[] = [
        { properties: { actionId: { pattern: '\\S' } } },
      ];
      if (definition.rules.target) {
        allOf.push({
          oneOf: browserTargetAlternatives(definition.rules.target),
        });
        allOf.push({
          if: { required: ['frame'] },
          then: {
            required: ['locator'],
            not: {
              anyOf: ['ref', 'x', 'y'].map((field) => ({ required: [field] })),
            },
          },
        });
      }
      if (definition.rules.optionChoice) {
        allOf.push({
          oneOf: [
            {
              required: ['values'],
              not: {
                anyOf: [{ required: ['labels'] }, { required: ['indexes'] }],
              },
            },
            {
              required: ['labels'],
              not: {
                anyOf: [{ required: ['values'] }, { required: ['indexes'] }],
              },
            },
            {
              required: ['indexes'],
              not: {
                anyOf: [{ required: ['values'] }, { required: ['labels'] }],
              },
            },
          ],
        });
      }
      if (definition.rules.typingBudget) {
        allOf.push({
          anyOf: [
            ...BROWSER_TYPE_TEXT_LIMITS.map(
              (band): BrowserJsonValue => ({
                required: ['delayMs'],
                properties: {
                  delayMs: {
                    minimum: band.minDelayMs,
                    maximum: band.maxDelayMs,
                  },
                  text: { maxLength: band.maxLength },
                },
              }),
            ),
            {
              not: { required: ['delayMs'] },
              properties: { text: { maxLength: browserTypeTextLimit() } },
            },
          ],
        });
      }
      if (definition.rules.scrollModes) {
        allOf.push({
          oneOf: [
            {
              required: ['direction'],
              not: {
                anyOf: [
                  { required: ['intoView'] },
                  { required: ['toText'] },
                  { required: ['pages', 'pixels'] },
                  { required: ['ref', 'locator'] },
                ],
              },
            },
            {
              required: ['intoView'],
              anyOf: [{ required: ['ref'] }, { required: ['locator'] }],
              not: {
                anyOf: [
                  { required: ['direction'] },
                  { required: ['toText'] },
                  { required: ['pages'] },
                  { required: ['pixels'] },
                  { required: ['ref', 'locator'] },
                ],
              },
            },
            {
              required: ['toText'],
              ...excludesObject([
                'direction',
                'intoView',
                'pages',
                'pixels',
                'ref',
                'locator',
              ]),
            },
          ],
        });
        allOf.push({
          if: { required: ['frame'] },
          then: {
            anyOf: [{ required: ['locator'] }, { required: ['toText'] }],
            ...excludesObject(['ref']),
          },
        });
      }
      if (definition.rules.uniqueModifiers)
        allOf.push({ properties: { modifiers: { uniqueItems: true } } });
      if (audience === 'advisor') {
        allOf.push({ required: ['expectedRuntimeGeneration'] });
        allOf.push({
          oneOf: [
            { required: ['projectId', 'worktreeId'] },
            {
              not: {
                anyOf: [
                  { required: ['projectId'] },
                  { required: ['worktreeId'] },
                ],
              },
            },
          ],
        });
        allOf.push({
          properties: { projectId: { not: { const: 'app-advisor' } } },
        });
      }
      return {
        ...browserActionTypeCondition([definition.mcp.shape.type.value]),
        then: { ...shape, properties, allOf },
      };
    })
    .map(declareConditionRequirements);
}

function excludesObject(fields: string[]): { not: BrowserJsonValue } {
  return { not: { anyOf: fields.map((field) => ({ required: [field] })) } };
}
const browserJsonSchema: z.ZodType<{ [key: string]: BrowserJsonValue }> =
  z.record(z.string(), z.json());

/**
 * For new actions only: legacy members retain their audience schemas above.
 * Append `definition.ruleEntry` to both validators' extra list to register its
 * cross-field rules without editing either validator.
 */
export function defineBrowserAction<
  TType extends string,
  TFields extends Record<string, z.ZodType>,
>(
  type: TType,
  fields: TFields,
  rules: BrowserActionRules = {},
): {
  rules: BrowserActionRules;
  ruleEntry: BrowserActionRuleEntry;
  mcp: z.ZodObject<
    {
      type: z.ZodLiteral<TType>;
      expectedRuntimeGeneration: typeof browserRuntimeTargetShape.expectedRuntimeGeneration;
      browserId: z.ZodOptional<z.ZodString>;
    } & TFields
  >;
  advisor: (scopeShape: AdvisorBrowserScopeShape) => z.ZodObject<
    { type: z.ZodLiteral<TType> } & AdvisorBrowserScopeShape & {
        browserId: z.ZodOptional<z.ZodString>;
      } & TFields
  >;
} {
  return {
    rules,
    ruleEntry: [type, rules],
    mcp: (rules.strict ? z.strictObject : z.object)({
      type: z.literal(type),
      ...browserRuntimeTargetShape,
      browserId: z.string().optional(),
      ...fields,
    }),
    advisor: (
      scopeShape: AdvisorBrowserScopeShape,
    ): z.ZodObject<
      { type: z.ZodLiteral<TType> } & AdvisorBrowserScopeShape & {
          browserId: z.ZodOptional<z.ZodString>;
        } & TFields
    > =>
      (rules.strict ? z.strictObject : z.object)({
        type: z.literal(type),
        ...scopeShape,
        browserId: z.string().optional(),
        ...fields,
      }),
  };
}

/** Additional DispatchAction fields, derived from the same action shapes. */
export function browserPointerViewportJsonSchemaProperties(): {
  [key: string]: BrowserJsonValue;
} {
  const schema = z.object({
    direction: browserScrollAction.mcp.shape.direction,
    pages: browserScrollAction.mcp.shape.pages,
    pixels: browserScrollAction.mcp.shape.pixels,
    intoView: browserScrollAction.mcp.shape.intoView,
    toText: browserScrollAction.mcp.shape.toText,
    from: browserDragAction.mcp.shape.from.optional(),
    to: browserDragAction.mcp.shape.to.optional(),
    steps: browserDragAction.mcp.shape.steps,
    checked: browserSetCheckedAction.mcp.shape.checked,
    values: browserSelectOptionAction.mcp.shape.values,
    labels: browserSelectOptionAction.mcp.shape.labels,
    indexes: browserSelectOptionAction.mcp.shape.indexes,
    searchText: browserSelectOptionAction.mcp.shape.searchText,
    delayMs: browserTypeAction.mcp.shape.delayMs,
  });
  const json = jsonSchemaRecord(
    z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }),
  );
  return browserJsonSchema.parse(json.properties);
}

function jsonSchemaRecord(value: unknown): { [key: string]: BrowserJsonValue } {
  // Zod includes its standard-schema adapter as functions; JSON transport omits it.
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  return browserJsonSchema.parse(serialized);
}

/** Transfer filters apply only to their action, not other actions' status/kind fields. */
export function browserTransferJsonSchemaRules(): BrowserJsonValue[] {
  const rules: BrowserJsonValue[] = [
    {
      if: {
        properties: { type: { const: 'browser.list_transfers' } },
        required: ['type'],
      },
      then: {
        properties: {
          kind: { enum: ['download', 'copy', 'upload'] },
          status: {
            enum: [
              'in_progress',
              'paused',
              'complete',
              'cancelled',
              'interrupted',
              'failed',
            ],
          },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
    {
      if: {
        properties: { type: { const: 'browser.cancel_transfer' } },
        required: ['type'],
      },
      then: {
        required: ['transferId'],
        properties: {
          transferId: { type: 'string', minLength: 1, pattern: '\\S' },
        },
      },
    },
    {
      if: {
        properties: { type: { const: 'browser.save_download' } },
        required: ['type'],
      },
      then: {
        required: ['downloadId', 'path'],
        properties: {
          downloadId: { type: 'string', minLength: 1, pattern: '\\S' },
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: '\\S',
          },
          overwrite: { type: 'boolean' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
        },
      },
    },
  ];
  return rules.map(declareConditionRequirements);
}

export const browserDownloadWaitJsonSchema: {
  [key: string]: BrowserJsonValue;
} = {
  type: 'object',
  properties: { downloadId: { type: 'string', minLength: 1, pattern: '\\S' } },
  additionalProperties: false,
};

export const browserUploadWaitJsonSchema: {
  [key: string]: BrowserJsonValue;
} = {
  type: 'object',
  properties: { uploadId: { type: 'string', minLength: 1, pattern: '\\S' } },
  required: ['uploadId'],
  additionalProperties: false,
};

/** The download and upload conditions are exclusive, like locator/text/URL/load state. */
export function browserWaitForJsonSchemaRules(
  waitTypes: string[] = ['browser.wait_for'],
): BrowserJsonValue[] {
  const result: BrowserJsonValue[] = [];
  if (waitTypes.length > 0) {
    result.push({
      ...browserActionTypeCondition(waitTypes),
      then: {
        oneOf: [
          {
            required: ['locator'],
            not: {
              anyOf: [
                { required: ['text'] },
                { required: ['url'] },
                { required: ['loadState'] },
                { required: ['download'] },
                { required: ['upload'] },
              ],
            },
            properties: { locator: { minLength: 1, pattern: '\\S' } },
          },
          {
            required: ['text'],
            not: {
              anyOf: [
                { required: ['locator'] },
                { required: ['url'] },
                { required: ['loadState'] },
                { required: ['download'] },
                { required: ['upload'] },
              ],
            },
            properties: { text: { minLength: 1, pattern: '\\S' } },
          },
          {
            required: ['url'],
            not: {
              anyOf: [
                { required: ['locator'] },
                { required: ['text'] },
                { required: ['loadState'] },
                { required: ['download'] },
                { required: ['upload'] },
              ],
            },
            properties: { url: { minLength: 1, pattern: '\\S' } },
          },
          {
            required: ['loadState'],
            not: {
              anyOf: [
                { required: ['locator'] },
                { required: ['text'] },
                { required: ['url'] },
                { required: ['download'] },
                { required: ['upload'] },
              ],
            },
          },
          {
            required: ['download'],
            not: {
              anyOf: [
                { required: ['locator'] },
                { required: ['text'] },
                { required: ['url'] },
                { required: ['loadState'] },
                { required: ['upload'] },
              ],
            },
            properties: { download: browserDownloadWaitJsonSchema },
          },
          {
            required: ['upload'],
            not: {
              anyOf: [
                { required: ['locator'] },
                { required: ['text'] },
                { required: ['url'] },
                { required: ['loadState'] },
                { required: ['download'] },
              ],
            },
            properties: { upload: browserUploadWaitJsonSchema },
          },
        ],
      },
    });
    const stateCondition = browserActionTypeCondition(waitTypes);
    result.push({
      if: {
        properties: stateCondition.if.properties,
        required: [...stateCondition.if.required, 'state'],
      },
      then: { anyOf: [{ required: ['locator'] }, { required: ['text'] }] },
    });
  }
  return result;
}
