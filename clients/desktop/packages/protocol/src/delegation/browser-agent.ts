/**
 * Portable contracts for the managed browser agent: Phase A1 and A2 of
 * `docs/planning/2026-09-24-managed-browser-delegation` (05 §1 and §5, 06 §3).
 *
 * Everything here is an inert, serializable wire shape or a pure validator.
 * Nothing registers a tool, enables a setting, launches a runtime, or grants
 * browser authority: hosts supply identity, leases, destination and network
 * policy, redaction, and token enforcement. Every object is closed (unknown
 * keys are rejected) and every string, array, and number is bounded.
 *
 * The specialist tool arguments have object roots without root refinements,
 * so `z.toJSONSchema` describes each one exactly apart from character-class
 * and URL checks; gateways still validate calls with these schemas.
 */
import { z } from 'zod';

import { MAX_MANAGED_DELEGATION_DEPTH } from './discovery';
import {
  DELEGATION_STOP_REASONS,
  type AgentDelegationErrorCode,
  type AgentDelegationResult,
  type AgentDelegationStatus,
  type DelegateSettledStatus,
  type DelegationStopReason,
  type DelegationStoppedBy,
} from './index';

// ---------------------------------------------------------------------------
// Versions and limits
// ---------------------------------------------------------------------------

/** Revision of every host-produced record in this module. */
export const BROWSER_AGENT_CONTRACT_VERSION = 1;

/**
 * The plan's proposed initial experiment settings (README §4, "Proposed
 * initial bounds"). They are values to measure, not shipped limits. Token
 * context threshold is checked at safe session boundaries by the host; smaller
 * projections remain bounded before injection. No schema counts tokens or
 * claims an exact ceiling on native internal requests.
 */
export const BROWSER_AGENT_EXPERIMENT_LIMITS = Object.freeze({
  name: 'browser-agent-initial-experiment',
  version: 2,
  tokenBudgets: Object.freeze({
    /** Session context checkpoint threshold; reserve model-specific output headroom. */
    contextCheckpoint: 125_000,
    handoff: 2_000,
    observation: 6_000,
    result: 2_000,
  }),
  /** Counted once across every epoch of one run; rotation never renews them. */
  taskBudgets: Object.freeze({
    actions: 50,
    inferenceRequests: 100,
    activeWorkMs: 600_000,
  }),
  /** Structural observation bounds, applied before the observation token budget. */
  observation: Object.freeze({
    controls: 100,
    textCharacters: 6_000,
  }),
});

const EXPERIMENT = BROWSER_AGENT_EXPERIMENT_LIMITS;

/**
 * Structural bounds enforced by the schemas below. Characters are UTF-16 code
 * units and counts are array lengths; they bound memory and serialized size,
 * not tokens. The aggregate caps are sized near four characters per budgeted
 * token and hold by construction: the per-field maxima of every
 * model-authored string, evidence IDs included, sum to no more than them.
 * Oversized input is rejected, never truncated.
 */
export const BROWSER_AGENT_CONTRACT_LIMITS = Object.freeze({
  idCharacters: 128,
  /** Fits the existing preload refs (`input-<32 hex>-<n>`). */
  refCharacters: 64,
  goalCharacters: 8_000,
  urlCharacters: 2_048,
  titleCharacters: 512,
  controlNameCharacters: 256,
  controlValueCharacters: 256,
  optionLabelCharacters: 256,
  queryCharacters: 200,
  fillTextCharacters: 8_000,
  promptTextCharacters: 1_000,
  dialogMessageCharacters: 1_000,
  snippetCharacters: 300,
  errorMessageCharacters: 1_024,
  noteSummaryCharacters: 1_000,
  findingCharacters: 400,
  noteItemCharacters: 200,
  answerCharacters: 4_000,
  blockedMessageCharacters: 400,
  observationControls: EXPERIMENT.observation.controls,
  textCharacters: EXPERIMENT.observation.textCharacters,
  controlOptions: 20,
  observationOptions: 200,
  searchMatches: 20,
  taskTabs: 8,
  noteFindings: 8,
  notePendingItems: 6,
  noteFailedApproaches: 4,
  resultFindings: 6,
  missingCriteria: 4,
  resultEvidence: 20,
  handoffReceipts: 20,
  /** Every admitted action has one sequence number, so unknown outcomes always fit. */
  maxActionSequence: EXPERIMENT.taskBudgets.actions,
  /** Each epoch spends at least one inference request. */
  maxEpoch: EXPERIMENT.taskBudgets.inferenceRequests,
  maxInferenceRequests: EXPERIMENT.taskBudgets.inferenceRequests,
  progressNotesCharacters: 8_000,
  resultModelCharacters: 8_000,
  waitMinMs: 100,
  waitMaxMs: 30_000,
  maxPixels: 10_000_000,
});

const LIMITS = BROWSER_AGENT_CONTRACT_LIMITS;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type Presence = 'required' | 'optional' | 'absent';
type IssueContext = Pick<z.core.$RefinementCtx<unknown>, 'addIssue'>;
type IssuePath = readonly (string | number)[];

function addIssue(
  context: IssueContext,
  message: string,
  path: IssuePath,
): void {
  context.addIssue({ code: 'custom', message, path: [...path] });
}

function checkPresence(
  context: IssueContext,
  field: string,
  value: unknown,
  rule: Presence,
): void {
  if (rule === 'required' && value === undefined)
    addIssue(context, `${field} is required here.`, [field]);
  if (rule === 'absent' && value !== undefined)
    addIssue(context, `${field} is not allowed here.`, [field]);
}

function hasDuplicates(values: readonly (string | number)[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * C0 and C1 controls are never allowed. Tab and line breaks (including the
 * Unicode line and paragraph separators) are allowed only in multi-line text.
 */
function hasControlCharacters(value: string, allowLayout: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const layout =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x2028 ||
      code === 0x2029;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (layout ? !allowLayout : control) return true;
  }
  return false;
}

function boundedText(
  minimum: number,
  maximum: number,
  lines: 'single' | 'multi',
): z.ZodString {
  const text = z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => !hasControlCharacters(value, lines === 'multi'), {
      message:
        lines === 'multi'
          ? 'Remove control characters.'
          : 'Use one line without control characters.',
    });
  return minimum > 0
    ? text.refine((value) => value.trim().length > 0, {
        message: 'Text must not be blank.',
      })
    : text;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function opaqueId(maximum: number): z.ZodString {
  return z.string().min(1).max(maximum).regex(OPAQUE_ID_PATTERN);
}

function integer(minimum: number, maximum: number): z.ZodNumber {
  return z.number().int().min(minimum).max(maximum);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
const WHITESPACE_OR_BACKSLASH = /[\s\\]/;

/**
 * URL syntax only: an absolute http(s) URL with a host and no credentials,
 * whitespace, or backslashes. The owning core still decides whether the
 * destination is admitted (public origins, private-network denial, grants).
 */
function isHttpUrlSyntax(value: string): boolean {
  if (
    !HTTP_SCHEME_PATTERN.test(value) ||
    hasControlCharacters(value, false) ||
    WHITESPACE_OR_BACKSLASH.test(value)
  )
    return false;
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (authority === '' || authority.includes('@')) return false;
  const parsed = parseUrl(value);
  return (
    parsed !== undefined &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/** A host-projected page URL (already redacted); never carries credentials. */
function isDisplayUrl(value: string): boolean {
  if (hasControlCharacters(value, false) || /\s/.test(value)) return false;
  const parsed = parseUrl(value);
  return (
    parsed !== undefined && parsed.username === '' && parsed.password === ''
  );
}

export const BrowserAgentIdSchema = opaqueId(LIMITS.idCharacters);
const RefSchema = opaqueId(LIMITS.refCharacters);
export const BrowserAgentDigestSchema = z
  .string()
  .length(71)
  .regex(/^sha256:[0-9a-f]{64}$/);

/** Absolute HTTP(S) URL syntax; destination admission belongs to the core. */
export const BrowserAgentHttpUrlSchema = z
  .string()
  .min(1)
  .max(LIMITS.urlCharacters)
  .regex(HTTP_SCHEME_PATTERN)
  .refine(isHttpUrlSyntax, {
    message: 'Use an http or https URL without credentials.',
  });

const DisplayUrlSchema = z
  .string()
  .min(1)
  .max(LIMITS.urlCharacters)
  .refine(isDisplayUrl, {
    message: 'Use a URL without credentials or whitespace.',
  });

const TimestampSchema = integer(0, Number.MAX_SAFE_INTEGER);
const RevisionSchema = integer(0, Number.MAX_SAFE_INTEGER);
const CountSchema = integer(0, Number.MAX_SAFE_INTEGER);
const GenerationSchema = integer(1, Number.MAX_SAFE_INTEGER);
const EpochSchema = integer(1, LIMITS.maxEpoch);
const ActionSequenceSchema = integer(1, LIMITS.maxActionSequence);
const ActionCountSchema = integer(0, LIMITS.maxActionSequence);
const InferenceRequestCountSchema = integer(0, LIMITS.maxInferenceRequests);
const PixelSchema = integer(0, LIMITS.maxPixels);
const ScrollOffsetSchema = integer(-LIMITS.maxPixels, LIMITS.maxPixels);
const WaitMsSchema = integer(LIMITS.waitMinMs, LIMITS.waitMaxMs);

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** One disposable provider session inside one delegation run generation. */
export const BrowserAgentEpochIdentitySchema = z.strictObject({
  delegationId: BrowserAgentIdSchema,
  runGeneration: GenerationSchema,
  epoch: EpochSchema,
});
export type BrowserAgentEpochIdentity = z.output<
  typeof BrowserAgentEpochIdentitySchema
>;

/** The browser tab and its runtime; profile replacement advances the generation. */
export const BrowserAgentRuntimeIdentitySchema = z.strictObject({
  browserId: BrowserAgentIdSchema,
  runtimeGeneration: GenerationSchema,
});

/**
 * `documentId` changes on every new-document navigation; `navigationRevision`
 * also advances on committed same-document navigations.
 */
export const BrowserAgentDocumentIdentitySchema = z.strictObject({
  documentId: BrowserAgentIdSchema,
  navigationRevision: RevisionSchema,
});

/** The tab's user-interaction revision; user input is never blocked. */
export const BrowserAgentInteractionIdentitySchema = z.strictObject({
  revision: RevisionSchema,
  /** The user interacted with the tab since the agent's previous observation. */
  userInteracted: z.boolean(),
});

// ---------------------------------------------------------------------------
// Start Browser Agent request
// ---------------------------------------------------------------------------

/** The task in the user's or parent's words, with constraints and criteria. */
export const BrowserAgentGoalSchema = boundedText(
  1,
  LIMITS.goalCharacters,
  'multi',
);

/**
 * A goal plus exactly one target: an existing tab (`browserId`) or a URL the
 * host opens in a new tab. Model, effort, profile, and limits come from
 * settings and host policy, never from the caller.
 */
export const BrowserAgentStartRequestSchema = z.union([
  z.strictObject({
    goal: BrowserAgentGoalSchema,
    browserId: BrowserAgentIdSchema,
  }),
  z.strictObject({
    goal: BrowserAgentGoalSchema,
    url: BrowserAgentHttpUrlSchema,
  }),
]);
export type BrowserAgentStartRequest = z.output<
  typeof BrowserAgentStartRequestSchema
>;

const START_REQUEST_MESSAGES = Object.freeze({
  invalid: 'Invalid Start Browser Agent request.',
  target: 'Provide exactly one target: browserId or url.',
  goal: `Provide a goal of up to ${LIMITS.goalCharacters.toLocaleString('en-US')} characters.`,
  browserId: 'Use the browserId of an open browser tab.',
  url: 'Use an http or https URL without credentials.',
});

function startRequestIssue(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return START_REQUEST_MESSAGES.invalid;
  if (Number('browserId' in input) + Number('url' in input) !== 1)
    return START_REQUEST_MESSAGES.target;
  if (
    !('goal' in input) ||
    !BrowserAgentGoalSchema.safeParse(input.goal).success
  )
    return START_REQUEST_MESSAGES.goal;
  if (
    'browserId' in input &&
    !BrowserAgentIdSchema.safeParse(input.browserId).success
  )
    return START_REQUEST_MESSAGES.browserId;
  if ('url' in input && !BrowserAgentHttpUrlSchema.safeParse(input.url).success)
    return START_REQUEST_MESSAGES.url;
  return START_REQUEST_MESSAGES.invalid;
}

export function parseBrowserAgentStartRequest(
  input: unknown,
): AgentDelegationResult<BrowserAgentStartRequest> {
  const parsed = BrowserAgentStartRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: startRequestIssue(input),
      retryable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Closed specialist tool set
// ---------------------------------------------------------------------------

/**
 * The complete browser-agent tool set. A name outside this list is refused at
 * dispatch; additions need review and a matching allowlist test change.
 */
export const BROWSER_AGENT_TOOL_NAMES = Object.freeze([
  'observe',
  'read_text',
  'search_text',
  'screenshot',
  'list_tabs',
  'wait',
  'click',
  'fill',
  'select_option',
  'press_key',
  'scroll',
  'handle_dialog',
  'navigate',
  'go_back',
  'go_forward',
  'reload',
  'open_tab',
  'switch_tab',
  'close_tab',
  'record_progress',
  'finish',
  'report_blocked',
] as const);
export type BrowserAgentToolName = (typeof BROWSER_AGENT_TOOL_NAMES)[number];

/** Reads and bounded waits: no page mutation, no intent or receipt. */
export const BROWSER_AGENT_READ_TOOL_NAMES = Object.freeze([
  'observe',
  'read_text',
  'search_text',
  'screenshot',
  'list_tabs',
  'wait',
] as const satisfies readonly BrowserAgentToolName[]);

/** Browser actions: each spends the action budget and records an intent and receipt. */
export const BROWSER_AGENT_ACTION_TOOL_NAMES = Object.freeze([
  'click',
  'fill',
  'select_option',
  'press_key',
  'scroll',
  'handle_dialog',
  'navigate',
  'go_back',
  'go_forward',
  'reload',
  'open_tab',
  'switch_tab',
  'close_tab',
] as const satisfies readonly BrowserAgentToolName[]);
export type BrowserAgentActionToolName =
  (typeof BROWSER_AGENT_ACTION_TOOL_NAMES)[number];

/** Task-ledger controls: progress notes, completion, and blocked reports. */
export const BROWSER_AGENT_CONTROL_TOOL_NAMES = Object.freeze([
  'record_progress',
  'finish',
  'report_blocked',
] as const satisfies readonly BrowserAgentToolName[]);

/** The closed page key vocabulary: no clipboard, browser, or OS chords. */
export const BROWSER_AGENT_KEYS = Object.freeze([
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
] as const);

export const BROWSER_AGENT_BLOCKED_REASONS = Object.freeze([
  'login_required',
  'captcha',
  'user_decision',
  'unsupported_interaction',
  'destination_denied',
  'site_unavailable',
  'other',
] as const);

/** A control ref from one observation; refs never survive a newer observation. */
export const BrowserAgentElementTargetSchema = z.strictObject({
  observationId: BrowserAgentIdSchema,
  ref: RefSchema,
});
export type BrowserAgentElementTarget = z.output<
  typeof BrowserAgentElementTargetSchema
>;

const QueryTextSchema = boundedText(1, LIMITS.queryCharacters, 'single');
const NoteItemSchema = boundedText(1, LIMITS.noteItemCharacters, 'single');
const ScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right']);
const ScrollAmountSchema = z.enum(['half_page', 'page', 'to_edge']);

const FindingSchema = z.strictObject({
  text: boundedText(1, LIMITS.findingCharacters, 'multi'),
  /** An observation, receipt, or screenshot evidence ID owned by this task. */
  evidenceId: BrowserAgentIdSchema.optional(),
});

/** `record_progress` arguments: the complete latest notes, replacing earlier ones. */
export const BrowserAgentProgressNotesSchema = z.strictObject({
  summary: boundedText(1, LIMITS.noteSummaryCharacters, 'multi'),
  findings: z.array(FindingSchema).max(LIMITS.noteFindings).optional(),
  pending: z.array(NoteItemSchema).max(LIMITS.notePendingItems).optional(),
  failedApproaches: z
    .array(NoteItemSchema)
    .max(LIMITS.noteFailedApproaches)
    .optional(),
  nextStep: NoteItemSchema.optional(),
});
export type BrowserAgentProgressNotes = z.output<
  typeof BrowserAgentProgressNotesSchema
>;

const BlockedSchema = z.strictObject({
  reason: z.enum(BROWSER_AGENT_BLOCKED_REASONS),
  message: boundedText(1, LIMITS.blockedMessageCharacters, 'multi'),
});

/** Arguments for every specialist tool, keyed by the closed tool names. */
export const BROWSER_AGENT_TOOL_ARGUMENTS = Object.freeze({
  observe: z.strictObject({ query: QueryTextSchema.optional() }),
  read_text: z.strictObject({
    cursor: BrowserAgentIdSchema.optional(),
    maxCharacters: integer(1, LIMITS.textCharacters).optional(),
  }),
  search_text: z.strictObject({
    query: QueryTextSchema,
    cursor: BrowserAgentIdSchema.optional(),
    maxMatches: integer(1, LIMITS.searchMatches).optional(),
  }),
  screenshot: z.strictObject({}),
  list_tabs: z.strictObject({}),
  wait: z.strictObject({
    until: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('duration'),
        milliseconds: WaitMsSchema,
      }),
      z.strictObject({
        kind: z.literal('load_complete'),
        timeoutMs: WaitMsSchema,
      }),
      z.strictObject({
        kind: z.literal('text_present'),
        text: QueryTextSchema,
        timeoutMs: WaitMsSchema,
      }),
      z.strictObject({
        kind: z.literal('text_absent'),
        text: QueryTextSchema,
        timeoutMs: WaitMsSchema,
      }),
    ]),
  }),
  click: z.strictObject({ target: BrowserAgentElementTargetSchema }),
  fill: z.strictObject({
    target: BrowserAgentElementTargetSchema,
    /** Replaces the field's value; an empty string clears it. */
    text: boundedText(0, LIMITS.fillTextCharacters, 'multi'),
  }),
  select_option: z.strictObject({
    target: BrowserAgentElementTargetSchema,
    /** An observed option label of a native select. */
    label: boundedText(1, LIMITS.optionLabelCharacters, 'single'),
  }),
  press_key: z.strictObject({
    key: z.enum(BROWSER_AGENT_KEYS),
    target: BrowserAgentElementTargetSchema.optional(),
  }),
  scroll: z.strictObject({
    to: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('page'),
        direction: ScrollDirectionSchema,
        amount: ScrollAmountSchema.optional(),
      }),
      z.strictObject({
        kind: z.literal('container'),
        target: BrowserAgentElementTargetSchema,
        direction: ScrollDirectionSchema,
        amount: ScrollAmountSchema.optional(),
      }),
      z.strictObject({
        kind: z.literal('element'),
        target: BrowserAgentElementTargetSchema,
      }),
      z.strictObject({ kind: z.literal('text'), text: QueryTextSchema }),
    ]),
  }),
  handle_dialog: z.strictObject({
    dialogId: BrowserAgentIdSchema,
    response: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('accept'),
        promptText: boundedText(
          0,
          LIMITS.promptTextCharacters,
          'single',
        ).optional(),
      }),
      z.strictObject({ kind: z.literal('dismiss') }),
    ]),
  }),
  navigate: z.strictObject({ url: BrowserAgentHttpUrlSchema }),
  go_back: z.strictObject({}),
  go_forward: z.strictObject({}),
  reload: z.strictObject({}),
  open_tab: z.strictObject({ url: BrowserAgentHttpUrlSchema }),
  switch_tab: z.strictObject({ browserId: BrowserAgentIdSchema }),
  close_tab: z.strictObject({ browserId: BrowserAgentIdSchema }),
  record_progress: BrowserAgentProgressNotesSchema,
  finish: z.strictObject({
    answer: boundedText(1, LIMITS.answerCharacters, 'multi'),
    findings: z.array(FindingSchema).max(LIMITS.resultFindings).optional(),
    /** Unmet completion criteria; omit or leave empty when none remain. */
    missingCriteria: z
      .array(NoteItemSchema)
      .max(LIMITS.missingCriteria)
      .optional(),
  }),
  report_blocked: BlockedSchema,
} satisfies Record<BrowserAgentToolName, z.ZodType>);

export type BrowserAgentToolArguments<Name extends BrowserAgentToolName> =
  z.output<(typeof BROWSER_AGENT_TOOL_ARGUMENTS)[Name]>;

function toolCall<
  Name extends BrowserAgentToolName,
  Arguments extends z.ZodType,
>(
  tool: Name,
  argumentsSchema: Arguments,
): z.ZodObject<
  { tool: z.ZodLiteral<Name>; arguments: Arguments },
  z.core.$strict
> {
  return z.strictObject({ tool: z.literal(tool), arguments: argumentsSchema });
}

const ARGS = BROWSER_AGENT_TOOL_ARGUMENTS;

const READ_TOOL_CALLS = [
  toolCall('observe', ARGS.observe),
  toolCall('read_text', ARGS.read_text),
  toolCall('search_text', ARGS.search_text),
  toolCall('screenshot', ARGS.screenshot),
  toolCall('list_tabs', ARGS.list_tabs),
  toolCall('wait', ARGS.wait),
] as const;

const ACTION_TOOL_CALLS = [
  toolCall('click', ARGS.click),
  toolCall('fill', ARGS.fill),
  toolCall('select_option', ARGS.select_option),
  toolCall('press_key', ARGS.press_key),
  toolCall('scroll', ARGS.scroll),
  toolCall('handle_dialog', ARGS.handle_dialog),
  toolCall('navigate', ARGS.navigate),
  toolCall('go_back', ARGS.go_back),
  toolCall('go_forward', ARGS.go_forward),
  toolCall('reload', ARGS.reload),
  toolCall('open_tab', ARGS.open_tab),
  toolCall('switch_tab', ARGS.switch_tab),
  toolCall('close_tab', ARGS.close_tab),
] as const;

const CONTROL_TOOL_CALLS = [
  toolCall('record_progress', ARGS.record_progress),
  toolCall('finish', ARGS.finish),
  toolCall('report_blocked', ARGS.report_blocked),
] as const;

/** One validated specialist call: a closed tool name and its exact arguments. */
export const BrowserAgentToolCallSchema = z.discriminatedUnion('tool', [
  ...READ_TOOL_CALLS,
  ...ACTION_TOOL_CALLS,
  ...CONTROL_TOOL_CALLS,
]);
export type BrowserAgentToolCall = z.output<typeof BrowserAgentToolCallSchema>;

/** The action calls that go through the per-tab mutation lane. */
export const BrowserAgentActionCallSchema = z.discriminatedUnion(
  'tool',
  ACTION_TOOL_CALLS,
);
export type BrowserAgentActionCall = z.output<
  typeof BrowserAgentActionCallSchema
>;

export function isBrowserAgentToolName(
  value: unknown,
): value is BrowserAgentToolName {
  return (
    typeof value === 'string' &&
    BROWSER_AGENT_TOOL_NAMES.some((name) => name === value)
  );
}

export type BrowserAgentToolCallParseResult =
  | { readonly ok: true; readonly value: BrowserAgentToolCall }
  | {
      readonly ok: false;
      readonly reason: 'unknown_tool' | 'invalid_arguments';
    };

/** Refuses a guessed or retired tool name before its arguments are read. */
export function parseBrowserAgentToolCall(
  tool: unknown,
  args: unknown,
): BrowserAgentToolCallParseResult {
  if (!isBrowserAgentToolName(tool))
    return { ok: false, reason: 'unknown_tool' };
  const parsed = BrowserAgentToolCallSchema.safeParse({
    tool,
    arguments: args,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'invalid_arguments' };
}

/** The observed control an action targets, when it targets one. */
export function browserAgentActionTarget(
  call: BrowserAgentActionCall,
): BrowserAgentElementTarget | undefined {
  switch (call.tool) {
    case 'click':
    case 'fill':
    case 'select_option':
    case 'press_key':
      return call.arguments.target;
    case 'scroll':
      return 'target' in call.arguments.to
        ? call.arguments.to.target
        : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Observation envelope and read results
// ---------------------------------------------------------------------------

/** Closed control roles; the host maps anything else to `other`. `select` is a native select. */
export const BROWSER_AGENT_CONTROL_ROLES = Object.freeze([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'option',
  'select',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'treeitem',
  'other',
] as const);

const ControlRoleSchema = z.enum(BROWSER_AGENT_CONTROL_ROLES);

const SelectOptionsSchema = z
  .strictObject({
    entries: z
      .array(
        z.strictObject({
          label: boundedText(0, LIMITS.optionLabelCharacters, 'single'),
          selected: z.boolean(),
          disabled: z.boolean().optional(),
        }),
      )
      .max(LIMITS.controlOptions),
    total: CountSchema,
    omitted: CountSchema,
  })
  .refine(
    (options) => options.total === options.entries.length + options.omitted,
    {
      message: 'Option coverage must account for every option.',
      path: ['total'],
    },
  );

const ControlObjectSchema = z.strictObject({
  ref: RefSchema,
  role: ControlRoleSchema,
  name: boundedText(0, LIMITS.controlNameCharacters, 'single'),
  value: boundedText(0, LIMITS.controlValueCharacters, 'multi').optional(),
  /** The value is secret and withheld; it is never reconstructed. */
  valueRedacted: z.literal(true).optional(),
  state: z
    .strictObject({
      disabled: z.boolean().optional(),
      checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
      selected: z.boolean().optional(),
      expanded: z.boolean().optional(),
      required: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      focused: z.boolean().optional(),
    })
    .optional(),
  inViewport: z.boolean(),
  /** Native select options with coverage; absent for secret selects. */
  options: SelectOptionsSchema.optional(),
});

function checkControl(
  control: z.output<typeof ControlObjectSchema>,
  context: IssueContext,
): void {
  if (control.value !== undefined && control.valueRedacted)
    addIssue(context, 'A redacted control has no value.', ['value']);
  if (control.options !== undefined && control.role !== 'select')
    addIssue(context, 'Only a native select lists options.', ['options']);
  if (control.options !== undefined && control.valueRedacted)
    addIssue(context, 'A redacted select lists no options.', ['options']);
}

export const BrowserAgentControlSchema =
  ControlObjectSchema.superRefine(checkControl);

const DialogSchema = z.strictObject({
  dialogId: BrowserAgentIdSchema,
  kind: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
  message: boundedText(0, LIMITS.dialogMessageCharacters, 'multi'),
  omittedCharacters: CountSchema,
});

const ObservationObjectSchema = z.strictObject({
  version: z.literal(BROWSER_AGENT_CONTRACT_VERSION),
  observationId: BrowserAgentIdSchema,
  epoch: BrowserAgentEpochIdentitySchema,
  runtime: BrowserAgentRuntimeIdentitySchema,
  document: BrowserAgentDocumentIdentitySchema,
  interaction: BrowserAgentInteractionIdentitySchema,
  capturedAt: TimestampSchema,
  page: z.strictObject({
    url: DisplayUrlSchema,
    title: boundedText(0, LIMITS.titleCharacters, 'single'),
    loading: z.boolean(),
    visible: z.boolean(),
    viewport: z.strictObject({
      width: PixelSchema,
      height: PixelSchema,
      scrollX: ScrollOffsetSchema,
      scrollY: ScrollOffsetSchema,
      scrollWidth: PixelSchema,
      scrollHeight: PixelSchema,
    }),
  }),
  controls: z.array(BrowserAgentControlSchema).max(LIMITS.observationControls),
  /** `found` = `returned` + both omission counts; nothing is dropped silently. */
  controlCoverage: z.strictObject({
    found: CountSchema,
    returned: CountSchema,
    omittedOverLimit: CountSchema,
    /** For example file inputs and other surfaces outside the tool set. */
    omittedUnsupported: CountSchema,
  }),
  visibleText: z.strictObject({
    text: boundedText(0, LIMITS.textCharacters, 'multi'),
    totalCharacters: CountSchema,
    omittedCharacters: CountSchema,
  }),
  /** Secret values withheld from this observation. */
  redactedValues: CountSchema,
  dialog: DialogSchema.optional(),
});

function checkObservation(
  observation: z.output<typeof ObservationObjectSchema>,
  context: IssueContext,
): void {
  const { controls, controlCoverage: coverage, visibleText } = observation;
  if (coverage.returned !== controls.length)
    addIssue(context, 'Returned controls must match the control list.', [
      'controlCoverage',
      'returned',
    ]);
  if (
    coverage.found !==
    coverage.returned + coverage.omittedOverLimit + coverage.omittedUnsupported
  )
    addIssue(context, 'Found controls must equal returned plus omitted.', [
      'controlCoverage',
      'found',
    ]);
  if (
    visibleText.totalCharacters !==
    visibleText.text.length + visibleText.omittedCharacters
  )
    addIssue(context, 'Visible text coverage must count every character.', [
      'visibleText',
      'omittedCharacters',
    ]);
  if (hasDuplicates(controls.map((control) => control.ref)))
    addIssue(context, 'Control refs must be unique.', ['controls']);
  const options = controls.reduce(
    (total, control) => total + (control.options?.entries.length ?? 0),
    0,
  );
  if (options > LIMITS.observationOptions)
    addIssue(context, 'The observation lists too many select options.', [
      'controls',
    ]);
}

/**
 * The `observe` result: runtime, document, epoch, and interaction identities
 * plus bounded controls and visible text with explicit coverage.
 */
export const BrowserAgentObservationSchema =
  ObservationObjectSchema.superRefine(checkObservation);
export type BrowserAgentObservation = z.output<
  typeof BrowserAgentObservationSchema
>;

const PageIdentityShape = {
  runtime: BrowserAgentRuntimeIdentitySchema,
  document: BrowserAgentDocumentIdentitySchema,
};

/** The `read_text` result: one window of page text with a coverage cursor. */
export const BrowserAgentTextReadResultSchema = z
  .strictObject({
    ...PageIdentityShape,
    text: boundedText(0, LIMITS.textCharacters, 'multi'),
    coverage: z.strictObject({
      totalCharacters: CountSchema,
      startOffset: CountSchema,
      /** Present exactly when text remains after this window. */
      nextCursor: BrowserAgentIdSchema.optional(),
    }),
    redactedValues: CountSchema,
  })
  .superRefine((result, context) => {
    const end = result.coverage.startOffset + result.text.length;
    if (end > result.coverage.totalCharacters)
      addIssue(context, 'The window ends past the page text.', ['coverage']);
    if (
      (result.coverage.nextCursor !== undefined) !==
      end < result.coverage.totalCharacters
    )
      addIssue(context, 'A cursor is present exactly when text remains.', [
        'coverage',
        'nextCursor',
      ]);
  });

/** The `search_text` result: one page of matches with a coverage cursor. */
export const BrowserAgentTextSearchResultSchema = z
  .strictObject({
    ...PageIdentityShape,
    matches: z
      .array(
        z.strictObject({
          snippet: boundedText(1, LIMITS.snippetCharacters, 'multi'),
          offset: CountSchema,
          inViewport: z.boolean(),
        }),
      )
      .max(LIMITS.searchMatches),
    coverage: z.strictObject({
      totalMatches: CountSchema,
      startIndex: CountSchema,
      /** Present exactly when matches remain after this page. */
      nextCursor: BrowserAgentIdSchema.optional(),
    }),
  })
  .superRefine((result, context) => {
    const end = result.coverage.startIndex + result.matches.length;
    if (end > result.coverage.totalMatches)
      addIssue(context, 'The page ends past the last match.', ['coverage']);
    if (
      (result.coverage.nextCursor !== undefined) !==
      end < result.coverage.totalMatches
    )
      addIssue(context, 'A cursor is present exactly when matches remain.', [
        'coverage',
        'nextCursor',
      ]);
  });

/**
 * The `screenshot` result: an opaque evidence ID, never a host path. When the
 * host cannot mask secret regions safely, the screenshot is unavailable.
 */
export const BrowserAgentScreenshotResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('captured'),
      evidenceId: BrowserAgentIdSchema,
      ...PageIdentityShape,
      capturedAt: TimestampSchema,
      width: integer(1, LIMITS.maxPixels),
      height: integer(1, LIMITS.maxPixels),
      maskedRegions: CountSchema,
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reason: z.enum([
        'masking_unavailable',
        'tab_not_visible',
        'capture_failed',
      ]),
    }),
  ],
);

/** `existing`: a tab the parent supplied, never closed by cleanup. */
export const BROWSER_AGENT_TAB_ORIGINS = Object.freeze([
  'existing',
  'task',
] as const);

/** The `list_tabs` result: only this task's tabs. */
export const BrowserAgentTabListResultSchema = z
  .strictObject({
    tabs: z
      .array(
        z.strictObject({
          browserId: BrowserAgentIdSchema,
          origin: z.enum(BROWSER_AGENT_TAB_ORIGINS),
          active: z.boolean(),
          url: DisplayUrlSchema,
          title: boundedText(0, LIMITS.titleCharacters, 'single'),
        }),
      )
      .max(LIMITS.taskTabs),
  })
  .superRefine((result, context) => {
    if (hasDuplicates(result.tabs.map((tab) => tab.browserId)))
      addIssue(context, 'Tabs must be unique.', ['tabs']);
    const active = result.tabs.filter((tab) => tab.active).length;
    if (result.tabs.length > 0 && active !== 1)
      addIssue(context, 'Exactly one task tab is active.', ['tabs']);
  });

/** The `wait` result. */
export const BrowserAgentWaitResultSchema = z.strictObject({
  outcome: z.enum(['satisfied', 'timed_out']),
  elapsedMs: CountSchema,
});

// ---------------------------------------------------------------------------
// Action intent and receipt
// ---------------------------------------------------------------------------

/** Receipt statuses record execution evidence, never the site's business outcome. */
export const BROWSER_AGENT_ACTION_STATUSES = Object.freeze([
  'not_executed',
  'executed',
  'outcome_unknown',
] as const);

export const BROWSER_AGENT_NOT_EXECUTED_REASONS = Object.freeze([
  'stale_observation',
  'target_not_found',
  'target_changed',
  'target_not_actionable',
  'dialog_pending',
  'destination_denied',
  'lease_revoked',
  'epoch_fenced',
  'budget_exhausted',
] as const);

/** A dispatched action without completion evidence; it is never replayed. */
export const BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS = Object.freeze([
  'dispatch_timeout',
  'stopped_after_dispatch',
  'runtime_lost',
  'host_restart',
] as const);

interface SubjectRule {
  readonly control: Presence;
  readonly url: Presence;
  readonly browserId: Presence;
  readonly key: Presence;
  readonly dialogResponse: Presence;
}

const NO_SUBJECT_FIELDS: SubjectRule = {
  control: 'absent',
  url: 'absent',
  browserId: 'absent',
  key: 'absent',
  dialogResponse: 'absent',
};

const SUBJECT_RULES: Readonly<Record<BrowserAgentActionToolName, SubjectRule>> =
  Object.freeze({
    click: { ...NO_SUBJECT_FIELDS, control: 'required' },
    fill: { ...NO_SUBJECT_FIELDS, control: 'required' },
    select_option: { ...NO_SUBJECT_FIELDS, control: 'required' },
    press_key: { ...NO_SUBJECT_FIELDS, control: 'optional', key: 'required' },
    scroll: { ...NO_SUBJECT_FIELDS, control: 'optional' },
    handle_dialog: { ...NO_SUBJECT_FIELDS, dialogResponse: 'required' },
    navigate: { ...NO_SUBJECT_FIELDS, url: 'required' },
    go_back: NO_SUBJECT_FIELDS,
    go_forward: NO_SUBJECT_FIELDS,
    reload: NO_SUBJECT_FIELDS,
    open_tab: { ...NO_SUBJECT_FIELDS, url: 'required' },
    switch_tab: { ...NO_SUBJECT_FIELDS, browserId: 'required' },
    close_tab: { ...NO_SUBJECT_FIELDS, browserId: 'required' },
  });

const SubjectObjectSchema = z.strictObject({
  tool: z.enum(BROWSER_AGENT_ACTION_TOOL_NAMES),
  /** Host-derived from the target's observation; page text stays data. */
  control: z
    .strictObject({
      role: ControlRoleSchema,
      name: boundedText(0, LIMITS.controlNameCharacters, 'single'),
    })
    .optional(),
  /** The redacted destination of `navigate` or `open_tab`. */
  url: BrowserAgentHttpUrlSchema.optional(),
  browserId: BrowserAgentIdSchema.optional(),
  key: z.enum(BROWSER_AGENT_KEYS).optional(),
  dialogResponse: z.enum(['accept', 'dismiss']).optional(),
});

function checkSubject(
  subject: z.output<typeof SubjectObjectSchema>,
  context: IssueContext,
): void {
  const rule = SUBJECT_RULES[subject.tool];
  checkPresence(context, 'control', subject.control, rule.control);
  checkPresence(context, 'url', subject.url, rule.url);
  checkPresence(context, 'browserId', subject.browserId, rule.browserId);
  checkPresence(context, 'key', subject.key, rule.key);
  checkPresence(
    context,
    'dialogResponse',
    subject.dialogResponse,
    rule.dialogResponse,
  );
}

/** A bounded, model-readable description of what an action attempted. */
export const BrowserAgentActionSubjectSchema =
  SubjectObjectSchema.superRefine(checkSubject);
export type BrowserAgentActionSubject = z.output<
  typeof BrowserAgentActionSubjectSchema
>;

function subjectEchoDiffers(
  call: BrowserAgentActionCall,
  subject: BrowserAgentActionSubject,
): boolean {
  switch (call.tool) {
    case 'press_key':
      return subject.key !== call.arguments.key;
    case 'switch_tab':
    case 'close_tab':
      return subject.browserId !== call.arguments.browserId;
    case 'handle_dialog':
      return subject.dialogResponse !== call.arguments.response.kind;
    default:
      return false;
  }
}

const IntentObjectSchema = z.strictObject({
  version: z.literal(BROWSER_AGENT_CONTRACT_VERSION),
  actionId: BrowserAgentIdSchema,
  sequence: ActionSequenceSchema,
  epoch: BrowserAgentEpochIdentitySchema,
  /** The live state the action was admitted against. */
  basis: z.strictObject({
    leaseId: BrowserAgentIdSchema,
    runtime: BrowserAgentRuntimeIdentitySchema,
    document: BrowserAgentDocumentIdentitySchema,
    interactionRevision: RevisionSchema,
    observationId: BrowserAgentIdSchema.optional(),
  }),
  call: BrowserAgentActionCallSchema,
  subject: BrowserAgentActionSubjectSchema,
  recordedAt: TimestampSchema,
});

function checkIntent(
  intent: z.output<typeof IntentObjectSchema>,
  context: IssueContext,
): void {
  if (intent.subject.tool !== intent.call.tool)
    addIssue(context, 'The subject must describe the recorded call.', [
      'subject',
      'tool',
    ]);
  const target = browserAgentActionTarget(intent.call);
  if (
    target !== undefined &&
    intent.basis.observationId !== target.observationId
  )
    addIssue(context, 'The basis must be the target observation.', [
      'basis',
      'observationId',
    ]);
  if (subjectEchoDiffers(intent.call, intent.subject))
    addIssue(context, 'The subject must echo the call.', ['subject']);
}

/**
 * Durable intent, written before dispatch. Required order: intent → dispatch
 * → receipt → checkpoint or result publication.
 */
export const BrowserAgentActionIntentSchema =
  IntentObjectSchema.superRefine(checkIntent);
export type BrowserAgentActionIntent = z.output<
  typeof BrowserAgentActionIntentSchema
>;

const ReceiptShape = {
  version: z.literal(BROWSER_AGENT_CONTRACT_VERSION),
  actionId: BrowserAgentIdSchema,
  sequence: ActionSequenceSchema,
  /** The epoch that admitted the intent. */
  epoch: BrowserAgentEpochIdentitySchema,
  subject: BrowserAgentActionSubjectSchema,
  recordedAt: TimestampSchema,
};

/** An action that was dispatched without completion evidence. */
export const BrowserAgentUnknownOutcomeReceiptSchema = z.strictObject({
  ...ReceiptShape,
  status: z.literal('outcome_unknown'),
  reason: z.enum(BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS),
});

export const BrowserAgentActionReceiptSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      ...ReceiptShape,
      status: z.literal('not_executed'),
      reason: z.enum(BROWSER_AGENT_NOT_EXECUTED_REASONS),
    })
    .superRefine((receipt, context) => {
      if (
        receipt.reason === 'destination_denied' &&
        receipt.subject.tool !== 'navigate' &&
        receipt.subject.tool !== 'open_tab'
      )
        addIssue(
          context,
          'Only navigate or open_tab is denied a destination.',
          ['reason'],
        );
    }),
  z
    .strictObject({
      ...ReceiptShape,
      status: z.literal('executed'),
      effects: z.strictObject({
        navigation: z.enum(['none', 'same_document', 'new_document']),
        dialogOpened: z.boolean(),
        openedBrowserId: BrowserAgentIdSchema.optional(),
      }),
    })
    .superRefine((receipt, context) => {
      if (
        (receipt.effects.openedBrowserId !== undefined) !==
        (receipt.subject.tool === 'open_tab')
      )
        addIssue(context, 'Only an executed open_tab reports its tab.', [
          'effects',
          'openedBrowserId',
        ]);
    }),
  BrowserAgentUnknownOutcomeReceiptSchema,
]);
export type BrowserAgentActionReceipt = z.output<
  typeof BrowserAgentActionReceiptSchema
>;

type ReceiptIdentity = Pick<
  BrowserAgentActionReceipt,
  'actionId' | 'sequence' | 'epoch'
>;

// ---------------------------------------------------------------------------
// Epoch handoff
// ---------------------------------------------------------------------------

/** Why a fresh provider session starts; none of these spends a result generation. */
export const BROWSER_AGENT_HANDOFF_TRIGGERS = Object.freeze([
  'start',
  'goal_revision',
  'navigation',
  'tab_switch',
  'context_guard',
  'recovery',
] as const);

const LimitsVersionSchema = z.literal(BROWSER_AGENT_EXPERIMENT_LIMITS.version);

const HandoffObjectSchema = z.strictObject({
  version: z.literal(BROWSER_AGENT_CONTRACT_VERSION),
  /** The epoch this handoff seeds. */
  epoch: BrowserAgentEpochIdentitySchema,
  trigger: z.enum(BROWSER_AGENT_HANDOFF_TRIGGERS),
  /** Chains immutable handoffs; absent only for the first epoch. */
  previousHandoffDigest: BrowserAgentDigestSchema.optional(),
  /** The complete current goal; never shortened to make room. */
  goal: z.strictObject({
    revision: GenerationSchema,
    text: BrowserAgentGoalSchema,
  }),
  /** Host-owned authority; model text cannot change any of it. */
  authority: z.strictObject({
    leaseId: BrowserAgentIdSchema,
    runtime: BrowserAgentRuntimeIdentitySchema,
    policyRevision: BrowserAgentIdSchema,
    launchManifestDigest: BrowserAgentDigestSchema,
    limitsVersion: LimitsVersionSchema,
  }),
  budget: z.strictObject({
    actionsUsed: ActionCountSchema,
    inferenceRequestsUsed: InferenceRequestCountSchema,
    activeWorkMs: CountSchema,
  }),
  lastCommittedActionSequence: ActionCountSchema,
  /** Revision 0 means no notes have been recorded. */
  notes: z.strictObject({
    revision: RevisionSchema,
    content: BrowserAgentProgressNotesSchema.optional(),
  }),
  /** A bounded selection of known outcomes; `omitted` counts the rest. */
  receipts: z.strictObject({
    entries: z
      .array(BrowserAgentActionReceiptSchema)
      .max(LIMITS.handoffReceipts),
    omitted: ActionCountSchema,
  }),
  /** Every unknown outcome in this run, in full; never omitted. */
  unknownOutcomes: z
    .array(BrowserAgentUnknownOutcomeReceiptSchema)
    .max(LIMITS.maxActionSequence),
  createdAt: TimestampSchema,
});

type BrowserAgentHandoffObject = z.output<typeof HandoffObjectSchema>;

function isEarlierEpochReceipt(
  receipt: ReceiptIdentity,
  handoff: BrowserAgentHandoffObject,
): boolean {
  return (
    receipt.epoch.delegationId === handoff.epoch.delegationId &&
    receipt.epoch.runGeneration === handoff.epoch.runGeneration &&
    receipt.epoch.epoch < handoff.epoch.epoch &&
    receipt.sequence <= handoff.lastCommittedActionSequence
  );
}

function checkHandoffReceipts(
  handoff: BrowserAgentHandoffObject,
  context: IssueContext,
): void {
  const { entries, omitted } = handoff.receipts;
  const listed: readonly ReceiptIdentity[] = [
    ...entries,
    ...handoff.unknownOutcomes,
  ];
  if (entries.some((receipt) => receipt.status === 'outcome_unknown'))
    addIssue(context, 'List unknown outcomes only in unknownOutcomes.', [
      'receipts',
      'entries',
    ]);
  if (listed.length + omitted !== handoff.lastCommittedActionSequence)
    addIssue(context, 'Receipts must account for every committed action.', [
      'receipts',
    ]);
  if (
    hasDuplicates(listed.map((receipt) => receipt.actionId)) ||
    hasDuplicates(listed.map((receipt) => receipt.sequence))
  )
    addIssue(context, 'Each action appears once.', ['receipts']);
  if (!listed.every((receipt) => isEarlierEpochReceipt(receipt, handoff)))
    addIssue(context, 'Receipts come from earlier epochs of this run.', [
      'receipts',
    ]);
}

function checkHandoff(
  handoff: BrowserAgentHandoffObject,
  context: IssueContext,
): void {
  const first = handoff.epoch.epoch === 1;
  if ((handoff.trigger === 'start') !== first)
    addIssue(context, 'Only the first epoch of a run starts it.', ['trigger']);
  if ((handoff.previousHandoffDigest === undefined) !== first)
    addIssue(context, 'Every later epoch chains its previous handoff.', [
      'previousHandoffDigest',
    ]);
  if ((handoff.notes.revision === 0) !== (handoff.notes.content === undefined))
    addIssue(context, 'Notes have content exactly after a revision.', [
      'notes',
    ]);
  if (handoff.lastCommittedActionSequence > handoff.budget.actionsUsed)
    addIssue(context, 'Committed actions cannot exceed admitted actions.', [
      'lastCommittedActionSequence',
    ]);
  checkHandoffReceipts(handoff, context);
}

/**
 * The bounded handoff that seeds a fresh provider session: the complete goal,
 * host authority, budgets, latest notes, receipts, and every unknown outcome.
 * The fresh observation is taken at launch; earlier page snapshots never
 * carry over.
 */
export const BrowserAgentEpochHandoffSchema =
  HandoffObjectSchema.superRefine(checkHandoff);
export type BrowserAgentEpochHandoff = z.output<
  typeof BrowserAgentEpochHandoffSchema
>;

// ---------------------------------------------------------------------------
// User Stop (additive to the generic delegation contract)
// ---------------------------------------------------------------------------

/**
 * Proposed additive stop reason for the trusted browser-bar Stop. The generic
 * `DelegationStopReason` is unchanged; a user Stop settles `interrupted`.
 */
export const BROWSER_AGENT_USER_STOPPED_REASON = 'user_stopped';
export type BrowserAgentStopReason =
  | DelegationStopReason
  | typeof BROWSER_AGENT_USER_STOPPED_REASON;

export const BROWSER_AGENT_STOP_REASONS = Object.freeze([
  ...DELEGATION_STOP_REASONS,
  BROWSER_AGENT_USER_STOPPED_REASON,
] as const);

export function isBrowserAgentStopReason(
  value: unknown,
): value is BrowserAgentStopReason {
  return (
    typeof value === 'string' &&
    BROWSER_AGENT_STOP_REASONS.some((reason) => reason === value)
  );
}

/** Generic error codes a browser result can carry; worktree apply never applies. */
export const BROWSER_AGENT_RESULT_ERROR_CODES = Object.freeze([
  'invalid_request',
  'capability_unavailable',
  'route_unavailable',
  'auth_required',
  'interaction_required',
  'policy_blocked',
  'capacity_exceeded',
  'parent_unavailable',
  'launch_uncertain',
  'runtime_error',
  'terminated_by_parent',
] as const satisfies readonly AgentDelegationErrorCode[]);

/** Proposed additive error code, reported only with `user_stopped`. */
export type BrowserAgentErrorCode =
  | (typeof BROWSER_AGENT_RESULT_ERROR_CODES)[number]
  | typeof BROWSER_AGENT_USER_STOPPED_REASON;

export interface BrowserAgentError {
  readonly code: BrowserAgentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The locked user Stop contract: `interrupted` with `user_stopped`, a
 * user-attributed stop, the "User stopped" error, and the host-authored notice
 * relayed at most once into an active parent turn. Watch metadata carries the
 * reason code only.
 */
export const BROWSER_AGENT_USER_STOP: Readonly<{
  status: Extract<AgentDelegationStatus, 'interrupted'>;
  stopReason: typeof BROWSER_AGENT_USER_STOPPED_REASON;
  stoppedBy: Readonly<Extract<DelegationStoppedBy, { kind: 'user' }>>;
  error: Readonly<
    BrowserAgentError & {
      code: typeof BROWSER_AGENT_USER_STOPPED_REASON;
      message: 'User stopped';
      retryable: false;
    }
  >;
  parentNotice: 'User stopped the browser agent';
}> = Object.freeze({
  status: 'interrupted',
  stopReason: BROWSER_AGENT_USER_STOPPED_REASON,
  stoppedBy: Object.freeze({ kind: 'user' }),
  error: Object.freeze({
    code: BROWSER_AGENT_USER_STOPPED_REASON,
    message: 'User stopped',
    retryable: false,
  }),
  parentNotice: 'User stopped the browser agent',
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type BrowserAgentResultStatus = Extract<
  AgentDelegationStatus,
  DelegateSettledStatus
>;

export const BROWSER_AGENT_RESULT_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
] as const satisfies readonly BrowserAgentResultStatus[]);

/**
 * Host-determined completion. `verified` means an independent postcondition or
 * evidence check passed; unknown outcomes still stay listed on the result.
 * The model's own claim never verifies itself.
 */
export const BROWSER_AGENT_COMPLETIONS = Object.freeze([
  'verified',
  'partial',
  'blocked',
] as const);

/**
 * `criteria_unmet`: the agent listed unmet completion criteria.
 * `unverified`: the host could not verify the claimed completion.
 */
export const BROWSER_AGENT_PARTIAL_REASONS = Object.freeze([
  'criteria_unmet',
  'unverified',
] as const);

/** Generic stop reasons that settle a browser run `cancelled`. */
export const BROWSER_AGENT_CANCELLED_STOP_REASONS = Object.freeze([
  'parent_cancelled',
  'user_cancelled',
  'shutdown',
  'policy_revoked',
  'stopped_by_parent',
  'ancestor_stopped',
] as const satisfies readonly DelegationStopReason[]);

const ErrorMessageSchema = boundedText(
  1,
  LIMITS.errorMessageCharacters,
  'multi',
);

const ResultErrorSchema = z.strictObject({
  code: z.enum(BROWSER_AGENT_RESULT_ERROR_CODES),
  message: ErrorMessageSchema,
  retryable: z.boolean(),
});

const InterruptedErrorSchema = z.strictObject({
  code: z.enum([
    ...BROWSER_AGENT_RESULT_ERROR_CODES,
    BROWSER_AGENT_USER_STOPPED_REASON,
  ]),
  message: ErrorMessageSchema,
  retryable: z.boolean(),
});

/** Mirrors the generic `DelegationStoppedBy` attribution. */
const StoppedBySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('agent'),
    depth: integer(0, MAX_MANAGED_DELEGATION_DEPTH - 1),
    delegationId: BrowserAgentIdSchema.optional(),
    description: boundedText(1, 200, 'single').optional(),
  }),
]);

const ResultCommonShape = {
  version: z.literal(BROWSER_AGENT_CONTRACT_VERSION),
  delegationId: BrowserAgentIdSchema,
  runGeneration: GenerationSchema,
  goalRevision: GenerationSchema,
  limitsVersion: LimitsVersionSchema,
  /** Every tab the run held; complete within the task tab bound. */
  tabs: z
    .array(
      z.strictObject({
        browserId: BrowserAgentIdSchema,
        origin: z.enum(BROWSER_AGENT_TAB_ORIGINS),
        open: z.boolean(),
      }),
    )
    .max(LIMITS.taskTabs),
  /** Receipt counts by status, across every epoch of the run. */
  actions: z.strictObject({
    executed: ActionCountSchema,
    notExecuted: ActionCountSchema,
    outcomeUnknown: ActionCountSchema,
  }),
  /** Every unknown outcome, in full; its length equals `actions.outcomeUnknown`. */
  unknownOutcomes: z
    .array(BrowserAgentUnknownOutcomeReceiptSchema)
    .max(LIMITS.maxActionSequence),
  /** Opaque evidence references owned by this run; retrieved separately. */
  evidence: z.array(BrowserAgentIdSchema).max(LIMITS.resultEvidence),
  usage: z.strictObject({
    inferenceRequests: InferenceRequestCountSchema,
    epochs: integer(0, LIMITS.maxEpoch),
    activeWorkMs: CountSchema,
  }),
  settledAt: TimestampSchema,
};

type BrowserAgentResultCommon = z.output<
  z.ZodObject<typeof ResultCommonShape, z.core.$strict>
>;

function checkResultCommon(
  result: BrowserAgentResultCommon,
  context: IssueContext,
): void {
  const { actions, unknownOutcomes } = result;
  if (
    actions.executed + actions.notExecuted + actions.outcomeUnknown >
    LIMITS.maxActionSequence
  )
    addIssue(context, 'Receipts cannot exceed the action budget.', ['actions']);
  if (unknownOutcomes.length !== actions.outcomeUnknown)
    addIssue(context, 'List every unknown outcome.', ['unknownOutcomes']);
  if (hasDuplicates(unknownOutcomes.map((receipt) => receipt.actionId)))
    addIssue(context, 'Each unknown outcome appears once.', [
      'unknownOutcomes',
    ]);
  if (
    unknownOutcomes.some(
      (receipt) =>
        receipt.epoch.delegationId !== result.delegationId ||
        receipt.epoch.runGeneration !== result.runGeneration,
    )
  )
    addIssue(context, 'Unknown outcomes belong to this run.', [
      'unknownOutcomes',
    ]);
  if (hasDuplicates(result.tabs.map((tab) => tab.browserId)))
    addIssue(context, 'Tabs must be unique.', ['tabs']);
  if (hasDuplicates(result.evidence))
    addIssue(context, 'Evidence must be unique.', ['evidence']);
}

interface CompletionRule {
  readonly answer: Presence;
  readonly findings: Presence;
  readonly missingCriteria: Presence;
  readonly partialReasons: Presence;
  readonly blocked: Presence;
  readonly progress: Presence;
}

const COMPLETION_RULES: Readonly<
  Record<(typeof BROWSER_AGENT_COMPLETIONS)[number], CompletionRule>
> = Object.freeze({
  verified: {
    answer: 'required',
    findings: 'optional',
    missingCriteria: 'absent',
    partialReasons: 'absent',
    blocked: 'absent',
    progress: 'absent',
  },
  partial: {
    answer: 'required',
    findings: 'optional',
    missingCriteria: 'optional',
    partialReasons: 'required',
    blocked: 'absent',
    progress: 'absent',
  },
  blocked: {
    answer: 'absent',
    findings: 'absent',
    missingCriteria: 'absent',
    partialReasons: 'absent',
    blocked: 'required',
    progress: 'optional',
  },
});

const CompletedObjectSchema = z.strictObject({
  ...ResultCommonShape,
  status: z.literal('completed' satisfies BrowserAgentResultStatus),
  completion: z.enum(BROWSER_AGENT_COMPLETIONS),
  partialReasons: z
    .array(z.enum(BROWSER_AGENT_PARTIAL_REASONS))
    .min(1)
    .max(BROWSER_AGENT_PARTIAL_REASONS.length)
    .optional(),
  answer: boundedText(1, LIMITS.answerCharacters, 'multi').optional(),
  findings: z.array(FindingSchema).max(LIMITS.resultFindings).optional(),
  missingCriteria: z
    .array(NoteItemSchema)
    .min(1)
    .max(LIMITS.missingCriteria)
    .optional(),
  blocked: BlockedSchema.optional(),
  progress: BrowserAgentProgressNotesSchema.optional(),
});

function checkCompleted(
  result: z.output<typeof CompletedObjectSchema>,
  context: IssueContext,
): void {
  checkResultCommon(result, context);
  const rule = COMPLETION_RULES[result.completion];
  checkPresence(context, 'answer', result.answer, rule.answer);
  checkPresence(context, 'findings', result.findings, rule.findings);
  checkPresence(
    context,
    'missingCriteria',
    result.missingCriteria,
    rule.missingCriteria,
  );
  checkPresence(
    context,
    'partialReasons',
    result.partialReasons,
    rule.partialReasons,
  );
  checkPresence(context, 'blocked', result.blocked, rule.blocked);
  checkPresence(context, 'progress', result.progress, rule.progress);
  if (result.completion === 'verified' && result.evidence.length === 0)
    addIssue(context, 'Verified completion cites evidence.', ['evidence']);
  const reasons = result.partialReasons ?? [];
  if (hasDuplicates(reasons))
    addIssue(context, 'Partial reasons must be unique.', ['partialReasons']);
  if (
    result.completion === 'partial' &&
    reasons.includes('criteria_unmet') !==
      (result.missingCriteria !== undefined)
  )
    addIssue(context, 'Unmet criteria are listed exactly when reported.', [
      'missingCriteria',
    ]);
}

const StoppedResultShape = {
  ...ResultCommonShape,
  /** The latest recorded notes, as partial output. */
  progress: BrowserAgentProgressNotesSchema.optional(),
};

const USER_ATTRIBUTED_STOPS: readonly DelegationStopReason[] = [
  'user_cancelled',
  'ancestor_stopped',
];
const AGENT_ATTRIBUTED_STOPS: readonly DelegationStopReason[] = [
  'stopped_by_parent',
  'ancestor_stopped',
];

const CancelledObjectSchema = z.strictObject({
  ...StoppedResultShape,
  status: z.literal('cancelled' satisfies BrowserAgentResultStatus),
  stopReason: z.enum(BROWSER_AGENT_CANCELLED_STOP_REASONS),
  stoppedBy: StoppedBySchema.optional(),
  error: ResultErrorSchema.optional(),
});

function checkCancelled(
  result: z.output<typeof CancelledObjectSchema>,
  context: IssueContext,
): void {
  checkResultCommon(result, context);
  if (result.stoppedBy === undefined) return;
  const allowed =
    result.stoppedBy.kind === 'user'
      ? USER_ATTRIBUTED_STOPS
      : AGENT_ATTRIBUTED_STOPS;
  if (!allowed.includes(result.stopReason))
    addIssue(context, 'The stop attribution must match its reason.', [
      'stoppedBy',
    ]);
}

const InterruptedObjectSchema = z.strictObject({
  ...StoppedResultShape,
  status: z.literal('interrupted' satisfies BrowserAgentResultStatus),
  /** Absent for a parent interrupt or a host restart. */
  stopReason: z.literal(BROWSER_AGENT_USER_STOPPED_REASON).optional(),
  stoppedBy: StoppedBySchema.optional(),
  error: InterruptedErrorSchema.optional(),
});

function isUserStopError(error: BrowserAgentError | undefined): boolean {
  const expected = BROWSER_AGENT_USER_STOP.error;
  return (
    error !== undefined &&
    error.code === expected.code &&
    error.message === expected.message &&
    error.retryable === expected.retryable
  );
}

function checkInterrupted(
  result: z.output<typeof InterruptedObjectSchema>,
  context: IssueContext,
): void {
  checkResultCommon(result, context);
  const userStopped = result.stopReason === BROWSER_AGENT_USER_STOPPED_REASON;
  const errorMismatch = userStopped
    ? !isUserStopError(result.error)
    : result.error?.code === BROWSER_AGENT_USER_STOPPED_REASON;
  if (errorMismatch)
    addIssue(
      context,
      'A user stop, and only a user stop, reports "User stopped".',
      ['error'],
    );
  if (userStopped && result.stoppedBy?.kind !== 'user')
    addIssue(context, 'A user stop is attributed to the user.', ['stoppedBy']);
  if (!userStopped && result.stoppedBy !== undefined)
    addIssue(context, 'Only a user stop is attributed here.', ['stoppedBy']);
}

/**
 * The published result of one run generation. Model-authored text is bounded
 * by construction; host-derived uncertainty (every unknown outcome) and
 * authority (status, stop reason, attribution, tabs) are complete, never
 * shortened to make room.
 */
export const BrowserAgentResultSchema = z.discriminatedUnion('status', [
  CompletedObjectSchema.superRefine(checkCompleted),
  z
    .strictObject({
      ...StoppedResultShape,
      status: z.literal('failed' satisfies BrowserAgentResultStatus),
      error: ResultErrorSchema,
    })
    .superRefine(checkResultCommon),
  CancelledObjectSchema.superRefine(checkCancelled),
  z
    .strictObject({
      ...StoppedResultShape,
      status: z.literal('deadline_exceeded' satisfies BrowserAgentResultStatus),
      stopReason: z.literal('deadline_exceeded' satisfies DelegationStopReason),
      error: ResultErrorSchema.optional(),
    })
    .superRefine(checkResultCommon),
  InterruptedObjectSchema.superRefine(checkInterrupted),
]);
export type BrowserAgentResult = z.output<typeof BrowserAgentResultSchema>;

// ---------------------------------------------------------------------------
// Reduced parent browser actions (05 §1.5 and §1.10)
// ---------------------------------------------------------------------------

/** Parent navigation and screenshots, kept while the experiment is on. */
export const BROWSER_AGENT_PARENT_RETAINED_ACTIONS = Object.freeze([
  'browser.list',
  'browser.open',
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.stop',
  'browser.screenshot',
  'browser.save_pdf',
] as const);

/** Page interaction and content actions parents lose; enforce at catalog and dispatch. */
export const BROWSER_AGENT_PARENT_REMOVED_ACTIONS = Object.freeze([
  'browser.click',
  'browser.fill',
  'browser.press',
  'browser.set_checked',
  'browser.select_option',
  'browser.type',
  'browser.hover',
  'browser.scroll',
  'browser.drag',
  'browser.focus',
  'browser.wait_for',
  'browser.input_snapshot',
  'browser.inspect',
  'browser.get_console',
  'browser.get_network',
  'browser.get_dialog',
  'browser.handle_dialog',
  'browser.start_recording',
  'browser.stop_recording',
  'browser.upload_files',
  'browser.request_files',
  'browser.drop_files',
] as const);

/** Profile, external-open, and transfer management: neither page interaction nor content. */
export const BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS = Object.freeze([
  'browser.profile.preview_clear',
  'browser.profile.clear',
  'browser.profile.job_get',
  'browser.profile.job_cancel',
  'browser.profile.list',
  'browser.profile.get',
  'browser.profile.switch',
  'browser.open_external',
  'browser.list_transfers',
  'browser.cancel_transfer',
  'browser.save_download',
] as const);

export type BrowserAgentParentRetainedAction =
  (typeof BROWSER_AGENT_PARENT_RETAINED_ACTIONS)[number];
export type BrowserAgentParentRemovedAction =
  (typeof BROWSER_AGENT_PARENT_REMOVED_ACTIONS)[number];
export type BrowserAgentParentUnchangedAction =
  (typeof BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS)[number];
