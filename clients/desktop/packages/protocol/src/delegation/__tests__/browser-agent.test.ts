import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  DELEGATION_STOP_REASONS,
  isDelegationStopReason,
  type AgentDelegationError,
  type DelegateSettledStatus,
  type DelegationStoppedBy,
} from '@canopy/protocol/delegation';
import * as contract from '@canopy/protocol/delegation/browser-agent';
import {
  BROWSER_AGENT_ACTION_TOOL_NAMES,
  BROWSER_AGENT_BLOCKED_REASONS,
  BROWSER_AGENT_CANCELLED_STOP_REASONS,
  BROWSER_AGENT_CONTRACT_LIMITS,
  BROWSER_AGENT_CONTRACT_VERSION,
  BROWSER_AGENT_CONTROL_ROLES,
  BROWSER_AGENT_CONTROL_TOOL_NAMES,
  BROWSER_AGENT_EXPERIMENT_LIMITS,
  BROWSER_AGENT_KEYS,
  BROWSER_AGENT_NOT_EXECUTED_REASONS,
  BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS,
  BROWSER_AGENT_PARENT_REMOVED_ACTIONS,
  BROWSER_AGENT_PARENT_RETAINED_ACTIONS,
  BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS,
  BROWSER_AGENT_READ_TOOL_NAMES,
  BROWSER_AGENT_RESULT_ERROR_CODES,
  BROWSER_AGENT_RESULT_STATUSES,
  BROWSER_AGENT_STOP_REASONS,
  BROWSER_AGENT_TOOL_ARGUMENTS,
  BROWSER_AGENT_TOOL_NAMES,
  BROWSER_AGENT_USER_STOP,
  BrowserAgentActionCallSchema,
  BrowserAgentActionIntentSchema,
  BrowserAgentActionReceiptSchema,
  BrowserAgentEpochHandoffSchema,
  BrowserAgentHttpUrlSchema,
  BrowserAgentIdSchema,
  BrowserAgentObservationSchema,
  BrowserAgentResultSchema,
  BrowserAgentScreenshotResultSchema,
  BrowserAgentStartRequestSchema,
  BrowserAgentTabListResultSchema,
  BrowserAgentTextReadResultSchema,
  BrowserAgentTextSearchResultSchema,
  BrowserAgentToolCallSchema,
  BrowserAgentWaitResultSchema,
  browserAgentActionTarget,
  isBrowserAgentStopReason,
  isBrowserAgentToolName,
  parseBrowserAgentStartRequest,
  parseBrowserAgentToolCall,
  type BrowserAgentResultStatus,
  type BrowserAgentToolName,
} from '@canopy/protocol/delegation/browser-agent';

type Fixture = Record<string, unknown>;

const DELEGATION_ID = '5f8a3c1e-9b2d-4e7f-8a6b-1c2d3e4f5a6b';
const OTHER_DELEGATION_ID = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const BROWSER_ID = '0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a';
const TASK_BROWSER_ID = '1e2d3c4b-5a6f-4e7d-8c9b-0a1f2e3d4c5b';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NEXT_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = 1_790_000_000_000;
const TARGET = { observationId: 'obs-1', ref: 'input-1' };
const GOAL =
  'Find three refundable hotels in Lisbon for 3–5 May, return prices and cancellation terms, and stop before booking.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueMessages(schema: z.ZodType, value: unknown): string[] {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
}

function issueCodes(schema: z.ZodType, value: unknown): string[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.code);
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function without(fixture: Fixture, key: string): Fixture {
  return Object.fromEntries(
    Object.entries(fixture).filter(([name]) => name !== key),
  );
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function repeated<Value>(length: number, value: Value): Value[] {
  return Array.from({ length }, () => value);
}

function epochIdentity(
  epoch: number,
  runGeneration: number = 1,
  delegationId: string = DELEGATION_ID,
): Fixture {
  return { delegationId, runGeneration, epoch };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMAIL_CONTROL: Fixture = {
  ref: 'input-1',
  role: 'textbox',
  name: 'Email',
  value: 'ada@example.com',
  inViewport: true,
  state: { required: true, focused: true },
};
const PASSWORD_CONTROL: Fixture = {
  ref: 'input-2',
  role: 'textbox',
  name: 'Password',
  valueRedacted: true,
  inViewport: true,
};
const COUNTRY_CONTROL: Fixture = {
  ref: 'input-3',
  role: 'select',
  name: 'Country',
  value: 'Portugal',
  inViewport: true,
  options: {
    entries: [
      { label: 'Portugal', selected: true },
      { label: 'Spain', selected: false, disabled: true },
    ],
    total: 250,
    omitted: 248,
  },
};
const SUBMIT_CONTROL: Fixture = {
  ref: 'input-4',
  role: 'button',
  name: 'Place order',
  inViewport: false,
  state: { disabled: false },
};

function observation(overrides: Fixture = {}): Fixture {
  return {
    version: 1,
    observationId: 'obs-1',
    epoch: epochIdentity(2),
    runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
    document: { documentId: 'doc-7', navigationRevision: 4 },
    interaction: { revision: 2, userInteracted: true },
    capturedAt: NOW,
    page: {
      url: 'https://shop.example/checkout?step=2',
      title: 'Checkout',
      loading: false,
      visible: true,
      viewport: {
        width: 1280,
        height: 800,
        scrollX: 0,
        scrollY: 640,
        scrollWidth: 1280,
        scrollHeight: 4200,
      },
    },
    controls: [
      EMAIL_CONTROL,
      PASSWORD_CONTROL,
      COUNTRY_CONTROL,
      SUBMIT_CONTROL,
    ],
    controlCoverage: {
      found: 9,
      returned: 4,
      omittedOverLimit: 3,
      omittedUnsupported: 2,
    },
    visibleText: {
      text: 'Checkout\nShipping address',
      totalCharacters: 1_025,
      omittedCharacters: 1_000,
    },
    redactedValues: 1,
    dialog: {
      dialogId: 'dialog-1',
      kind: 'confirm',
      message: 'Leave this page?',
      omittedCharacters: 0,
    },
    ...overrides,
  };
}

function fixturePage(): Fixture {
  const page = observation().page;
  if (!isRecord(page)) throw new Error('The observation fixture has a page.');
  return page;
}

const PROGRESS_NOTES: Fixture = {
  summary: 'Compared two refundable hotels; the third search page is loading.',
  findings: [
    {
      text: 'Hotel Alfama: €120 a night, free cancellation until 1 May.',
      evidenceId: 'obs-3',
    },
  ],
  pending: ['Find a third refundable hotel'],
  failedApproaches: ['The price filter did not open'],
  nextStep: 'Open the next results page',
};

function receipt(
  sequence: number,
  epoch: number,
  status: Fixture,
  overrides: Fixture = {},
): Fixture {
  return {
    version: 1,
    actionId: `action-${sequence}`,
    sequence,
    epoch: epochIdentity(epoch),
    subject: { tool: 'click', control: { role: 'button', name: 'Search' } },
    recordedAt: NOW + sequence,
    ...status,
    ...overrides,
  };
}

function executedReceipt(
  sequence: number,
  epoch: number,
  overrides: Fixture = {},
): Fixture {
  return receipt(
    sequence,
    epoch,
    {
      status: 'executed',
      effects: { navigation: 'new_document', dialogOpened: false },
    },
    overrides,
  );
}

function notExecutedReceipt(
  sequence: number,
  epoch: number,
  overrides: Fixture = {},
): Fixture {
  return receipt(
    sequence,
    epoch,
    { status: 'not_executed', reason: 'stale_observation' },
    overrides,
  );
}

function unknownReceipt(
  sequence: number,
  epoch: number,
  overrides: Fixture = {},
): Fixture {
  return receipt(
    sequence,
    epoch,
    {
      status: 'outcome_unknown',
      reason: 'dispatch_timeout',
      subject: {
        tool: 'click',
        control: { role: 'button', name: 'Place order' },
      },
    },
    overrides,
  );
}

function clickIntent(overrides: Fixture = {}): Fixture {
  return {
    version: 1,
    actionId: 'action-5',
    sequence: 5,
    epoch: epochIdentity(3),
    basis: {
      leaseId: 'lease-1',
      runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
      document: { documentId: 'doc-7', navigationRevision: 4 },
      interactionRevision: 2,
      observationId: 'obs-1',
    },
    call: { tool: 'click', arguments: { target: TARGET } },
    subject: {
      tool: 'click',
      control: { role: 'button', name: 'Place order' },
    },
    recordedAt: NOW,
    ...overrides,
  };
}

function startHandoff(overrides: Fixture = {}): Fixture {
  return {
    version: 1,
    epoch: epochIdentity(1),
    trigger: 'start',
    goal: { revision: 1, text: GOAL },
    authority: {
      leaseId: 'lease-1',
      runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
      policyRevision: 'policy-12',
      launchManifestDigest: DIGEST,
      limitsVersion: 2,
    },
    budget: { actionsUsed: 0, inferenceRequestsUsed: 0, activeWorkMs: 0 },
    lastCommittedActionSequence: 0,
    notes: { revision: 0 },
    receipts: { entries: [], omitted: 0 },
    unknownOutcomes: [],
    createdAt: NOW,
    ...overrides,
  };
}

function navigationHandoff(overrides: Fixture = {}): Fixture {
  return startHandoff({
    epoch: epochIdentity(3),
    trigger: 'navigation',
    previousHandoffDigest: DIGEST,
    goal: { revision: 2, text: `${GOAL} Prefer Alfama.` },
    authority: {
      leaseId: 'lease-1',
      runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
      policyRevision: 'policy-12',
      launchManifestDigest: NEXT_DIGEST,
      limitsVersion: 2,
    },
    budget: { actionsUsed: 4, inferenceRequestsUsed: 9, activeWorkMs: 95_000 },
    lastCommittedActionSequence: 4,
    notes: { revision: 2, content: PROGRESS_NOTES },
    receipts: {
      entries: [executedReceipt(1, 1), notExecutedReceipt(2, 2)],
      omitted: 1,
    },
    unknownOutcomes: [unknownReceipt(4, 2)],
    ...overrides,
  });
}

function resultCommon(overrides: Fixture = {}): Fixture {
  return {
    version: 1,
    delegationId: DELEGATION_ID,
    runGeneration: 1,
    goalRevision: 2,
    limitsVersion: 2,
    tabs: [
      { browserId: BROWSER_ID, origin: 'existing', open: true },
      { browserId: TASK_BROWSER_ID, origin: 'task', open: false },
    ],
    actions: { executed: 6, notExecuted: 1, outcomeUnknown: 0 },
    unknownOutcomes: [],
    evidence: ['obs-9', 'shot-2'],
    usage: { inferenceRequests: 14, epochs: 3, activeWorkMs: 212_000 },
    settledAt: NOW,
    ...overrides,
  };
}

function verifiedResult(overrides: Fixture = {}): Fixture {
  return resultCommon({
    status: 'completed',
    completion: 'verified',
    answer:
      'Alfama (€120), Baixa (€135), Belém (€150): each allows free cancellation until 1 May.',
    findings: [
      {
        text: 'Hotel Alfama: €120 a night, free cancellation until 1 May.',
        evidenceId: 'obs-9',
      },
    ],
    ...overrides,
  });
}

function partialResult(overrides: Fixture = {}): Fixture {
  return resultCommon({
    status: 'completed',
    completion: 'partial',
    partialReasons: ['criteria_unmet'],
    answer: 'Two refundable hotels found.',
    missingCriteria: ['A third refundable hotel'],
    ...overrides,
  });
}

function blockedResult(overrides: Fixture = {}): Fixture {
  return resultCommon({
    status: 'completed',
    completion: 'blocked',
    blocked: {
      reason: 'login_required',
      message: 'Sign in to the booking site in this tab, then send a new goal.',
    },
    progress: PROGRESS_NOTES,
    ...overrides,
  });
}

function userStoppedResult(overrides: Fixture = {}): Fixture {
  return resultCommon({
    status: 'interrupted',
    stopReason: 'user_stopped',
    stoppedBy: { kind: 'user' },
    error: { code: 'user_stopped', message: 'User stopped', retryable: false },
    progress: PROGRESS_NOTES,
    actions: { executed: 3, notExecuted: 0, outcomeUnknown: 1 },
    unknownOutcomes: [
      unknownReceipt(4, 2, { reason: 'stopped_after_dispatch' }),
    ],
    ...overrides,
  });
}

function cancelledResult(overrides: Fixture = {}): Fixture {
  return resultCommon({
    status: 'cancelled',
    stopReason: 'stopped_by_parent',
    stoppedBy: { kind: 'agent', depth: 0 },
    error: {
      code: 'terminated_by_parent',
      message: 'Stopped by the parent chat.',
      retryable: false,
    },
    ...overrides,
  });
}

const VALID_ARGUMENTS: { readonly [Name in BrowserAgentToolName]: Fixture } = {
  observe: { query: 'checkout form' },
  read_text: { cursor: 'cursor-2', maxCharacters: 2_000 },
  search_text: { query: 'free cancellation', maxMatches: 5 },
  screenshot: {},
  list_tabs: {},
  wait: {
    until: { kind: 'text_present', text: 'Order confirmed', timeoutMs: 5_000 },
  },
  click: { target: TARGET },
  fill: { target: TARGET, text: 'Ada Lovelace\n12 Analytical Way' },
  select_option: { target: TARGET, label: 'Portugal' },
  press_key: { key: 'Enter', target: TARGET },
  scroll: { to: { kind: 'page', direction: 'down', amount: 'page' } },
  handle_dialog: {
    dialogId: 'dialog-1',
    response: { kind: 'accept', promptText: 'yes' },
  },
  navigate: { url: 'https://example.com/hotels?city=Lisbon' },
  go_back: {},
  go_forward: {},
  reload: {},
  open_tab: { url: 'https://example.org/' },
  switch_tab: { browserId: TASK_BROWSER_ID },
  close_tab: { browserId: TASK_BROWSER_ID },
  record_progress: PROGRESS_NOTES,
  finish: {
    answer: 'Three refundable hotels, with prices and terms.',
    findings: [{ text: 'Hotel Alfama: €120.', evidenceId: 'obs-9' }],
    missingCriteria: [],
  },
  report_blocked: {
    reason: 'captcha',
    message: 'Solve the CAPTCHA in this tab, then send a new goal.',
  },
};

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

function nodeProblems(node: Record<string, unknown>, path: string): string[] {
  const fixed = node.const !== undefined || Array.isArray(node.enum);
  switch (node.type) {
    case 'object':
      return node.additionalProperties === false ? [] : [`${path} is open`];
    case 'array':
      return typeof node.maxItems === 'number' ? [] : [`${path} is unbounded`];
    case 'string':
      return fixed || typeof node.maxLength === 'number'
        ? []
        : [`${path} has no length bound`];
    case 'number':
    case 'integer':
      return fixed ||
        (typeof node.minimum === 'number' && typeof node.maximum === 'number')
        ? []
        : [`${path} has no range`];
    case 'boolean':
      return [];
    default:
      return fixed || Array.isArray(node.oneOf) || Array.isArray(node.anyOf)
        ? []
        : [`${path} is untyped`];
  }
}

function childNodes(
  node: Record<string, unknown>,
  path: string,
): (readonly [string, unknown])[] {
  const children: (readonly [string, unknown])[] = [];
  if (isRecord(node.properties))
    for (const [key, child] of Object.entries(node.properties))
      children.push([`${path}.${key}`, child]);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const list = node[key];
    if (Array.isArray(list))
      list.forEach((child: unknown, index: number) =>
        children.push([`${path}.${key}[${index}]`, child]),
      );
  }
  if (node.items !== undefined) children.push([`${path}[]`, node.items]);
  return children;
}

/** Every object closed, every string/array/number bounded. */
function openOrUnboundedNodes(node: unknown, path: string): string[] {
  if (!isRecord(node)) return [];
  return [
    ...nodeProblems(node, path),
    ...childNodes(node, path).flatMap(([childPath, child]) =>
      openOrUnboundedNodes(child, childPath),
    ),
  ];
}

function stringMaxCharacters(node: Record<string, unknown>): number {
  if (typeof node.maxLength === 'number') return node.maxLength;
  if (typeof node.const === 'string') return node.const.length;
  if (Array.isArray(node.enum))
    return Math.max(
      ...node.enum.map((value: unknown) =>
        typeof value === 'string' ? value.length : 0,
      ),
    );
  return Number.POSITIVE_INFINITY;
}

/** The most text characters a value of this JSON Schema can carry. */
function maxTextCharacters(node: unknown): number {
  if (!isRecord(node)) return 0;
  const options = Array.isArray(node.oneOf) ? node.oneOf : node.anyOf;
  if (Array.isArray(options))
    return Math.max(
      ...options.map((option: unknown) => maxTextCharacters(option)),
    );
  if (node.type === 'object' && isRecord(node.properties))
    return Object.values(node.properties).reduce(
      (total: number, child: unknown) => total + maxTextCharacters(child),
      0,
    );
  if (node.type === 'array' && typeof node.maxItems === 'number')
    return node.maxItems * maxTextCharacters(node.items);
  return node.type === 'string' ? stringMaxCharacters(node) : 0;
}

function toolArgumentsJsonSchema(name: BrowserAgentToolName): unknown {
  return z.toJSONSchema(BROWSER_AGENT_TOOL_ARGUMENTS[name]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser agent limits', () => {
  it('names the versioned README experiment limits exactly', () => {
    expect(BROWSER_AGENT_EXPERIMENT_LIMITS).toEqual({
      name: 'browser-agent-initial-experiment',
      version: 2,
      tokenBudgets: {
        contextCheckpoint: 125_000,
        handoff: 2_000,
        observation: 6_000,
        result: 2_000,
      },
      taskBudgets: {
        actions: 50,
        inferenceRequests: 100,
        activeWorkMs: 600_000,
      },
      observation: { controls: 100, textCharacters: 6_000 },
    });
    expect(Object.isFrozen(BROWSER_AGENT_EXPERIMENT_LIMITS)).toBe(true);
    expect(Object.isFrozen(BROWSER_AGENT_EXPERIMENT_LIMITS.tokenBudgets)).toBe(
      true,
    );
    expect(Object.isFrozen(BROWSER_AGENT_EXPERIMENT_LIMITS.taskBudgets)).toBe(
      true,
    );
    expect(Object.isFrozen(BROWSER_AGENT_EXPERIMENT_LIMITS.observation)).toBe(
      true,
    );
  });

  it('pins every finite structural bound', () => {
    expect(BROWSER_AGENT_CONTRACT_LIMITS).toEqual({
      idCharacters: 128,
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
      observationControls: 100,
      textCharacters: 6_000,
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
      maxActionSequence: 50,
      maxEpoch: 100,
      maxInferenceRequests: 100,
      progressNotesCharacters: 8_000,
      resultModelCharacters: 8_000,
      waitMinMs: 100,
      waitMaxMs: 30_000,
      maxPixels: 10_000_000,
    });
    expect(Object.isFrozen(BROWSER_AGENT_CONTRACT_LIMITS)).toBe(true);
    expect(BROWSER_AGENT_CONTRACT_VERSION).toBe(1);
  });

  it('derives structural counts from the experiment budgets', () => {
    const experiment = BROWSER_AGENT_EXPERIMENT_LIMITS;
    const limits = BROWSER_AGENT_CONTRACT_LIMITS;
    expect(limits.observationControls).toBe(experiment.observation.controls);
    expect(limits.textCharacters).toBe(experiment.observation.textCharacters);
    expect(limits.maxActionSequence).toBe(experiment.taskBudgets.actions);
    expect(limits.maxEpoch).toBe(experiment.taskBudgets.inferenceRequests);
    expect(limits.maxInferenceRequests).toBe(
      experiment.taskBudgets.inferenceRequests,
    );
  });

  it('caps model-authored text in aggregate by construction', () => {
    const limits = BROWSER_AGENT_CONTRACT_LIMITS;
    const notes = maxTextCharacters(toolArgumentsJsonSchema('record_progress'));
    const finish = maxTextCharacters(toolArgumentsJsonSchema('finish'));
    const blocked = maxTextCharacters(
      toolArgumentsJsonSchema('report_blocked'),
    );
    expect(notes).toBe(7_424);
    expect(notes).toBeLessThanOrEqual(limits.progressNotesCharacters);
    expect(finish).toBe(7_968);
    expect(finish).toBeLessThanOrEqual(limits.resultModelCharacters);
    // A blocked result carries the blocked report and the latest notes.
    expect(blocked + notes).toBeLessThanOrEqual(limits.resultModelCharacters);
  });
});

describe('Start Browser Agent request', () => {
  it('accepts a goal with exactly one existing tab or URL', () => {
    expect(
      parseBrowserAgentStartRequest({ goal: GOAL, browserId: BROWSER_ID }),
    ).toEqual({ ok: true, value: { goal: GOAL, browserId: BROWSER_ID } });
    expect(
      parseBrowserAgentStartRequest({
        goal: 'Line one\n\tLine two',
        url: 'https://example.com/hotels?city=Lisbon#results',
      }),
    ).toEqual({
      ok: true,
      value: {
        goal: 'Line one\n\tLine two',
        url: 'https://example.com/hotels?city=Lisbon#results',
      },
    });
  });

  it('describes the target rule when both or neither target is given', () => {
    const error = {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Provide exactly one target: browserId or url.',
        retryable: false,
      },
    };
    expect(
      parseBrowserAgentStartRequest({
        goal: GOAL,
        browserId: BROWSER_ID,
        url: 'https://example.com/',
      }),
    ).toEqual(error);
    expect(parseBrowserAgentStartRequest({ goal: GOAL })).toEqual(error);
  });

  it('keeps model, effort, profile, and limits out of the caller input', () => {
    for (const extra of [
      { model: 'gpt-6-luna' },
      { effort: 'high' },
      { thinkingLevel: 'high' },
      { profileId: 'work' },
      { expectedRuntimeGeneration: 3 },
      { limits: { actions: 500 } },
      { capabilities: [] },
    ])
      expect(
        parseBrowserAgentStartRequest({
          goal: GOAL,
          browserId: BROWSER_ID,
          ...extra,
        }),
      ).toEqual({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Invalid Start Browser Agent request.',
          retryable: false,
        },
      });
    for (const input of [null, 'goal', [GOAL], 42])
      expect(parseBrowserAgentStartRequest(input)).toMatchObject({
        ok: false,
        error: { message: 'Invalid Start Browser Agent request.' },
      });
  });

  it('bounds the goal without truncating it', () => {
    const goalError = {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Provide a goal of up to 8,000 characters.',
        retryable: false,
      },
    };
    expect(
      parseBrowserAgentStartRequest({
        goal: 'g'.repeat(8_000),
        browserId: BROWSER_ID,
      }),
    ).toMatchObject({ ok: true });
    for (const goal of [
      '',
      '   \n',
      'g'.repeat(8_001),
      'a\u0000b',
      'a\u0085b',
      7,
    ])
      expect(
        parseBrowserAgentStartRequest({ goal, browserId: BROWSER_ID }),
      ).toEqual(goalError);
    expect(parseBrowserAgentStartRequest({ browserId: BROWSER_ID })).toEqual(
      goalError,
    );
  });

  it('accepts only HTTP(S) URL syntax without credentials', () => {
    for (const url of [
      'https://example.com',
      'http://example.com:8080/path?q=1#frag',
      'HTTPS://EXAMPLE.COM/',
      'https://例え.jp/',
      'https://[2001:db8::1]/',
      'https://example.com/@handle',
      // Syntax only: the owning core decides whether a destination is admitted.
      'http://localhost:3000/',
    ])
      expect([url, accepts(BrowserAgentHttpUrlSchema, url)]).toEqual([
        url,
        true,
      ]);
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/5f8a3c1e',
      'chrome://settings',
      'about:blank',
      'ftp://example.com/',
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'https://:pass@example.com/',
      'https://@example.com/',
      'https://example.com/a b',
      ' https://example.com/',
      'https://example.com/\npath',
      'https://exa\u0000mple.com/',
      'https://example.com\\@evil.example/',
      'https:///example.com',
      'https://example.com:99999/',
      '//example.com/',
      'example.com',
      `https://${'a'.repeat(2_040)}.com/`,
    ])
      expect([url, accepts(BrowserAgentHttpUrlSchema, url)]).toEqual([
        url,
        false,
      ]);
    expect(
      parseBrowserAgentStartRequest({
        goal: GOAL,
        url: 'https://user:pass@example.com/',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Use an http or https URL without credentials.',
        retryable: false,
      },
    });
  });

  it('accepts only opaque identifiers, never paths', () => {
    for (const id of [
      'obs-1',
      BROWSER_ID,
      'input-0123456789abcdef0123456789abcdef-12',
      'a'.repeat(128),
    ])
      expect([id, accepts(BrowserAgentIdSchema, id)]).toEqual([id, true]);
    for (const id of [
      '',
      ' obs-1',
      'obs 1',
      'obs\n1',
      'obs.1',
      '-leading',
      '/Users/me/shot.png',
      'C:\\shots\\a.png',
      '../secret',
      'file:///tmp/a',
      'a'.repeat(129),
    ])
      expect([id, accepts(BrowserAgentIdSchema, id)]).toEqual([id, false]);
  });

  it('projects to a closed JSON Schema with one variant per target', () => {
    expect(z.toJSONSchema(BrowserAgentStartRequestSchema)).toMatchObject({
      anyOf: [
        {
          type: 'object',
          required: ['goal', 'browserId'],
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['goal', 'url'],
          additionalProperties: false,
        },
      ],
    });
  });
});

describe('closed browser agent tool set', () => {
  const EXPECTED_READ_TOOLS = [
    'observe',
    'read_text',
    'search_text',
    'screenshot',
    'list_tabs',
    'wait',
  ];
  const EXPECTED_ACTION_TOOLS = [
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
  ];
  const EXPECTED_CONTROL_TOOLS = [
    'record_progress',
    'finish',
    'report_blocked',
  ];

  it('matches the reviewed allowlist snapshot exactly', () => {
    expect(BROWSER_AGENT_TOOL_NAMES).toEqual([
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
    ]);
    expect(BROWSER_AGENT_READ_TOOL_NAMES).toEqual(EXPECTED_READ_TOOLS);
    expect(BROWSER_AGENT_ACTION_TOOL_NAMES).toEqual(EXPECTED_ACTION_TOOLS);
    expect(BROWSER_AGENT_CONTROL_TOOL_NAMES).toEqual(EXPECTED_CONTROL_TOOLS);
    for (const list of [
      BROWSER_AGENT_TOOL_NAMES,
      BROWSER_AGENT_READ_TOOL_NAMES,
      BROWSER_AGENT_ACTION_TOOL_NAMES,
      BROWSER_AGENT_CONTROL_TOOL_NAMES,
      BROWSER_AGENT_TOOL_ARGUMENTS,
    ])
      expect(Object.isFrozen(list)).toBe(true);
  });

  it('partitions every tool into exactly one category', () => {
    const categorized = [
      ...BROWSER_AGENT_READ_TOOL_NAMES,
      ...BROWSER_AGENT_ACTION_TOOL_NAMES,
      ...BROWSER_AGENT_CONTROL_TOOL_NAMES,
    ];
    expect(new Set(categorized).size).toBe(categorized.length);
    expect([...categorized].sort()).toEqual(
      [...BROWSER_AGENT_TOOL_NAMES].sort(),
    );
    expect(Object.keys(BROWSER_AGENT_TOOL_ARGUMENTS)).toEqual(
      BROWSER_AGENT_TOOL_NAMES,
    );
    expect(
      BrowserAgentToolCallSchema.options.map(
        (option) => option.shape.tool.value,
      ),
    ).toEqual(BROWSER_AGENT_TOOL_NAMES);
    expect(
      BrowserAgentActionCallSchema.options.map(
        (option) => option.shape.tool.value,
      ),
    ).toEqual(EXPECTED_ACTION_TOOLS);
  });

  it('offers no host-data, script, recording, profile, or delegation tool', () => {
    const forbidden =
      /eval|script|exec|shell|upload|download|file|clipboard|paste|cookie|storage|console|network|recording|profile|external|credential|password|devtools|cdp|spawn|delegat|fetch|http/;
    expect(
      BROWSER_AGENT_TOOL_NAMES.filter((name) => forbidden.test(name)),
    ).toEqual([]);
    expect(
      BROWSER_AGENT_TOOL_NAMES.filter((name) => name.startsWith('browser.')),
    ).toEqual([]);
  });

  it('pins the argument keys of every tool', () => {
    const keys = Object.fromEntries(
      BROWSER_AGENT_TOOL_NAMES.map((name) => {
        const schema = toolArgumentsJsonSchema(name);
        if (!isRecord(schema) || !isRecord(schema.properties))
          throw new Error(`${name} has no object schema`);
        return [
          name,
          {
            properties: Object.keys(schema.properties),
            required: Array.isArray(schema.required) ? schema.required : [],
          },
        ];
      }),
    );
    expect(keys).toEqual({
      observe: { properties: ['query'], required: [] },
      read_text: { properties: ['cursor', 'maxCharacters'], required: [] },
      search_text: {
        properties: ['query', 'cursor', 'maxMatches'],
        required: ['query'],
      },
      screenshot: { properties: [], required: [] },
      list_tabs: { properties: [], required: [] },
      wait: { properties: ['until'], required: ['until'] },
      click: { properties: ['target'], required: ['target'] },
      fill: { properties: ['target', 'text'], required: ['target', 'text'] },
      select_option: {
        properties: ['target', 'label'],
        required: ['target', 'label'],
      },
      press_key: { properties: ['key', 'target'], required: ['key'] },
      scroll: { properties: ['to'], required: ['to'] },
      handle_dialog: {
        properties: ['dialogId', 'response'],
        required: ['dialogId', 'response'],
      },
      navigate: { properties: ['url'], required: ['url'] },
      go_back: { properties: [], required: [] },
      go_forward: { properties: [], required: [] },
      reload: { properties: [], required: [] },
      open_tab: { properties: ['url'], required: ['url'] },
      switch_tab: { properties: ['browserId'], required: ['browserId'] },
      close_tab: { properties: ['browserId'], required: ['browserId'] },
      record_progress: {
        properties: [
          'summary',
          'findings',
          'pending',
          'failedApproaches',
          'nextStep',
        ],
        required: ['summary'],
      },
      finish: {
        properties: ['answer', 'findings', 'missingCriteria'],
        required: ['answer'],
      },
      report_blocked: {
        properties: ['reason', 'message'],
        required: ['reason', 'message'],
      },
    });
  });

  it('projects each tool to a closed, bounded object JSON Schema', () => {
    for (const name of BROWSER_AGENT_TOOL_NAMES) {
      const schema = toolArgumentsJsonSchema(name);
      expect([name, schema]).toEqual([
        name,
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
        }),
      ]);
      expect([name, openOrUnboundedNodes(schema, name)]).toEqual([name, []]);
    }
  });

  it('fails when any tool argument schema changes without review', () => {
    const catalog = Object.fromEntries(
      BROWSER_AGENT_TOOL_NAMES.map((name) => [
        name,
        toolArgumentsJsonSchema(name),
      ]),
    );
    const digest = createHash('sha256')
      .update(JSON.stringify(catalog))
      .digest('hex');
    // Review the JSON Schema change, requalify its prompt cost, then update.
    expect(digest).toBe(
      '9941fa5ca71e831597d9bf2b70efbdf29625cadc437b9ce794b41accbbba96e1',
    );
  });

  it('accepts one realistic call per tool', () => {
    for (const name of BROWSER_AGENT_TOOL_NAMES)
      expect([
        name,
        parseBrowserAgentToolCall(name, VALID_ARGUMENTS[name]),
      ]).toEqual([
        name,
        { ok: true, value: { tool: name, arguments: VALID_ARGUMENTS[name] } },
      ]);
  });

  it('refuses guessed tool names before reading arguments', () => {
    for (const name of [
      'browser.click',
      'evaluate',
      'execute_script',
      'upload_file',
      'read_clipboard',
      'Observe',
      'observe ',
      'constructor',
      '__proto__',
      'toString',
      '',
      undefined,
      42,
    ]) {
      expect(isBrowserAgentToolName(name)).toBe(false);
      expect(parseBrowserAgentToolCall(name, {})).toEqual({
        ok: false,
        reason: 'unknown_tool',
      });
    }
  });

  it('rejects script, selector, coordinate, and path arguments on every tool', () => {
    for (const name of BROWSER_AGENT_TOOL_NAMES)
      for (const extra of [
        { script: 'document.cookie' },
        { expression: '1 + 1' },
        { locator: 'text=Buy' },
        { selector: '#buy' },
        { x: 10 },
        { path: '/Users/me/file.txt' },
      ])
        expect([
          name,
          parseBrowserAgentToolCall(name, {
            ...VALID_ARGUMENTS[name],
            ...extra,
          }),
        ]).toEqual([name, { ok: false, reason: 'invalid_arguments' }]);
  });

  it('presses only keys from the closed vocabulary', () => {
    expect(BROWSER_AGENT_KEYS).toEqual([
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
    ]);
    for (const key of [
      'Control+V',
      'Meta+V',
      'Ctrl+C',
      'Shift+Insert',
      'Meta+S',
      'Control+Shift+I',
      'Alt+F4',
      'F12',
      'PrintScreen',
      'ContextMenu',
      'a',
      'enter',
    ])
      expect([key, parseBrowserAgentToolCall('press_key', { key })]).toEqual([
        key,
        { ok: false, reason: 'invalid_arguments' },
      ]);
  });

  it('keeps cross-field rules in closed variants', () => {
    const valid = [
      [
        'scroll',
        { to: { kind: 'container', target: TARGET, direction: 'up' } },
      ],
      ['scroll', { to: { kind: 'element', target: TARGET } }],
      ['scroll', { to: { kind: 'text', text: 'Cancellation policy' } }],
      ['wait', { until: { kind: 'duration', milliseconds: 100 } }],
      ['wait', { until: { kind: 'load_complete', timeoutMs: 30_000 } }],
      [
        'handle_dialog',
        { dialogId: 'dialog-1', response: { kind: 'dismiss' } },
      ],
      ['press_key', { key: 'Shift+Tab' }],
      ['fill', { target: TARGET, text: '' }],
    ] as const;
    for (const [name, args] of valid)
      expect([name, parseBrowserAgentToolCall(name, args).ok]).toEqual([
        name,
        true,
      ]);
    const invalid = [
      ['scroll', { to: { kind: 'page' } }],
      ['scroll', { to: { kind: 'element' } }],
      ['scroll', { to: { kind: 'text', text: 'x', target: TARGET } }],
      ['wait', { until: { kind: 'duration', milliseconds: 99 } }],
      ['wait', { until: { kind: 'duration', milliseconds: 30_001 } }],
      ['wait', { until: { kind: 'text_present', text: 'Done' } }],
      [
        'handle_dialog',
        {
          dialogId: 'dialog-1',
          response: { kind: 'dismiss', promptText: 'x' },
        },
      ],
      ['click', { target: { observationId: 'obs-1' } }],
      ['click', { target: { observationId: 'obs-1', ref: 'e1', x: 1 } }],
      ['select_option', { target: TARGET, label: '  ' }],
      ['fill', { target: TARGET, text: 'x'.repeat(8_001) }],
      ['navigate', { url: 'file:///etc/passwd' }],
      ['open_tab', { url: 'https://user:pass@example.com/' }],
      ['search_text', { query: 'x', maxMatches: 21 }],
      ['read_text', { maxCharacters: 6_001 }],
      ['observe', { query: 'two\nlines' }],
      [
        'record_progress',
        { summary: 'x', findings: repeated(9, { text: 'y' }) },
      ],
      ['record_progress', { summary: 'x', pending: repeated(7, 'y') }],
      ['finish', { answer: 'x', findings: repeated(7, { text: 'y' }) }],
      ['finish', { answer: 'x'.repeat(4_001) }],
      ['report_blocked', { reason: 'bored', message: 'x' }],
      ['report_blocked', { reason: 'other', message: 'x'.repeat(401) }],
    ] as const;
    for (const [name, args] of invalid)
      expect([name, args, parseBrowserAgentToolCall(name, args).ok]).toEqual([
        name,
        args,
        false,
      ]);
    expect(BROWSER_AGENT_BLOCKED_REASONS).toEqual([
      'login_required',
      'captcha',
      'user_decision',
      'unsupported_interaction',
      'destination_denied',
      'site_unavailable',
      'other',
    ]);
  });

  it('finds the observed target of each action', () => {
    expect(
      browserAgentActionTarget({
        tool: 'fill',
        arguments: { target: TARGET, text: 'x' },
      }),
    ).toEqual(TARGET);
    expect(
      browserAgentActionTarget({
        tool: 'scroll',
        arguments: { to: { kind: 'element', target: TARGET } },
      }),
    ).toEqual(TARGET);
    expect(
      browserAgentActionTarget({
        tool: 'scroll',
        arguments: { to: { kind: 'text', text: 'Policy' } },
      }),
    ).toBeUndefined();
    expect(
      browserAgentActionTarget({
        tool: 'press_key',
        arguments: { key: 'Escape' },
      }),
    ).toBeUndefined();
    expect(
      browserAgentActionTarget({
        tool: 'navigate',
        arguments: { url: 'https://example.com/' },
      }),
    ).toBeUndefined();
  });
});

describe('observation envelope', () => {
  it('carries identities, bounded controls, and explicit coverage', () => {
    const parsed = BrowserAgentObservationSchema.parse(observation());
    expect(parsed).toMatchObject({
      observationId: 'obs-1',
      epoch: { delegationId: DELEGATION_ID, runGeneration: 1, epoch: 2 },
      runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
      document: { documentId: 'doc-7', navigationRevision: 4 },
      interaction: { revision: 2, userInteracted: true },
      controlCoverage: {
        found: 9,
        returned: 4,
        omittedOverLimit: 3,
        omittedUnsupported: 2,
      },
    });
    const roundTripped = jsonRoundTrip(parsed);
    expect(roundTripped).toEqual(parsed);
    expect(accepts(BrowserAgentObservationSchema, roundTripped)).toBe(true);
    expect(
      accepts(
        BrowserAgentObservationSchema,
        observation({ page: { ...fixturePage(), url: 'about:blank' } }),
      ),
    ).toBe(true);
  });

  it('rejects invalid runtime, document, epoch, and interaction identities', () => {
    for (const overrides of [
      { epoch: epochIdentity(0) },
      { epoch: epochIdentity(101) },
      { epoch: epochIdentity(1.5) },
      { epoch: epochIdentity(1, 0) },
      { epoch: epochIdentity(1, 1, '/Users/me') },
      { runtime: { browserId: BROWSER_ID, runtimeGeneration: 0 } },
      { runtime: { browserId: 'tab 1', runtimeGeneration: 1 } },
      { document: { documentId: 'doc-7', navigationRevision: -1 } },
      { document: { documentId: 'doc-7', navigationRevision: Infinity } },
      { interaction: { revision: Number.NaN, userInteracted: false } },
      { interaction: { revision: 1 } },
      { observationId: '' },
      { capturedAt: -1 },
      { version: 2 },
    ])
      expect([
        overrides,
        accepts(BrowserAgentObservationSchema, observation(overrides)),
      ]).toEqual([overrides, false]);
  });

  it('accounts for every control and visible character', () => {
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        observation({
          controlCoverage: {
            found: 9,
            returned: 3,
            omittedOverLimit: 4,
            omittedUnsupported: 2,
          },
        }),
      ),
    ).toEqual(['Returned controls must match the control list.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        observation({
          controlCoverage: {
            found: 10,
            returned: 4,
            omittedOverLimit: 3,
            omittedUnsupported: 2,
          },
        }),
      ),
    ).toEqual(['Found controls must equal returned plus omitted.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        observation({
          visibleText: {
            text: 'Checkout',
            totalCharacters: 1_025,
            omittedCharacters: 1_000,
          },
        }),
      ),
    ).toEqual(['Visible text coverage must count every character.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        observation({
          controls: [
            EMAIL_CONTROL,
            EMAIL_CONTROL,
            COUNTRY_CONTROL,
            SUBMIT_CONTROL,
          ],
        }),
      ),
    ).toEqual(['Control refs must be unique.']);
  });

  it('bounds controls, text, and select options', () => {
    const controls = Array.from({ length: 101 }, (_, index) => ({
      ...SUBMIT_CONTROL,
      ref: `input-${index}`,
    }));
    expect(
      accepts(
        BrowserAgentObservationSchema,
        observation({
          controls,
          controlCoverage: {
            found: 101,
            returned: 101,
            omittedOverLimit: 0,
            omittedUnsupported: 0,
          },
        }),
      ),
    ).toBe(false);
    expect(
      accepts(
        BrowserAgentObservationSchema,
        observation({
          controls: controls.slice(0, 100),
          controlCoverage: {
            found: 101,
            returned: 100,
            omittedOverLimit: 1,
            omittedUnsupported: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(
      accepts(
        BrowserAgentObservationSchema,
        observation({
          visibleText: {
            text: 'x'.repeat(6_001),
            totalCharacters: 6_001,
            omittedCharacters: 0,
          },
        }),
      ),
    ).toBe(false);
    const option = { label: 'Option', selected: false };
    const select = (ref: string, count: number): Fixture => ({
      ref,
      role: 'select',
      name: 'Choice',
      inViewport: true,
      options: {
        entries: Array.from({ length: count }, () => option),
        total: count,
        omitted: 0,
      },
    });
    const selects = Array.from({ length: 11 }, (_, index) =>
      select(`select-${index}`, 20),
    );
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        observation({
          controls: selects,
          controlCoverage: {
            found: 11,
            returned: 11,
            omittedOverLimit: 0,
            omittedUnsupported: 0,
          },
        }),
      ),
    ).toEqual(['The observation lists too many select options.']);
    expect(
      accepts(
        BrowserAgentObservationSchema,
        observation({
          controls: [select('select-1', 21)],
          controlCoverage: {
            found: 1,
            returned: 1,
            omittedOverLimit: 0,
            omittedUnsupported: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it('never pairs a redacted value with a value or options', () => {
    const withControl = (control: Fixture): Fixture =>
      observation({
        controls: [EMAIL_CONTROL, control, COUNTRY_CONTROL, SUBMIT_CONTROL],
      });
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        withControl({ ...PASSWORD_CONTROL, value: 'hunter2' }),
      ),
    ).toEqual(['A redacted control has no value.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        withControl({
          ...PASSWORD_CONTROL,
          role: 'select',
          options: COUNTRY_CONTROL.options,
        }),
      ),
    ).toEqual(['A redacted select lists no options.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        withControl({
          ...SUBMIT_CONTROL,
          ref: 'input-2',
          options: COUNTRY_CONTROL.options,
        }),
      ),
    ).toEqual(['Only a native select lists options.']);
    expect(
      issueMessages(
        BrowserAgentObservationSchema,
        withControl({
          ...COUNTRY_CONTROL,
          ref: 'input-2',
          options: { entries: [], total: 3, omitted: 2 },
        }),
      ),
    ).toEqual(['Option coverage must account for every option.']);
  });

  it('rejects page internals and credential-bearing URLs', () => {
    const page = fixturePage();
    const withEmail = (email: Fixture): Fixture =>
      observation({
        controls: [email, PASSWORD_CONTROL, COUNTRY_CONTROL, SUBMIT_CONTROL],
      });
    for (const value of [
      observation({ page: { ...page, html: '<html></html>' } }),
      withEmail({ ...EMAIL_CONTROL, bounds: { x: 1, y: 1 } }),
      withEmail({ ...EMAIL_CONTROL, locator: 'text=Email' }),
      withEmail({ ...EMAIL_CONTROL, outerHtml: '<input>' }),
      observation({ screenshotPath: '/tmp/shot.png' }),
    ])
      expect(issueCodes(BrowserAgentObservationSchema, value)).toEqual([
        'unrecognized_keys',
      ]);
    for (const url of ['https://user:secret@shop.example/', 'not a url'])
      expect(
        issueMessages(
          BrowserAgentObservationSchema,
          observation({ page: { ...page, url } }),
        ),
      ).toEqual(['Use a URL without credentials or whitespace.']);
    expect(
      accepts(
        BrowserAgentObservationSchema,
        withEmail({ ...EMAIL_CONTROL, role: 'dialog-host' }),
      ),
    ).toBe(false);
    expect(BROWSER_AGENT_CONTROL_ROLES).toEqual([
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
    ]);
  });
});

describe('read results', () => {
  const page = {
    runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
    document: { documentId: 'doc-7', navigationRevision: 4 },
  };

  it('reads page text in windows with a cursor exactly when text remains', () => {
    const read = (coverage: Fixture): Fixture => ({
      ...page,
      text: 'x'.repeat(100),
      coverage,
      redactedValues: 0,
    });
    expect(
      accepts(
        BrowserAgentTextReadResultSchema,
        read({
          totalCharacters: 300,
          startOffset: 100,
          nextCursor: 'cursor-3',
        }),
      ),
    ).toBe(true);
    expect(
      accepts(
        BrowserAgentTextReadResultSchema,
        read({ totalCharacters: 200, startOffset: 100 }),
      ),
    ).toBe(true);
    expect(
      issueMessages(
        BrowserAgentTextReadResultSchema,
        read({ totalCharacters: 300, startOffset: 100 }),
      ),
    ).toEqual(['A cursor is present exactly when text remains.']);
    expect(
      issueMessages(
        BrowserAgentTextReadResultSchema,
        read({
          totalCharacters: 200,
          startOffset: 100,
          nextCursor: 'cursor-3',
        }),
      ),
    ).toEqual(['A cursor is present exactly when text remains.']);
    expect(
      issueMessages(
        BrowserAgentTextReadResultSchema,
        read({ totalCharacters: 150, startOffset: 100 }),
      ),
    ).toEqual(['The window ends past the page text.']);
  });

  it('pages search matches with explicit coverage', () => {
    const search = (coverage: Fixture): Fixture => ({
      ...page,
      matches: [
        {
          snippet: 'Free cancellation until 1 May',
          offset: 1_200,
          inViewport: false,
        },
      ],
      coverage,
    });
    expect(
      accepts(
        BrowserAgentTextSearchResultSchema,
        search({ totalMatches: 3, startIndex: 1, nextCursor: 'cursor-4' }),
      ),
    ).toBe(true);
    expect(
      issueMessages(
        BrowserAgentTextSearchResultSchema,
        search({ totalMatches: 3, startIndex: 2, nextCursor: 'cursor-4' }),
      ),
    ).toEqual(['A cursor is present exactly when matches remain.']);
    expect(
      issueMessages(
        BrowserAgentTextSearchResultSchema,
        search({ totalMatches: 1, startIndex: 1 }),
      ),
    ).toEqual(['The page ends past the last match.']);
  });

  it('returns screenshot evidence IDs, never host paths', () => {
    const captured = {
      status: 'captured',
      evidenceId: 'shot-2',
      ...page,
      capturedAt: NOW,
      width: 1280,
      height: 800,
      maskedRegions: 1,
    };
    expect(accepts(BrowserAgentScreenshotResultSchema, captured)).toBe(true);
    expect(
      accepts(BrowserAgentScreenshotResultSchema, {
        ...captured,
        path: '/Users/me/Library/shot.png',
      }),
    ).toBe(false);
    expect(
      accepts(BrowserAgentScreenshotResultSchema, {
        ...captured,
        evidenceId: '/tmp/shot.png',
      }),
    ).toBe(false);
    expect(
      accepts(BrowserAgentScreenshotResultSchema, {
        status: 'unavailable',
        reason: 'masking_unavailable',
      }),
    ).toBe(true);
  });

  it('lists only unique task tabs with one active tab', () => {
    const tab = (browserId: string, active: boolean): Fixture => ({
      browserId,
      origin: 'task',
      active,
      url: 'https://example.com/',
      title: 'Example',
    });
    expect(
      accepts(BrowserAgentTabListResultSchema, {
        tabs: [tab(BROWSER_ID, true), tab(TASK_BROWSER_ID, false)],
      }),
    ).toBe(true);
    expect(
      issueMessages(BrowserAgentTabListResultSchema, {
        tabs: [tab(BROWSER_ID, true), tab(TASK_BROWSER_ID, true)],
      }),
    ).toEqual(['Exactly one task tab is active.']);
    expect(
      issueMessages(BrowserAgentTabListResultSchema, {
        tabs: [tab(BROWSER_ID, true), tab(BROWSER_ID, false)],
      }),
    ).toEqual(['Tabs must be unique.']);
    expect(
      accepts(BrowserAgentTabListResultSchema, {
        tabs: Array.from({ length: 9 }, (_, index) =>
          tab(`tab-${index}`, index === 0),
        ),
      }),
    ).toBe(false);
    expect(
      accepts(BrowserAgentWaitResultSchema, {
        outcome: 'timed_out',
        elapsedMs: 30_000,
      }),
    ).toBe(true);
  });
});

describe('action intent and receipt', () => {
  it('records a durable intent against the observation it targets', () => {
    const parsed = BrowserAgentActionIntentSchema.parse(clickIntent());
    expect(parsed.call).toEqual({
      tool: 'click',
      arguments: { target: TARGET },
    });
    expect(jsonRoundTrip(parsed)).toEqual(parsed);
    expect(
      accepts(
        BrowserAgentActionIntentSchema,
        clickIntent({
          call: {
            tool: 'navigate',
            arguments: { url: 'https://example.com/b' },
          },
          subject: { tool: 'navigate', url: 'https://example.com/b' },
        }),
      ),
    ).toBe(true);
  });

  it('keeps the intent, its basis, and its subject consistent', () => {
    expect(
      issueMessages(
        BrowserAgentActionIntentSchema,
        clickIntent({
          subject: {
            tool: 'fill',
            control: { role: 'textbox', name: 'Email' },
          },
        }),
      ),
    ).toEqual(['The subject must describe the recorded call.']);
    expect(
      issueMessages(
        BrowserAgentActionIntentSchema,
        clickIntent({
          call: {
            tool: 'click',
            arguments: { target: { observationId: 'obs-0', ref: 'input-1' } },
          },
        }),
      ),
    ).toEqual(['The basis must be the target observation.']);
    expect(
      issueMessages(
        BrowserAgentActionIntentSchema,
        clickIntent({
          call: { tool: 'press_key', arguments: { key: 'Enter' } },
          subject: { tool: 'press_key', key: 'Escape' },
        }),
      ),
    ).toEqual(['The subject must echo the call.']);
    expect(
      issueMessages(
        BrowserAgentActionIntentSchema,
        clickIntent({
          call: {
            tool: 'handle_dialog',
            arguments: { dialogId: 'dialog-1', response: { kind: 'accept' } },
          },
          subject: { tool: 'handle_dialog', dialogResponse: 'dismiss' },
        }),
      ),
    ).toEqual(['The subject must echo the call.']);
    expect(
      issueMessages(
        BrowserAgentActionIntentSchema,
        clickIntent({
          call: {
            tool: 'close_tab',
            arguments: { browserId: TASK_BROWSER_ID },
          },
          subject: { tool: 'close_tab', browserId: BROWSER_ID },
        }),
      ),
    ).toEqual(['The subject must echo the call.']);
    for (const overrides of [
      { sequence: 0 },
      { sequence: 51 },
      { call: { tool: 'observe', arguments: {} } },
      { call: { tool: 'click', arguments: { target: TARGET }, script: 'x' } },
      { basis: { leaseId: 'lease-1' } },
    ])
      expect([
        overrides,
        accepts(BrowserAgentActionIntentSchema, clickIntent(overrides)),
      ]).toEqual([overrides, false]);
  });

  it('describes each action subject with only its own fields', () => {
    const subjectIssues = (subject: Fixture): string[] =>
      issueMessages(
        BrowserAgentActionReceiptSchema,
        executedReceipt(1, 1, { subject }),
      );
    expect(subjectIssues({ tool: 'click' })).toEqual([
      'control is required here.',
    ]);
    expect(
      subjectIssues({
        tool: 'navigate',
        url: 'https://example.com/',
        control: { role: 'link', name: 'Next' },
      }),
    ).toEqual(['control is not allowed here.']);
    expect(subjectIssues({ tool: 'navigate' })).toEqual([
      'url is required here.',
    ]);
    expect(subjectIssues({ tool: 'press_key' })).toEqual([
      'key is required here.',
    ]);
    expect(subjectIssues({ tool: 'reload', key: 'Enter' })).toEqual([
      'key is not allowed here.',
    ]);
    expect(subjectIssues({ tool: 'switch_tab' })).toEqual([
      'browserId is required here.',
    ]);
    expect(subjectIssues({ tool: 'handle_dialog' })).toEqual([
      'dialogResponse is required here.',
    ]);
    expect(subjectIssues({ tool: 'scroll' })).toEqual([]);
    expect(subjectIssues({ tool: 'observe' })).not.toEqual([]);
  });

  it('records not executed, executed, and unknown outcomes', () => {
    expect(BROWSER_AGENT_NOT_EXECUTED_REASONS).toEqual([
      'stale_observation',
      'target_not_found',
      'target_changed',
      'target_not_actionable',
      'dialog_pending',
      'destination_denied',
      'lease_revoked',
      'epoch_fenced',
      'budget_exhausted',
    ]);
    expect(BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS).toEqual([
      'dispatch_timeout',
      'stopped_after_dispatch',
      'runtime_lost',
      'host_restart',
    ]);
    for (const value of [
      executedReceipt(1, 1),
      notExecutedReceipt(2, 1),
      unknownReceipt(3, 1),
      unknownReceipt(4, 1, { reason: 'host_restart' }),
      executedReceipt(5, 1, {
        subject: { tool: 'open_tab', url: 'https://example.org/' },
        effects: {
          navigation: 'new_document',
          dialogOpened: false,
          openedBrowserId: TASK_BROWSER_ID,
        },
      }),
      notExecutedReceipt(6, 1, {
        reason: 'destination_denied',
        subject: { tool: 'navigate', url: 'http://127.0.0.1:8080/' },
      }),
    ])
      expect(accepts(BrowserAgentActionReceiptSchema, value)).toBe(true);
  });

  it('rejects inconsistent or unknown receipt details', () => {
    expect(
      issueMessages(
        BrowserAgentActionReceiptSchema,
        executedReceipt(1, 1, {
          subject: { tool: 'open_tab', url: 'https://example.org/' },
        }),
      ),
    ).toEqual(['Only an executed open_tab reports its tab.']);
    expect(
      issueMessages(
        BrowserAgentActionReceiptSchema,
        executedReceipt(1, 1, {
          effects: {
            navigation: 'none',
            dialogOpened: false,
            openedBrowserId: TASK_BROWSER_ID,
          },
        }),
      ),
    ).toEqual(['Only an executed open_tab reports its tab.']);
    expect(
      issueMessages(
        BrowserAgentActionReceiptSchema,
        notExecutedReceipt(1, 1, { reason: 'destination_denied' }),
      ),
    ).toEqual(['Only navigate or open_tab is denied a destination.']);
    for (const value of [
      unknownReceipt(1, 1, { reason: 'stale_observation' }),
      notExecutedReceipt(1, 1, { reason: 'dispatch_timeout' }),
      executedReceipt(1, 1, { status: 'retried' }),
      executedReceipt(1, 1, { effects: { navigation: 'none' } }),
      unknownReceipt(1, 1, { note: 'probably worked' }),
      unknownReceipt(1, 1, { version: 2 }),
    ])
      expect(accepts(BrowserAgentActionReceiptSchema, value)).toBe(false);
  });
});

describe('epoch handoff', () => {
  it('seeds the first epoch and later epochs from complete host state', () => {
    expect(accepts(BrowserAgentEpochHandoffSchema, startHandoff())).toBe(true);
    const parsed = BrowserAgentEpochHandoffSchema.parse(navigationHandoff());
    expect(parsed.unknownOutcomes).toHaveLength(1);
    expect(jsonRoundTrip(parsed)).toEqual(parsed);
    expect(
      accepts(BrowserAgentEpochHandoffSchema, {
        ...navigationHandoff(),
        goal: { revision: 2, text: 'g'.repeat(8_000) },
      }),
    ).toBe(true);
  });

  it('ties triggers, digests, and notes to the epoch', () => {
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        startHandoff({ trigger: 'navigation' }),
      ),
    ).toEqual(['Only the first epoch of a run starts it.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({ trigger: 'start' }),
      ),
    ).toEqual(['Only the first epoch of a run starts it.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        without(navigationHandoff(), 'previousHandoffDigest'),
      ),
    ).toEqual(['Every later epoch chains its previous handoff.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        startHandoff({ previousHandoffDigest: DIGEST }),
      ),
    ).toEqual(['Every later epoch chains its previous handoff.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        startHandoff({ notes: { revision: 0, content: PROGRESS_NOTES } }),
      ),
    ).toEqual(['Notes have content exactly after a revision.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({ notes: { revision: 3 } }),
      ),
    ).toEqual(['Notes have content exactly after a revision.']);
  });

  it('accounts for every committed action and never omits unknown outcomes', () => {
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({
          receipts: {
            entries: [executedReceipt(1, 1), notExecutedReceipt(2, 2)],
            omitted: 0,
          },
        }),
      ),
    ).toEqual(['Receipts must account for every committed action.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({ unknownOutcomes: [] }),
      ),
    ).toEqual(['Receipts must account for every committed action.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({
          receipts: {
            entries: [executedReceipt(1, 1), unknownReceipt(2, 2)],
            omitted: 1,
          },
        }),
      ),
    ).toEqual(['List unknown outcomes only in unknownOutcomes.']);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({ unknownOutcomes: [executedReceipt(4, 2)] }),
      ),
    ).not.toEqual([]);
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({
          receipts: {
            entries: [executedReceipt(1, 1), notExecutedReceipt(1, 2)],
            omitted: 1,
          },
        }),
      ),
    ).toEqual(['Each action appears once.']);
  });

  it('accepts receipts only from earlier epochs of the same run', () => {
    for (const unknown of [
      unknownReceipt(4, 3),
      unknownReceipt(4, 2, { epoch: epochIdentity(2, 2) }),
      unknownReceipt(4, 2, { epoch: epochIdentity(2, 1, OTHER_DELEGATION_ID) }),
      unknownReceipt(5, 2),
    ])
      expect(
        issueMessages(
          BrowserAgentEpochHandoffSchema,
          navigationHandoff({ unknownOutcomes: [unknown] }),
        ),
      ).toContain('Receipts come from earlier epochs of this run.');
    expect(
      issueMessages(
        BrowserAgentEpochHandoffSchema,
        navigationHandoff({
          budget: { actionsUsed: 3, inferenceRequestsUsed: 9, activeWorkMs: 1 },
        }),
      ),
    ).toEqual(['Committed actions cannot exceed admitted actions.']);
  });

  it('rejects page snapshots, transcripts, and foreign limits', () => {
    for (const value of [
      navigationHandoff({ observation: observation() }),
      navigationHandoff({ transcript: [] }),
      navigationHandoff({ goal: { revision: 2, text: 'g'.repeat(8_001) } }),
      navigationHandoff({ goal: { revision: 0, text: GOAL } }),
      navigationHandoff({
        authority: {
          leaseId: 'lease-1',
          runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
          policyRevision: 'policy-12',
          launchManifestDigest: NEXT_DIGEST,
          limitsVersion: 3,
        },
      }),
      navigationHandoff({
        authority: {
          leaseId: 'lease-1',
          runtime: { browserId: BROWSER_ID, runtimeGeneration: 3 },
          policyRevision: 'policy-12',
          launchManifestDigest: 'sha256:abc',
          limitsVersion: 2,
        },
      }),
      navigationHandoff({ trigger: 'model_requested' }),
      navigationHandoff({
        budget: { actionsUsed: 51, inferenceRequestsUsed: 9, activeWorkMs: 1 },
      }),
      navigationHandoff({
        budget: { actionsUsed: 4, inferenceRequestsUsed: 101, activeWorkMs: 1 },
      }),
    ])
      expect(accepts(BrowserAgentEpochHandoffSchema, value)).toBe(false);
  });
});

describe('result aggregate', () => {
  it('accepts every settled status with its own fields', () => {
    for (const value of [
      verifiedResult(),
      partialResult(),
      partialResult({
        partialReasons: ['criteria_unmet', 'unverified'],
      }),
      without(
        partialResult({ partialReasons: ['unverified'] }),
        'missingCriteria',
      ),
      blockedResult(),
      resultCommon({
        status: 'failed',
        error: {
          code: 'route_unavailable',
          message: 'The selected model is unavailable.',
          retryable: false,
        },
        progress: PROGRESS_NOTES,
      }),
      cancelledResult(),
      cancelledResult({
        stopReason: 'user_cancelled',
        stoppedBy: { kind: 'user' },
      }),
      without(cancelledResult({ stopReason: 'shutdown' }), 'stoppedBy'),
      resultCommon({
        status: 'deadline_exceeded',
        stopReason: 'deadline_exceeded',
      }),
      userStoppedResult(),
      resultCommon({ status: 'interrupted' }),
    ])
      expect([value, issueMessages(BrowserAgentResultSchema, value)]).toEqual([
        value,
        [],
      ]);
  });

  it('never claims verified completion without proof', () => {
    expect(
      issueMessages(BrowserAgentResultSchema, verifiedResult({ evidence: [] })),
    ).toEqual(['Verified completion cites evidence.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({ missingCriteria: ['A third hotel'] }),
      ),
    ).toEqual(['missingCriteria is not allowed here.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({ partialReasons: ['unverified'] }),
      ),
    ).toEqual(['partialReasons is not allowed here.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(verifiedResult(), 'answer'),
      ),
    ).toEqual(['answer is required here.']);
  });

  it('explains partial and blocked outcomes', () => {
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(without(partialResult(), 'partialReasons'), 'missingCriteria'),
      ),
    ).toEqual(['partialReasons is required here.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(partialResult(), 'missingCriteria'),
      ),
    ).toEqual(['Unmet criteria are listed exactly when reported.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        partialResult({ partialReasons: ['unverified'] }),
      ),
    ).toEqual(['Unmet criteria are listed exactly when reported.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        partialResult({ partialReasons: ['criteria_unmet', 'criteria_unmet'] }),
      ),
    ).toEqual(['Partial reasons must be unique.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(blockedResult(), 'blocked'),
      ),
    ).toEqual(['blocked is required here.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        blockedResult({ answer: 'Done.' }),
      ),
    ).toEqual(['answer is not allowed here.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({ progress: PROGRESS_NOTES }),
      ),
    ).toEqual(['progress is not allowed here.']);
  });

  it('keeps stop reasons, attribution, and errors with their status', () => {
    for (const value of [
      verifiedResult({ stopReason: 'user_cancelled' }),
      verifiedResult({
        error: { code: 'runtime_error', message: 'x', retryable: false },
      }),
      resultCommon({ status: 'failed' }),
      resultCommon({
        status: 'failed',
        stopReason: 'shutdown',
        error: { code: 'runtime_error', message: 'x', retryable: false },
      }),
      resultCommon({
        status: 'failed',
        error: {
          code: 'user_stopped',
          message: 'User stopped',
          retryable: false,
        },
      }),
      resultCommon({
        status: 'failed',
        error: { code: 'apply_failed', message: 'x', retryable: false },
      }),
      cancelledResult({ stopReason: 'user_stopped' }),
      cancelledResult({ stopReason: 'deadline_exceeded' }),
      resultCommon({
        status: 'deadline_exceeded',
        stopReason: 'user_cancelled',
      }),
      resultCommon({ status: 'deadline_exceeded' }),
      resultCommon({ status: 'interrupted', stopReason: 'user_cancelled' }),
      resultCommon({ status: 'running' }),
      resultCommon({ status: 'pending' }),
    ])
      expect([value, accepts(BrowserAgentResultSchema, value)]).toEqual([
        value,
        false,
      ]);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        cancelledResult({ stopReason: 'user_cancelled' }),
      ),
    ).toEqual(['The stop attribution must match its reason.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        cancelledResult({
          stopReason: 'stopped_by_parent',
          stoppedBy: { kind: 'user' },
        }),
      ),
    ).toEqual(['The stop attribution must match its reason.']);
  });

  it('settles a user Stop as interrupted with the "User stopped" error', () => {
    const errorIssue =
      'A user stop, and only a user stop, reports "User stopped".';
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(userStoppedResult(), 'error'),
      ),
    ).toEqual([errorIssue]);
    for (const error of [
      { code: 'user_stopped', message: 'User cancelled', retryable: false },
      { code: 'user_stopped', message: 'User stopped', retryable: true },
      {
        code: 'terminated_by_parent',
        message: 'User stopped',
        retryable: false,
      },
    ])
      expect(
        issueMessages(BrowserAgentResultSchema, userStoppedResult({ error })),
      ).toEqual([errorIssue]);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        resultCommon({
          status: 'interrupted',
          error: {
            code: 'user_stopped',
            message: 'User stopped',
            retryable: false,
          },
        }),
      ),
    ).toEqual([errorIssue]);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        without(userStoppedResult(), 'stoppedBy'),
      ),
    ).toEqual(['A user stop is attributed to the user.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        userStoppedResult({ stoppedBy: { kind: 'agent', depth: 0 } }),
      ),
    ).toEqual(['A user stop is attributed to the user.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        resultCommon({ status: 'interrupted', stoppedBy: { kind: 'user' } }),
      ),
    ).toEqual(['Only a user stop is attributed here.']);
  });

  it('lists every unknown outcome in full, within the action budget', () => {
    const unknowns = Array.from({ length: 50 }, (_, index) =>
      unknownReceipt(index + 1, 1, {
        subject: {
          tool: 'navigate',
          url: `https://example.com/${'p'.repeat(2_000)}?page=${index}`,
        },
      }),
    );
    const complete = userStoppedResult({
      actions: { executed: 0, notExecuted: 0, outcomeUnknown: 50 },
      unknownOutcomes: unknowns,
    });
    expect(issueMessages(BrowserAgentResultSchema, complete)).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThan(160_000);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        userStoppedResult({
          actions: { executed: 0, notExecuted: 0, outcomeUnknown: 50 },
          unknownOutcomes: unknowns.slice(1),
        }),
      ),
    ).toEqual(['List every unknown outcome.']);
    expect(
      accepts(
        BrowserAgentResultSchema,
        userStoppedResult({
          actions: { executed: 0, notExecuted: 0, outcomeUnknown: 51 },
          unknownOutcomes: [
            ...unknowns,
            unknownReceipt(50, 1, { actionId: 'extra' }),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({
          actions: { executed: 30, notExecuted: 21, outcomeUnknown: 0 },
        }),
      ),
    ).toEqual(['Receipts cannot exceed the action budget.']);
  });

  it('rejects foreign, duplicate, or unbounded aggregate entries', () => {
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        userStoppedResult({
          unknownOutcomes: [
            unknownReceipt(4, 2, { epoch: epochIdentity(2, 2) }),
          ],
        }),
      ),
    ).toEqual(['Unknown outcomes belong to this run.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({ evidence: ['obs-9', 'obs-9'] }),
      ),
    ).toEqual(['Evidence must be unique.']);
    expect(
      issueMessages(
        BrowserAgentResultSchema,
        verifiedResult({
          tabs: [
            { browserId: BROWSER_ID, origin: 'existing', open: true },
            { browserId: BROWSER_ID, origin: 'task', open: false },
          ],
        }),
      ),
    ).toEqual(['Tabs must be unique.']);
    for (const value of [
      verifiedResult({
        evidence: Array.from({ length: 21 }, (_, i) => `ev-${i}`),
      }),
      verifiedResult({ answer: 'x'.repeat(4_001) }),
      verifiedResult({ findings: repeated(7, { text: 'y' }) }),
      verifiedResult({
        usage: { inferenceRequests: 101, epochs: 3, activeWorkMs: 1 },
      }),
      verifiedResult({ limitsVersion: 3 }),
      verifiedResult({ transcript: [] }),
      verifiedResult({ delegationId: '../other' }),
    ])
      expect(accepts(BrowserAgentResultSchema, value)).toBe(false);
  });

  it('keeps browser errors and attribution compatible with the generic contract', () => {
    const failed = BrowserAgentResultSchema.parse(
      resultCommon({
        status: 'failed',
        error: {
          code: 'policy_blocked',
          message: 'This profile cannot be used by the browser agent.',
          retryable: false,
        },
      }),
    );
    if (failed.status !== 'failed') throw new Error('expected a failed result');
    const genericError: AgentDelegationError = failed.error;
    expect(genericError.code).toBe('policy_blocked');
    const cancelled = BrowserAgentResultSchema.parse(cancelledResult());
    if (cancelled.status !== 'cancelled' || cancelled.stoppedBy === undefined)
      throw new Error('expected an attributed cancellation');
    const attribution: DelegationStoppedBy = cancelled.stoppedBy;
    expect(attribution).toEqual({ kind: 'agent', depth: 0 });
    expect(BROWSER_AGENT_RESULT_ERROR_CODES).toEqual([
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
    ]);
  });
});

describe('user Stop contract', () => {
  function settledStatusListed(status: DelegateSettledStatus): boolean {
    switch (status) {
      case 'completed':
      case 'failed':
      case 'cancelled':
      case 'deadline_exceeded':
      case 'interrupted':
        return BROWSER_AGENT_RESULT_STATUSES.includes(status);
    }
  }

  function resultStatus(
    status: DelegateSettledStatus,
  ): BrowserAgentResultStatus {
    return status;
  }

  it('adds user_stopped without changing the generic stop reasons', () => {
    expect(DELEGATION_STOP_REASONS).toEqual([
      'parent_cancelled',
      'user_cancelled',
      'deadline_exceeded',
      'shutdown',
      'policy_revoked',
      'stopped_by_parent',
      'ancestor_stopped',
    ]);
    expect(isDelegationStopReason('user_stopped')).toBe(false);
    expect(BROWSER_AGENT_STOP_REASONS).toEqual([
      'parent_cancelled',
      'user_cancelled',
      'deadline_exceeded',
      'shutdown',
      'policy_revoked',
      'stopped_by_parent',
      'ancestor_stopped',
      'user_stopped',
    ]);
    expect(Object.isFrozen(BROWSER_AGENT_STOP_REASONS)).toBe(true);
    for (const reason of BROWSER_AGENT_STOP_REASONS)
      expect(isBrowserAgentStopReason(reason)).toBe(true);
    for (const value of ['crashed', 'USER_STOPPED', '', undefined, null])
      expect(isBrowserAgentStopReason(value)).toBe(false);
  });

  it('maps every stop reason to exactly one settled status', () => {
    expect(BROWSER_AGENT_CANCELLED_STOP_REASONS).toEqual([
      'parent_cancelled',
      'user_cancelled',
      'shutdown',
      'policy_revoked',
      'stopped_by_parent',
      'ancestor_stopped',
    ]);
    expect(
      [
        ...BROWSER_AGENT_CANCELLED_STOP_REASONS,
        'deadline_exceeded',
        'user_stopped',
      ].sort(),
    ).toEqual([...BROWSER_AGENT_STOP_REASONS].sort());
    expect(BROWSER_AGENT_RESULT_STATUSES).toEqual([
      'completed',
      'failed',
      'cancelled',
      'deadline_exceeded',
      'interrupted',
    ]);
    for (const status of BROWSER_AGENT_RESULT_STATUSES) {
      expect(settledStatusListed(status)).toBe(true);
      expect(resultStatus(status)).toBe(status);
    }
  });

  it('pins the locked Stop result, attribution, and parent notice', () => {
    expect(BROWSER_AGENT_USER_STOP).toEqual({
      status: 'interrupted',
      stopReason: 'user_stopped',
      stoppedBy: { kind: 'user' },
      error: {
        code: 'user_stopped',
        message: 'User stopped',
        retryable: false,
      },
      parentNotice: 'User stopped the browser agent',
    });
    expect(Object.isFrozen(BROWSER_AGENT_USER_STOP)).toBe(true);
    expect(Object.isFrozen(BROWSER_AGENT_USER_STOP.error)).toBe(true);
    expect(Object.isFrozen(BROWSER_AGENT_USER_STOP.stoppedBy)).toBe(true);
    const parsed = BrowserAgentResultSchema.parse(userStoppedResult());
    expect(parsed).toMatchObject({
      status: BROWSER_AGENT_USER_STOP.status,
      stopReason: BROWSER_AGENT_USER_STOP.stopReason,
      stoppedBy: BROWSER_AGENT_USER_STOP.stoppedBy,
      error: BROWSER_AGENT_USER_STOP.error,
    });
  });
});

describe('reduced parent browser actions', () => {
  const RETAINED = [
    'browser.list',
    'browser.open',
    'browser.navigate',
    'browser.back',
    'browser.forward',
    'browser.reload',
    'browser.stop',
    'browser.screenshot',
    'browser.save_pdf',
  ];
  const REMOVED = [
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
  ];
  const UNCHANGED = [
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
  ];

  it('matches the locked retained, removed, and unchanged lists exactly', () => {
    expect(BROWSER_AGENT_PARENT_RETAINED_ACTIONS).toEqual(RETAINED);
    expect(BROWSER_AGENT_PARENT_REMOVED_ACTIONS).toEqual(REMOVED);
    expect(BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS).toEqual(UNCHANGED);
    for (const list of [
      BROWSER_AGENT_PARENT_RETAINED_ACTIONS,
      BROWSER_AGENT_PARENT_REMOVED_ACTIONS,
      BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS,
    ])
      expect(Object.isFrozen(list)).toBe(true);
  });

  it('classifies each parent browser action exactly once', () => {
    const all = [
      ...BROWSER_AGENT_PARENT_RETAINED_ACTIONS,
      ...BROWSER_AGENT_PARENT_REMOVED_ACTIONS,
      ...BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS,
    ];
    expect([
      BROWSER_AGENT_PARENT_RETAINED_ACTIONS.length,
      BROWSER_AGENT_PARENT_REMOVED_ACTIONS.length,
      BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS.length,
    ]).toEqual([9, 22, 11]);
    expect(new Set(all).size).toBe(42);
    expect(all.every((action) => action.startsWith('browser.'))).toBe(true);
    expect(
      BROWSER_AGENT_PARENT_UNCHANGED_ACTIONS.filter((action) =>
        action.startsWith('browser.profile.'),
      ),
    ).toHaveLength(7);
    const specialist: readonly string[] = BROWSER_AGENT_TOOL_NAMES;
    expect(all.filter((action) => specialist.includes(action))).toEqual([]);
  });
});

describe('portable module boundary', () => {
  it('exports only closed, bounded, JSON-Schema-representable schemas', () => {
    const schemas: [string, z.ZodType][] = [];
    for (const [name, value] of Object.entries(contract))
      if (value instanceof z.ZodType) schemas.push([name, value]);
    expect(schemas.map(([name]) => name).sort()).toEqual([
      'BrowserAgentActionCallSchema',
      'BrowserAgentActionIntentSchema',
      'BrowserAgentActionReceiptSchema',
      'BrowserAgentActionSubjectSchema',
      'BrowserAgentControlSchema',
      'BrowserAgentDigestSchema',
      'BrowserAgentDocumentIdentitySchema',
      'BrowserAgentElementTargetSchema',
      'BrowserAgentEpochHandoffSchema',
      'BrowserAgentEpochIdentitySchema',
      'BrowserAgentGoalSchema',
      'BrowserAgentHttpUrlSchema',
      'BrowserAgentIdSchema',
      'BrowserAgentInteractionIdentitySchema',
      'BrowserAgentObservationSchema',
      'BrowserAgentProgressNotesSchema',
      'BrowserAgentResultSchema',
      'BrowserAgentRuntimeIdentitySchema',
      'BrowserAgentScreenshotResultSchema',
      'BrowserAgentStartRequestSchema',
      'BrowserAgentTabListResultSchema',
      'BrowserAgentTextReadResultSchema',
      'BrowserAgentTextSearchResultSchema',
      'BrowserAgentToolCallSchema',
      'BrowserAgentUnknownOutcomeReceiptSchema',
      'BrowserAgentWaitResultSchema',
    ]);
    for (const [name, schema] of schemas)
      expect([
        name,
        openOrUnboundedNodes(z.toJSONSchema(schema), name),
      ]).toEqual([name, []]);
  });

  it('imports only Zod and sibling delegation contracts', () => {
    const source = readFileSync(
      join(__dirname, '..', 'browser-agent.ts'),
      'utf8',
    );
    const specifiers = Array.from(
      source.matchAll(/from '([^']+)'/g),
      (match) => match[1],
    );
    expect(specifiers.sort()).toEqual(['./discovery', './index', 'zod']);
    expect(source).not.toMatch(
      /\brequire\(|['"]node:|\bprocess\.|\belectron\b/,
    );
  });
});
