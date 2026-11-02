import Ajv from 'ajv';
import { z } from 'zod/v4';
import {
  browserActionCorpus,
  pointerViewportCorpus,
  browserActionDecisionTable,
} from '@canopy/agent-actions/families/browser/__tests__/browser-action-corpus';
import { parseAdvisorBrowserAction } from '@canopy/agent-actions/families/browser/schemas';
import { dispatchActionJsonSchema as mcpJsonSchema } from '../canopy-tools/definitions';
import {
  browserActionInputSchema,
  browserActionSchema,
  createDispatchActionInputSchema,
  findBrowserUiOnlyField,
} from '@canopy/agent-actions';
import {
  appAdvisorActionSchema,
  dispatchActionJsonSchema as advisorJsonSchema,
  dispatchActionToolSchema,
} from '../app-advisor/definitions';

// The MCP route: DispatchAction input for the shared browser family.
const mcpDispatchSchema = createDispatchActionInputSchema(browserActionSchema, {
  findUiOnlyField: findBrowserUiOnlyField,
});
// Its validator before the command projection.
const mcpInnerSchema = browserActionInputSchema;

function recordParse(result: z.ZodSafeParseResult<unknown>): unknown {
  return result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        issues: result.error.issues.map(({ code, path, message }) => ({
          code,
          path,
          message,
        })),
      };
}

function installedBrowserDiscriminants(schema: unknown): string[] {
  if (schema instanceof z.ZodPipe)
    return installedBrowserDiscriminants(schema.in);
  if (schema instanceof z.ZodUnion)
    return schema.options.flatMap(installedBrowserDiscriminants);
  if (schema instanceof z.ZodObject) {
    const discriminant: unknown = schema.shape.type;
    if (discriminant instanceof z.ZodLiteral)
      return Array.from(discriminant.values).filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('browser.'),
      );
  }
  return [];
}

const transferActions = [
  {
    id: 'valid-list-transfers',
    action: { type: 'browser.list_transfers', expectedRuntimeGeneration: 1 },
  },
  {
    id: 'valid-cancel-transfer',
    action: {
      type: 'browser.cancel_transfer',
      expectedRuntimeGeneration: 1,
      transferId: 'download-1',
    },
  },
  {
    id: 'valid-list-uploads',
    action: {
      type: 'browser.list_transfers',
      expectedRuntimeGeneration: 1,
      kind: 'upload',
    },
  },
  {
    id: 'valid-upload-files',
    action: {
      type: 'browser.upload_files',
      expectedRuntimeGeneration: 1,
      ref: 'r-1',
      files: [{ path: 'exports/report.csv' }, { downloadId: 'download-1' }],
    },
  },
  {
    id: 'valid-upload-files-chooser',
    action: {
      type: 'browser.upload_files',
      expectedRuntimeGeneration: 1,
      chooserId: 'chooser-1',
      files: [{ path: 'exports/report.csv' }],
    },
  },
  {
    id: 'valid-request-files',
    action: {
      type: 'browser.request_files',
      expectedRuntimeGeneration: 1,
      locator: '#resume',
      purpose: 'Your résumé',
    },
  },
  {
    id: 'valid-drop-files',
    action: {
      type: 'browser.drop_files',
      expectedRuntimeGeneration: 1,
      locator: '#zone',
      files: [{ attachmentId: 'report.csv' }],
    },
  },
  {
    id: 'valid-save-download',
    action: {
      type: 'browser.save_download',
      expectedRuntimeGeneration: 1,
      downloadId: 'download-1',
      path: 'exports/report.csv',
      overwrite: true,
    },
  },
  {
    id: 'valid-save-pdf',
    action: {
      type: 'browser.save_pdf',
      expectedRuntimeGeneration: 1,
      fileName: 'invoice',
      landscape: true,
      paperFormat: 'a4',
      pageRanges: '1-2',
    },
  },
];

const browserTypes = [
  'browser.profile.preview_clear',
  'browser.profile.clear',
  'browser.profile.job_get',
  'browser.profile.job_cancel',
  'browser.profile.list',
  'browser.profile.get',
  'browser.profile.switch',
  'browser.list',
  'browser.open',
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
];

// These are the same host policies supplied by main and the renderer. The
// shared entry point owns browser rules, not the host's project-id policy.
const safeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const advisorScopeShape = {
  expectedRuntimeGeneration: z.number().int().positive().optional(),
  projectId: safeIdSchema
    .refine((projectId) => projectId !== 'app-advisor')
    .optional(),
  worktreeId: safeIdSchema.optional(),
};

if (
  mcpJsonSchema === null ||
  typeof mcpJsonSchema !== 'object' ||
  Array.isArray(mcpJsonSchema)
)
  throw new Error('Expected MCP JSON Schema object');
if (
  advisorJsonSchema === null ||
  typeof advisorJsonSchema !== 'object' ||
  Array.isArray(advisorJsonSchema)
)
  throw new Error('Expected Advisor JSON Schema object');
const ajv = new Ajv({ strict: false });
const validateMcp = ajv.compile(mcpJsonSchema);
const validateAdvisor = ajv.compile(advisorJsonSchema);

describe('pre-refactor browser action baselines', () => {
  it.each(browserActionDecisionTable)(
    'matches the public decision table for $id on both main routes and the renderer entry point',
    ({ action, after }) => {
      expect(mcpDispatchSchema.safeParse({ action }).success).toBe(after.mcp);
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(
        after.advisor,
      );
      const parsed = parseAdvisorBrowserAction(action, advisorScopeShape);
      expect(parsed.ok).toBe(after.advisor);
      if (parsed.ok) {
        expect(appAdvisorActionSchema.parse(action)).toEqual(parsed.action);
      }
    },
  );

  it('pins the installed MCP and Advisor browser members and their order', () => {
    expect(installedBrowserDiscriminants(mcpInnerSchema)).toEqual(browserTypes);
    expect(installedBrowserDiscriminants(appAdvisorActionSchema)).toEqual(
      browserTypes,
    );
    for (const type of browserTypes) {
      expect(
        [
          ...browserActionCorpus,
          ...pointerViewportCorpus,
          ...transferActions,
        ].some(
          ({ id, action }) =>
            (id.startsWith('valid-') || id.startsWith('phase06-valid-')) &&
            action.type === type,
        ),
      ).toBe(true);
    }
  });

  it('pins parsed outputs and ordered issues for inner, outer, and Advisor validators', () => {
    const observations = browserActionCorpus.map(({ id, action }) => ({
      id,
      mcpInner: recordParse(mcpInnerSchema.safeParse(action)),
      mcpOuter: recordParse(mcpDispatchSchema.safeParse({ action })),
      advisor: recordParse(appAdvisorActionSchema.safeParse(action)),
    }));
    for (const observation of observations.filter(
      ({ id }) => id.startsWith('valid-') || id.startsWith('phase06-valid-'),
    )) {
      expect(observation.mcpInner).toMatchObject({ success: true });
      expect(observation.mcpOuter).toMatchObject({ success: true });
      expect(observation.advisor).toMatchObject({ success: true });
    }
    expect(observations).toMatchSnapshot();
  });

  it('pins the Advisor advertised JSON Schema surfaces byte for byte', () => {
    // The complete MCP surface is pinned through actual provider registration
    // in agent-actions/__tests__/tool-surface-golden.test.ts. Keep the distinct
    // Advisor hand-authored and SDK-converted surfaces here.
    expect(JSON.stringify(advisorJsonSchema, null, 2)).toMatchSnapshot(
      'Advisor dispatchActionJsonSchema',
    );
    // The SDK registers dispatchActionToolSchema.shape and converts Zod v4
    // inputs as draft-7. Its converter cannot represent custom schemas either;
    // use `any` there so the rest of the installed input shape stays pinned.
    const sdkInputSchema = z.toJSONSchema(
      z.object(dispatchActionToolSchema.shape),
      { target: 'draft-7', io: 'input', unrepresentable: 'any' },
    );
    expect(JSON.stringify(sdkInputSchema, null, 2)).toMatchSnapshot(
      'Advisor SDK-style input schema',
    );
  });

  it.each([
    {
      type: 'browser.set_checked',
      expectedRuntimeGeneration: 9,
      locator: '#terms',
      checked: true,
      actionId: 'checked',
      timeoutMs: 2_345,
    },
    {
      type: 'browser.select_option',
      expectedRuntimeGeneration: 9,
      locator: '#country',
      values: ['ca'],
      searchText: 'Canada',
      actionId: 'choice',
      timeoutMs: 3_456,
    },
    {
      type: 'browser.type',
      expectedRuntimeGeneration: 9,
      locator: '#search',
      text: 'query',
      delayMs: 37,
      actionId: 'type',
      timeoutMs: 4_567,
    },
  ])(
    'carries $type command fields unchanged on MCP and Advisor schemas',
    (action) => {
      const mcp = mcpDispatchSchema.safeParse({ action });
      const advisor = appAdvisorActionSchema.safeParse(action);
      expect(validateMcp({ action })).toBe(true);
      expect(validateAdvisor({ action })).toBe(true);
      expect(mcp.success).toBe(true);
      expect(advisor.success).toBe(true);
      if (mcp.success) expect(mcp.data.action).toMatchObject(action);
      if (advisor.success) expect(advisor.data).toMatchObject(action);
    },
  );

  it.each(
    browserActionDecisionTable.filter(
      ({ action }) =>
        action.type === 'browser.set_checked' ||
        action.type === 'browser.select_option' ||
        action.type === 'browser.type',
    ),
  )(
    'advertised JSON Schema follows the D1 decision for $id',
    ({ action, after }) => {
      expect(validateMcp({ action })).toBe(after.mcp);
      expect(validateAdvisor({ action })).toBe(after.advisor);
    },
  );

  it('advertises the new browser command properties in MCP JSON Schema', () => {
    expect(mcpJsonSchema).toMatchObject({
      properties: {
        action: {
          properties: {
            checked: { type: 'boolean' },
            values: { type: 'array' },
            labels: { type: 'array' },
            indexes: { type: 'array' },
            searchText: { type: 'string' },
            delayMs: { type: 'integer' },
          },
        },
      },
    });
  });
});

describe('frame scope on installed browser routes', () => {
  const targets = ['click', 'fill', 'press', 'focus', 'inspect'];
  const parseRoutes = (
    action: Record<string, unknown>,
  ): Array<
    | ReturnType<typeof mcpInnerSchema.safeParse>
    | ReturnType<typeof mcpDispatchSchema.safeParse>
    | ReturnType<typeof appAdvisorActionSchema.safeParse>
  > => {
    const results = [
      mcpInnerSchema.safeParse(action),
      mcpDispatchSchema.safeParse({ action }),
      appAdvisorActionSchema.safeParse(action),
    ];
    expect(validateMcp({ action })).toBe(results[1]?.success);
    expect(validateAdvisor({ action })).toBe(results[2]?.success);
    return results;
  };

  it.each(targets)('preserves frame with a locator on browser.%s', (kind) => {
    const action = {
      type: `browser.${kind}`,
      expectedRuntimeGeneration: 1,
      locator: '#save',
      frame: '  iframe.checkout  ',
      text: '',
      key: 'Enter',
    };
    for (const result of parseRoutes(action)) {
      expect(result.success).toBe(true);
      if (result.success)
        expect(result.data).toMatchObject(
          'action' in result.data
            ? { action: { frame: action.frame } }
            : { frame: action.frame },
        );
    }
    expect(parseAdvisorBrowserAction(action, advisorScopeShape)).toMatchObject({
      ok: true,
      action: { frame: action.frame },
    });
  });

  it.each(targets)('rejects frame without a locator on browser.%s', (kind) => {
    for (const target of [{ ref: 'r-frame-1' }, { x: 1, y: 2 }, {}]) {
      const action = {
        type: `browser.${kind}`,
        expectedRuntimeGeneration: 1,
        frame: 'f-checkout-1',
        text: '',
        key: 'Enter',
        ...target,
      };
      for (const result of parseRoutes(action)) {
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues.map((issue) => issue.message)).toContain(
            `browser.${kind} frame applies only to locators; a ref already identifies its frame.`,
          );
      }
      expect(parseAdvisorBrowserAction(action, advisorScopeShape).ok).toBe(
        false,
      );
    }
  });

  it.each([{ locator: '#ready' }, { text: 'Ready' }])(
    'preserves frame for wait condition %j',
    (condition) => {
      const action = {
        type: 'browser.wait_for',
        expectedRuntimeGeneration: 1,
        frame: 'f-checkout-1',
        ...condition,
      };
      for (const result of parseRoutes(action)) {
        expect(result.success).toBe(true);
        if (result.success)
          expect(result.data).toMatchObject(
            'action' in result.data
              ? { action: { frame: action.frame } }
              : { frame: action.frame },
          );
      }
    },
  );

  it.each([{ url: '/ready' }, { loadState: 'load' }, {}])(
    'rejects frame for wait condition %j',
    (condition) => {
      const action = {
        type: 'browser.wait_for',
        expectedRuntimeGeneration: 1,
        frame: 'f-checkout-1',
        ...condition,
      };
      for (const result of parseRoutes(action)) {
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues.map((issue) => issue.message)).toContain(
            'browser.wait_for frame requires locator or text and cannot be combined with url or loadState.',
          );
      }
    },
  );

  it('preserves the snapshot frame filter', () => {
    const action = {
      type: 'browser.input_snapshot',
      expectedRuntimeGeneration: 1,
      frame: 'f-checkout-1',
      role: 'textbox',
    };
    for (const result of parseRoutes(action)) {
      expect(result.success).toBe(true);
      if (result.success)
        expect(result.data).toMatchObject(
          'action' in result.data
            ? { action: { frame: action.frame } }
            : { frame: action.frame },
        );
    }
  });

  it.each([
    'click',
    'fill',
    'press',
    'focus',
    'inspect',
    'wait_for',
    'input_snapshot',
  ])('rejects empty frame on browser.%s', (kind) => {
    for (const frame of ['', '  ', 42]) {
      const action = {
        type: `browser.${kind}`,
        expectedRuntimeGeneration: 1,
        locator: '#ready',
        frame,
        ...(kind === 'fill' ? { text: '' } : {}),
        key: 'Enter',
      };
      for (const result of parseRoutes(action))
        expect(result.success).toBe(false);
    }
  });
});

it('advertises the frame field on MCP DispatchAction', () => {
  expect(mcpJsonSchema).toMatchObject({
    properties: {
      action: {
        properties: {
          frame: { type: 'string', minLength: 1, pattern: '\\S' },
        },
      },
    },
  });
});

describe('legacy unsupported coordinate stripping', () => {
  it.each(['fill', 'press', 'focus'])(
    'strips stray x/y on browser.%s with or without frame',
    (kind) => {
      const payload = {
        type: `browser.${kind}`,
        expectedRuntimeGeneration: 1,
        locator: '#ready',
        x: 1,
        y: 2,
        ...(kind === 'fill' ? { text: '' } : {}),
        ...(kind === 'press' ? { key: 'Enter' } : {}),
      };
      for (const action of [payload, { ...payload, frame: 'f-checkout-1' }]) {
        const mcp = mcpDispatchSchema.safeParse({ action });
        const advisor = appAdvisorActionSchema.safeParse(action);
        expect(mcp.success).toBe(true);
        expect(advisor.success).toBe(true);
        if (mcp.success) {
          expect(mcp.data.action).not.toHaveProperty('x');
          expect(mcp.data.action).not.toHaveProperty('y');
        }
        if (advisor.success) {
          expect(advisor.data).not.toHaveProperty('x');
          expect(advisor.data).not.toHaveProperty('y');
        }
      }
    },
  );
});

describe('frame corpus JSON and Zod agreement', () => {
  it.each(
    browserActionDecisionTable.filter(({ id }) => id.startsWith('frame-')),
  )('agrees for $id', ({ action, after }) => {
    expect(validateMcp({ action })).toBe(after.mcp);
    expect(mcpDispatchSchema.safeParse({ action }).success).toBe(after.mcp);
    expect(validateAdvisor({ action })).toBe(after.advisor);
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(
      after.advisor,
    );
  });
});

describe('pointer and viewport JSON and Zod agreement', () => {
  it.each(pointerViewportCorpus)('agrees for $id', ({ action, accepted }) => {
    expect(mcpDispatchSchema.safeParse({ action }).success).toBe(accepted);
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(accepted);
    expect(validateMcp({ action })).toBe(accepted);
    expect(validateAdvisor({ action })).toBe(accepted);
  });
});

it.each([
  { type: 'browser.hover', ref: 'r' },
  { type: 'browser.scroll', direction: 'down' },
  { type: 'browser.drag', from: { ref: 'r' }, to: { dx: -1, dy: 0 } },
])(
  'preserves trusted scope removal and Advisor scope/generation guards for $type',
  (fields) => {
    for (const supplied of [
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      { projectId: 'project-1' },
      { projectId: 42, worktreeId: false },
    ]) {
      const action = { ...fields, expectedRuntimeGeneration: 1, ...supplied };
      const advisorAccepts =
        typeof supplied.projectId === 'string' && 'worktreeId' in supplied;
      expect(mcpDispatchSchema.safeParse({ action }).success).toBe(true);
      // The flat JSON advertises projectId as the projects family's string
      // target, so only a malformed one fails there; the route still strips it.
      expect(validateMcp({ action })).toBe(
        typeof supplied.projectId === 'string',
      );
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(
        advisorAccepts,
      );
      expect(validateAdvisor({ action })).toBe(advisorAccepts);
    }
    expect(mcpDispatchSchema.safeParse({ action: fields }).success).toBe(true);
    expect(validateMcp({ action: fields })).toBe(true);
    expect(appAdvisorActionSchema.safeParse(fields).success).toBe(false);
    expect(validateAdvisor({ action: fields })).toBe(false);
  },
);

describe('phase07 advertised transfer contracts', () => {
  it.each(transferActions)(
    'accepts $id on every advertised and runtime route',
    ({ action }) => {
      expect(mcpDispatchSchema.safeParse({ action }).success).toBe(true);
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
      expect(parseAdvisorBrowserAction(action, advisorScopeShape).ok).toBe(
        true,
      );
      expect(validateMcp({ action })).toBe(true);
      expect(validateAdvisor({ action })).toBe(true);
    },
  );
  it.each([
    { type: 'browser.list_transfers', kind: 'other' },
    { type: 'browser.upload_files', ref: 'r-1', files: [] },
    {
      type: 'browser.upload_files',
      files: [{ path: 'report.csv' }],
    },
    {
      type: 'browser.upload_files',
      ref: 'r-1',
      files: [{ path: 'report.csv', downloadId: 'download-1' }],
    },
    { type: 'browser.list_transfers', status: 'unknown' },
    { type: 'browser.list_transfers', offset: -1 },
    { type: 'browser.list_transfers', limit: 101 },
    { type: 'browser.cancel_transfer' },
    { type: 'browser.cancel_transfer', transferId: '  ' },
    { type: 'browser.save_download', downloadId: 'download-1' },
    { type: 'browser.save_download', path: 'report.csv' },
    {
      type: 'browser.save_download',
      downloadId: 'download-1',
      path: 'report.csv',
      timeoutMs: 120001,
    },
  ])('rejects %j on advertised and runtime routes', (fields) => {
    const action = { ...fields, expectedRuntimeGeneration: 1 };
    expect(mcpDispatchSchema.safeParse({ action }).success).toBe(false);
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    expect(validateMcp({ action })).toBe(false);
    expect(validateAdvisor({ action })).toBe(false);
  });
});

describe('phase07 download wait contracts', () => {
  it.each([{}, { downloadId: 'download-1' }])(
    'preserves download condition %j on both routes',
    (download) => {
      const action = {
        type: 'browser.wait_for',
        expectedRuntimeGeneration: 1,
        download,
        timeoutMs: 120000,
        actionId: 'wait-download',
      };
      const mcp = mcpDispatchSchema.safeParse({ action });
      const advisor = appAdvisorActionSchema.safeParse(action);
      expect(mcp.success).toBe(true);
      expect(advisor.success).toBe(true);
      if (mcp.success) expect(mcp.data.action).toEqual(action);
      if (advisor.success) expect(advisor.data).toEqual(action);
      expect(validateMcp({ action })).toBe(true);
      expect(validateAdvisor({ action })).toBe(true);
    },
  );
  it.each([
    { download: null },
    { download: [] },
    { download: 'download-1' },
    { download: { downloadId: '' } },
    { download: { downloadId: '  ' } },
    { download: { downloadId: 42 } },
    { download: { extra: true } },
    { download: {}, locator: '#ready' },
    { download: {}, text: 'Ready' },
    { download: {}, url: '/ready' },
    { download: {}, loadState: 'load' },
    { download: {}, state: 'visible' },
    { download: {}, frame: 'frame-1' },
    { download: {}, frame: 'frame-1', locator: '#ready' },
  ])('rejects invalid download wait %j on both routes', (fields) => {
    const action = {
      type: 'browser.wait_for',
      expectedRuntimeGeneration: 1,
      ...fields,
    };
    expect(mcpDispatchSchema.safeParse({ action }).success).toBe(false);
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    expect(validateMcp({ action })).toBe(false);
    expect(validateAdvisor({ action })).toBe(false);
  });
});
