import { BOT_ACTION_TYPES } from '@canopy/agent-actions';
import {
  browserActionSchema,
  createDispatchActionInputSchema,
  findBrowserUiOnlyField,
} from '@canopy/agent-actions';
import {
  buildCanopyDynamicToolSpecs,
  handleCanopyDynamicToolCall,
} from '../codex/canopy-dynamic-tools';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type * as CanopyDynamicToolsModule from '../codex/canopy-dynamic-tools';
import {
  dispatchActionJsonSchema,
  dispatchActionSchema,
} from '../canopy-tools/definitions';
import * as injectedToolCore from '../canopy-tools/core';
import {
  botActionSchema,
  type BotAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../project-discovery';

type BotServiceResponse = Omit<AppAdvisorActionResponse, 'requestId'>;
const mockIsBotAccessAllowed = jest.fn<
  Promise<boolean>,
  [ProjectDiscoveryCaller]
>();
const mockDispatchBotAction = jest.fn<
  Promise<BotServiceResponse>,
  [BotAction, ProjectDiscoveryCaller]
>();
jest.mock('../project-discovery/bots', (): object => ({
  isBotAccessAllowed: mockIsBotAccessAllowed,
  dispatchBotAction: mockDispatchBotAction,
}));

// The MCP route for browser actions: the shared browser family's input.
const browserDispatchSchema = createDispatchActionInputSchema(
  browserActionSchema,
  { findUiOnlyField: findBrowserUiOnlyField },
);

const testBrand = {
  schemaVersion: 5,
  id: 'testbrand',
  displayName: 'TestBrand',
  shortName: 'TestBrand',
  internalName: 'testbrand',
  cliName: 'testbrand',
  appId: 'com.testbrand.ui',
  description: 'TestBrand',
  author: 'TestBrand',
  serverDisplayName: 'TestBrand Server',
  storage: {
    dataDirNames: {
      prod: ['.testbrand', '.canopy'],
      rc: ['.testbrand-rc', '.canopy-rc'],
      dev: ['.testbrand-dev', '.canopy-dev'],
    },
    secureDataDirNames: {
      prod: '.testbrand-secure',
      rc: '.testbrand-rc-secure',
      internal: '.testbrand-internal-secure',
      dev: '.testbrand-secure-dev',
    },
    configFileNames: ['testbrand.json', 'canopy.json'],
    projectConfigDirNames: ['.testbrand', '.canopy'],
  },
  environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
  tools: { namespace: 'testbrand' },
  desktopIntegration: {
    routePrefix: '/testbrand',
    tokenHeaderName: 'X-TestBrand-Integration-Token',
    tokenEnvVar: 'TESTBRAND_DESKTOP_INTEGRATION_TOKEN',
  },
  dictation: {
    binaryName: 'testbrand-dictate',
    bundleId: 'com.testbrand.dictate',
    displayName: 'TestBrand Dictate',
  },
  web: {
    hostnames: ['testbrand.localhost'],
    apiNamespace: 'testbrand',
    wellKnownNamespace: 'testbrand',
    title: 'TestBrand',
    description: 'TestBrand',
  },
  release: { enabled: [], artifactPrefix: 'testbrand' },
  assets: {
    logoSvg: '<svg />',
    logoSvgPath: '/tmp/logo.svg',
    appIconPng: '/tmp/app-icon.png',
    macIconIcns: '/tmp/icon.icns',
    windowsIconIco: '/tmp/icon.ico',
    linuxIconDir: '/tmp/icons',
    webIconPng: '/tmp/web-icon.png',
  },
};

afterEach(() => {
  jest.dontMock('@canopy/brand/current');
  jest.resetModules();
});

beforeEach(() => {
  mockIsBotAccessAllowed.mockReset();
  mockDispatchBotAction.mockReset();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSchemaProperty(
  schema: unknown,
  propertyName: string,
): Record<string, unknown> | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return undefined;
  }
  const property = schema.properties[propertyName];
  return isRecord(property) ? property : undefined;
}

function getStringArrayProperty(
  schema: unknown,
  propertyName: string,
): string[] {
  if (!isRecord(schema)) {
    return [];
  }
  const value = schema[propertyName];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

describe('canopy dynamic tools', () => {
  it('advertises independent SearchWatchers instance paging and target filters', () => {
    const tool = buildCanopyDynamicToolSpecs({}).find(
      (entry) => entry.name === 'canopy_search_watchers',
    );
    expect(
      getSchemaProperty(tool?.inputSchema, 'activePageSize'),
    ).toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 50 });
    expect(getSchemaProperty(tool?.inputSchema, 'activeCursor')).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
    expect(getSchemaProperty(tool?.inputSchema, 'activeQuery')).toMatchObject({
      type: 'string',
      maxLength: 500,
    });
    for (const key of [
      'targetProjectId',
      'targetBotId',
      'targetTaskId',
      'targetChatId',
    ]) {
      expect(getSchemaProperty(tool?.inputSchema, key)).toMatchObject({
        type: 'string',
        minLength: 1,
      });
    }
    expect(getSchemaProperty(tool?.inputSchema, 'limit')).toMatchObject({
      minimum: 1,
      maximum: 50,
    });
  });

  it('accepts pipeline retry actions', () => {
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'pipeline.execution_retry',
          executionId: 'execution-1',
        },
      }).success,
    ).toBe(true);
  });

  it('requires explicit browser element targets and accepts input snapshots', () => {
    expect(
      browserDispatchSchema.safeParse({
        action: { type: 'browser.inspect' },
      }).success,
    ).toBe(false);
    expect(
      browserDispatchSchema.safeParse({
        action: { type: 'browser.click', x: 10 },
      }).success,
    ).toBe(false);
    expect(
      browserDispatchSchema.safeParse({
        action: { type: 'browser.fill', ref: 'input-1', text: 'query' },
      }).success,
    ).toBe(true);
    expect(
      browserDispatchSchema.safeParse({
        action: {
          type: 'browser.input_snapshot',
          role: 'textbox',
          name: 'search',
          offset: 25,
          limit: 25,
        },
      }).success,
    ).toBe(true);
  });

  it('accepts the expanded MCP browser action payload and strips only chat scope', () => {
    const result = browserDispatchSchema.safeParse({
      action: {
        type: 'browser.click',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        expectedRuntimeGeneration: 3,
        ref: 'control-1',
        button: 'right',
        clickCount: 2,
        modifiers: ['Control', 'Shift'],
        position: { x: 2, y: 4 },
        actionId: ' click-control ',
        timeoutMs: 60_000,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toEqual({
        type: 'browser.click',
        expectedRuntimeGeneration: 3,
        ref: 'control-1',
        button: 'right',
        clickCount: 2,
        modifiers: ['Control', 'Shift'],
        position: { x: 2, y: 4 },
        actionId: 'click-control',
        timeoutMs: 60_000,
      });
    }
  });

  it('advertises browser focus, wait_for, and their bounded parameters', () => {
    const dispatchTool = buildCanopyDynamicToolSpecs({}).find(
      (tool) => tool.name === 'canopy_dispatch_action',
    );
    const actionProperty = getSchemaProperty(
      dispatchTool?.inputSchema,
      'action',
    );
    const typeProperty = getSchemaProperty(actionProperty, 'type');
    const schemaAction = getSchemaProperty(dispatchActionJsonSchema, 'action');

    expect(getStringArrayProperty(typeProperty, 'enum')).toEqual(
      expect.arrayContaining([
        'browser.focus',
        'browser.wait_for',
        'browser.list_transfers',
        'browser.cancel_transfer',
      ]),
    );
    const button = getSchemaProperty(actionProperty, 'button');
    expect(button).toMatchObject({
      type: 'string',
      enum: ['left', 'right', 'middle'],
    });
    expect(button?.description).toContain('Defaults to left');
    const clickCount = getSchemaProperty(actionProperty, 'clickCount');
    expect(clickCount).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 3,
    });
    expect(clickCount?.description).toContain('Defaults to 1');
    const modifiers = getSchemaProperty(actionProperty, 'modifiers');
    expect(modifiers).toMatchObject({
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
    });
    expect(
      isRecord(modifiers?.items) ? modifiers.items : undefined,
    ).toMatchObject({
      type: 'string',
      enum: ['Alt', 'Control', 'Meta', 'Shift'],
    });
    const position = getSchemaProperty(actionProperty, 'position');
    expect(position).toMatchObject({
      type: 'object',
      required: ['x', 'y'],
      additionalProperties: false,
    });
    expect(getSchemaProperty(position, 'x')).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(getSchemaProperty(position, 'y')).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(getSchemaProperty(actionProperty, 'force')).toMatchObject({
      type: 'boolean',
    });
    const actionId = getSchemaProperty(actionProperty, 'actionId');
    expect(actionId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '\\S',
    });
    expect(actionId?.description).toContain('trimmed, non-empty');
    const timeoutMs = getSchemaProperty(actionProperty, 'timeoutMs');
    expect(timeoutMs).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 120_000,
    });
    expect(timeoutMs?.description).toContain('5,000');
    expect(timeoutMs?.description).toContain('10,000');
    expect(timeoutMs?.description).toContain('60,000');
    expect(timeoutMs?.description).toContain('120,000');
    const state = getSchemaProperty(actionProperty, 'state');
    expect(state).toMatchObject({
      type: 'string',
      enum: ['visible', 'hidden', 'attached', 'detached'],
    });
    expect(state?.description).toContain('Defaults to visible');
    expect(getSchemaProperty(actionProperty, 'loadState')).toMatchObject({
      type: 'string',
      enum: ['load', 'domcontentloaded', 'network_idle'],
    });
    expect(getSchemaProperty(actionProperty, 'locator')?.description).toContain(
      'wait_for',
    );
    expect(getSchemaProperty(actionProperty, 'text')?.description).toContain(
      'wait_for',
    );
    expect(getSchemaProperty(actionProperty, 'url')?.description).toContain(
      'wait_for',
    );

    const generatedRules = JSON.stringify(schemaAction?.allOf);
    expect(generatedRules).toContain('browser.wait_for');
    expect(generatedRules).toContain('"maximum":60000');
    expect(generatedRules).toContain('"maximum":120000');
  });

  it('validates new browser action rules and timeout limits on the MCP route', () => {
    const browserTarget = {
      expectedRuntimeGeneration: 3,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };

    expect(
      browserDispatchSchema.safeParse({
        action: {
          type: 'browser.focus',
          ...browserTarget,
          locator: 'button[title="Save"]',
        },
      }).success,
    ).toBe(true);
    for (const condition of [
      { locator: 'button[title="Save"]', state: 'visible' },
      { text: 'Saved' },
      { url: '**/settings' },
      { loadState: 'network_idle' },
    ]) {
      expect(
        browserDispatchSchema.safeParse({
          action: { type: 'browser.wait_for', ...browserTarget, ...condition },
        }).success,
      ).toBe(true);
    }
    for (const action of [
      { type: 'browser.focus', ...browserTarget },
      { type: 'browser.wait_for', ...browserTarget },
      {
        type: 'browser.wait_for',
        ...browserTarget,
        locator: 'button',
        text: 'Saved',
      },
      {
        type: 'browser.click',
        ...browserTarget,
        ref: 'control-1',
        position: { x: 1, y: 2 },
        force: true,
      },
      {
        type: 'browser.click',
        ...browserTarget,
        ref: 'control-1',
        actionId: '   ',
      },
      {
        type: 'browser.click',
        ...browserTarget,
        ref: 'control-1',
        timeoutMs: 60_001,
      },
      {
        type: 'browser.wait_for',
        ...browserTarget,
        locator: 'button',
        timeoutMs: 120_001,
      },
    ]) {
      expect(browserDispatchSchema.safeParse({ action }).success).toBe(false);
    }
  });

  it('builds the exact Codex dynamic tool names', () => {
    expect(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
      }).map((tool) => tool.name),
    ).toEqual([
      'canopy_ask_user_question',
      'canopy_get_script_output',
      'canopy_read_pipeline_yaml',
      'canopy_search_deferred_tools',
      'canopy_load_deferred_tools',
      'canopy_immediate_turn_restart',
      'canopy_get_git_preferences',
      'canopy_save_memory',
      'canopy_search_memory',
      'canopy_read_memory',
      'canopy_show_capabilities',
      'canopy_show_files',
      'canopy_get_file_comments',
      'canopy_respond_to_file_comment',
      'canopy_search_actions',
      'canopy_dispatch_action',
      'canopy_search_watchers',
      'canopy_setup_watchers',
      'canopy_watch_github_items',
      'canopy_get_github_pull_request_status',
      'canopy_delete_watchers',
      'canopy_watch_command',
      'canopy_schedule_wakeup',
      'canopy_set_auto_archive',
      'canopy_start_forked_agent',
      'canopy_start_branched_agent',
      'canopy_set_base_branch',
      'canopy_get_code_graph_context',
      'canopy_build_or_update_code_graph',
      'canopy_query_code_graph',
      'canopy_search_code_graph',
      'canopy_explain_code_symbol',
      'canopy_get_impact_radius',
      'canopy_detect_changed_symbols',
      'canopy_compare_change_impact',
      'canopy_get_review_context',
    ]);
  });

  it('advertises ShowVisual only for eligible worktree and cowork options with the shared schema', () => {
    for (const mode of ['worktree', 'cowork'] as const) {
      const enabled = buildCanopyDynamicToolSpecs({
        mode,
        includeChatVisuals: true,
      });
      const disabled = buildCanopyDynamicToolSpecs({
        mode,
        includeChatVisuals: false,
      });
      const visual = enabled.find((tool) => tool.name === 'canopy_show_visual');
      const preview = enabled.find(
        (tool) => tool.name === 'canopy_preview_visual',
      );
      expect(visual).toBeDefined();
      expect(preview).toBeDefined();
      expect(disabled.map((tool) => tool.name)).not.toContain(
        'canopy_show_visual',
      );
      expect(getStringArrayProperty(visual?.inputSchema, 'required')).toEqual([
        'html',
        'title',
        'height',
      ]);
      expect(visual?.inputSchema).toHaveProperty('additionalProperties', false);
      expect(getStringArrayProperty(preview?.inputSchema, 'required')).toEqual([
        'html',
      ]);
      expect(disabled.map((tool) => tool.name)).not.toContain(
        'canopy_preview_visual',
      );
    }
    expect(
      buildCanopyDynamicToolSpecs({
        mode: 'minimal',
        includeChatVisuals: true,
      }).map((tool) => tool.name),
    ).not.toContain('canopy_show_visual');
    expect(
      buildCanopyDynamicToolSpecs({
        mode: 'minimal',
        includeChatVisuals: true,
      }).map((tool) => tool.name),
    ).not.toContain('canopy_preview_visual');
  });

  it('passes the native call id separately from the display tool-use id', async () => {
    const execute = jest
      .spyOn(injectedToolCore, 'executeCanopyInjectedTool')
      .mockResolvedValue({ text: 'shown' });
    try {
      await handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'native-call-1',
          namespace: null,
          tool: 'canopy_show_visual',
          arguments: {},
        },
        { requestUserAnswers: jest.fn(), loadScriptOutput: jest.fn() },
      );
      expect(execute).toHaveBeenCalledWith(
        'show_visual',
        {},
        expect.any(Object),
        expect.objectContaining({
          codexCallId: 'native-call-1',
          toolUseId: 'codex-native-call-1',
        }),
      );
    } finally {
      execute.mockRestore();
    }
  });

  it('drops an oversized PreviewVisual image after exact response serialization', async () => {
    const execute = jest
      .spyOn(injectedToolCore, 'executeCanopyInjectedTool')
      .mockResolvedValue({
        text: 'height 100',
        imageDataUrl: `data:image/png;base64,${'A'.repeat(70_000)}`,
      });
    try {
      const response = await handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'preview-1',
          namespace: null,
          tool: 'canopy_preview_visual',
          arguments: { html: '<p>ok</p>' },
        },
        { requestUserAnswers: jest.fn(), loadScriptOutput: jest.fn() },
      );
      expect(JSON.stringify(response)).not.toContain('A'.repeat(70_000));
      expect(JSON.stringify(response)).toContain('Screenshot omitted');
      expect(
        Buffer.byteLength(JSON.stringify(response), 'utf8'),
      ).toBeLessThanOrEqual(60 * 1024);
      // 60 KiB for the response, less 12 KiB of text and 2 KiB of overhead,
      // as raw bytes before base64.
      expect(execute).toHaveBeenCalledWith(
        'preview_visual',
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ imageBudgetBytes: 35_328 }),
      );
    } finally {
      execute.mockRestore();
    }
  });

  it.each([
    ['without a screenshot', undefined],
    // The largest image the Codex budget admits, as base64.
    ['with a screenshot', `data:image/jpeg;base64,${'A'.repeat(47_104)}`],
  ])(
    'keeps a PreviewVisual response within the limit when page output escapes heavily, %s',
    async (_label, imageDataUrl) => {
      // The tool caps its text at 12 KiB of raw bytes. A control character
      // is one raw byte and six once JSON-escaped.
      const text = `Preview rendered at 720px.\nConsole log (untrusted page output): ${'\u0001'.repeat(12_000)}`;
      const execute = jest
        .spyOn(injectedToolCore, 'executeCanopyInjectedTool')
        .mockResolvedValue({ text, ...(imageDataUrl ? { imageDataUrl } : {}) });
      try {
        const response = await handleCanopyDynamicToolCall(
          {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'preview-2',
            namespace: null,
            tool: 'canopy_preview_visual',
            arguments: { html: '<p>ok</p>' },
          },
          { requestUserAnswers: jest.fn(), loadScriptOutput: jest.fn() },
        );
        const serialized = JSON.stringify(response);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
          60 * 1024,
        );
        expect(serialized).toContain('Preview rendered at 720px.');
        expect(serialized).toContain('More diagnostics omitted');
        // The text gives way first, so a screenshot within its budget stays.
        expect(serialized.includes('data:image/jpeg;base64,')).toBe(
          imageDataUrl !== undefined,
        );
      } finally {
        execute.mockRestore();
      }
    },
  );

  it('marks every Codex dynamic tool as a function tool', () => {
    for (const tool of buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      isCodeReview: true,
    })) {
      expect(tool).toHaveProperty('type', 'function');
    }
  });

  it('requires an enabled boolean for SetAutoArchive', () => {
    const tool = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((candidate) => candidate.name === 'canopy_set_auto_archive');
    expect(getStringArrayProperty(tool?.inputSchema, 'required')).toContain(
      'enabled',
    );
    expect(getSchemaProperty(tool?.inputSchema, 'enabled')).toMatchObject({
      type: 'boolean',
    });
  });

  it('scopes SetBaseBranch to an implicit worktree target', () => {
    const tool = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((candidate) => candidate.name === 'canopy_set_base_branch');
    expect(getStringArrayProperty(tool?.inputSchema, 'required')).toContain(
      'baseBranch',
    );
    expect(getSchemaProperty(tool?.inputSchema, 'baseBranch')).toMatchObject({
      type: 'string',
    });
    expect(getSchemaProperty(tool?.inputSchema, 'repoId')).toMatchObject({
      type: 'string',
    });
    expect(getSchemaProperty(tool?.inputSchema, 'projectId')).toBeUndefined();
    expect(getSchemaProperty(tool?.inputSchema, 'worktreeId')).toBeUndefined();
    expect(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
        mode: 'cowork',
      }).some((candidate) => candidate.name === 'canopy_set_base_branch'),
    ).toBe(false);
  });

  it('describes tracked-plan and browser support in the worktree SearchActions schema', () => {
    const searchTool = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((tool) => tool.name === 'canopy_search_actions');
    const categoryProperty = getSchemaProperty(
      searchTool?.inputSchema,
      'category',
    );
    const actionTypeProperty = getSchemaProperty(
      searchTool?.inputSchema,
      'actionType',
    );
    const categoryDescription =
      typeof categoryProperty?.description === 'string'
        ? categoryProperty.description
        : '';
    const actionTypeDescription =
      typeof actionTypeProperty?.description === 'string'
        ? actionTypeProperty.description
        : '';

    expect(categoryDescription).toContain('"pipeline"');
    expect(categoryDescription).toContain('"tracked-plan"');
    expect(categoryDescription).toContain('"browser"');
    expect(actionTypeDescription).toContain('tracked-plan.import');
    expect(actionTypeDescription).toContain('browser.open');
    expect(actionTypeDescription).toContain('browser.navigate');
    expect(actionTypeDescription).toContain('browser.focus');
    expect(actionTypeDescription).toContain('browser.wait_for');
    expect(actionTypeDescription).toContain('browser.screenshot');
    expect(actionTypeDescription).toContain('browser.input_snapshot');
    expect(actionTypeDescription).toContain('browser.inspect');
    expect(JSON.stringify(searchTool?.inputSchema)).not.toContain(
      'Only "pipeline"',
    );
  });

  it('exposes hook status, pause, and resume actions in the worktree DispatchAction provider schema', () => {
    const dispatchTool = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((tool) => tool.name === 'canopy_dispatch_action');
    const actionProperty = getSchemaProperty(
      dispatchTool?.inputSchema,
      'action',
    );
    const typeProperty = getSchemaProperty(actionProperty, 'type');

    expect(getStringArrayProperty(actionProperty, 'required')).toContain(
      'type',
    );
    expect(getStringArrayProperty(typeProperty, 'enum')).toEqual(
      expect.arrayContaining([
        'worktree.get_settings',
        'hook.pause',
        'hook.resume',
        'browser.input_snapshot',
        'browser.get_dialog',
        'browser.handle_dialog',
      ]),
    );
    expect(getSchemaProperty(actionProperty, 'ref')).toMatchObject({
      type: 'string',
    });
    expect(getSchemaProperty(actionProperty, 'inputType')).toMatchObject({
      type: 'string',
    });
    expect(getSchemaProperty(actionProperty, 'dialogId')).toMatchObject({
      type: 'string',
    });
    expect(getSchemaProperty(actionProperty, 'dialogResponse')).toMatchObject({
      type: 'object',
    });
    expect(actionProperty?.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: {
            properties: {
              type: { enum: ['browser.click', 'browser.press'] },
            },
            required: ['type'],
          },
          else: {
            not: { required: ['dialogResponse'] },
          },
        }),
      ]),
    );
    expect(JSON.stringify(actionProperty)).toContain('"oneOf"');
  });

  it('uses branded live Codex dynamic tool names for non-Canopy builds', () => {
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: testBrand,
      default: testBrand,
    }));

    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const branded =
        require('../codex/canopy-dynamic-tools') as typeof CanopyDynamicToolsModule;
      /* eslint-enable @typescript-eslint/no-require-imports */

      expect(
        branded
          .buildCanopyDynamicToolSpecs({
            includeChatVisuals: false,
          })
          .map((tool) => tool.name),
      ).toEqual([
        'testbrand_ask_user_question',
        'testbrand_get_script_output',
        'testbrand_read_pipeline_yaml',
        'testbrand_search_deferred_tools',
        'testbrand_load_deferred_tools',
        'testbrand_immediate_turn_restart',
        'testbrand_get_git_preferences',
        'testbrand_save_memory',
        'testbrand_search_memory',
        'testbrand_read_memory',
        'testbrand_show_capabilities',
        'testbrand_show_files',
        'testbrand_get_file_comments',
        'testbrand_respond_to_file_comment',
        'testbrand_search_actions',
        'testbrand_dispatch_action',
        'testbrand_search_watchers',
        'testbrand_setup_watchers',
        'testbrand_watch_github_items',
        'testbrand_get_github_pull_request_status',
        'testbrand_delete_watchers',
        'testbrand_watch_command',
        'testbrand_schedule_wakeup',
        'testbrand_set_auto_archive',
        'testbrand_start_forked_agent',
        'testbrand_start_branched_agent',
        'testbrand_set_base_branch',
        'testbrand_get_code_graph_context',
        'testbrand_build_or_update_code_graph',
        'testbrand_query_code_graph',
        'testbrand_search_code_graph',
        'testbrand_explain_code_symbol',
        'testbrand_get_impact_radius',
        'testbrand_detect_changed_symbols',
        'testbrand_compare_change_impact',
        'testbrand_get_review_context',
      ]);
    });
  });

  it('can omit worktree action tools for non-worktree chats', () => {
    expect(
      buildCanopyDynamicToolSpecs({
        includeChatVisuals: false,
        includeWorktreeActions: false,
      }).map((tool) => tool.name),
    ).toEqual([
      'canopy_ask_user_question',
      'canopy_get_script_output',
      'canopy_read_pipeline_yaml',
      'canopy_search_deferred_tools',
      'canopy_load_deferred_tools',
      'canopy_immediate_turn_restart',
    ]);
  });

  it('advertises memory tools in cowork mode without worktree-only tools', () => {
    const names = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      mode: 'cowork',
    }).map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'canopy_save_memory',
        'canopy_search_memory',
        'canopy_read_memory',
      ]),
    );
    expect(names).not.toContain('canopy_get_git_preferences');
    expect(names).toContain('canopy_get_script_output');
    expect(names).toContain('canopy_watch_command');
    expect(names).toContain('canopy_schedule_wakeup');
    expect(names).toContain('canopy_watch_github_items');
    expect(names).toContain('canopy_get_github_pull_request_status');
    expect(
      names.filter((name) => name === 'canopy_delete_watchers'),
    ).toHaveLength(1);
  });

  it('includes the code-graph and change-impact tools only when includeWorktreeActions is true', () => {
    const codeGraphToolNames = [
      'canopy_get_code_graph_context',
      'canopy_build_or_update_code_graph',
      'canopy_query_code_graph',
      'canopy_search_code_graph',
      'canopy_explain_code_symbol',
      'canopy_get_impact_radius',
      'canopy_detect_changed_symbols',
      'canopy_compare_change_impact',
      'canopy_get_review_context',
    ];
    const withWorktreeActions = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      includeWorktreeActions: true,
    }).map((tool) => tool.name);
    const withoutWorktreeActions = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      includeWorktreeActions: false,
    }).map((tool) => tool.name);

    for (const name of codeGraphToolNames) {
      expect(withWorktreeActions).toContain(name);
      expect(withoutWorktreeActions).not.toContain(name);
    }
  });

  it('omits the nine code-graph specs when includeCodeGraph is false but keeps the other worktree action tools', () => {
    const codeGraphToolNames = [
      'canopy_get_code_graph_context',
      'canopy_build_or_update_code_graph',
      'canopy_query_code_graph',
      'canopy_search_code_graph',
      'canopy_explain_code_symbol',
      'canopy_get_impact_radius',
      'canopy_detect_changed_symbols',
      'canopy_compare_change_impact',
      'canopy_get_review_context',
    ];
    const names = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      includeWorktreeActions: true,
      includeCodeGraph: false,
    }).map((tool) => tool.name);

    for (const name of codeGraphToolNames) {
      expect(names).not.toContain(name);
    }
    // The other worktree action tools remain advertised.
    expect(names).toContain('canopy_dispatch_action');
    expect(names).toContain('canopy_set_auto_archive');
    expect(names).toContain('canopy_get_git_preferences');
    expect(names).toContain('canopy_save_memory');
    expect(names).toContain('canopy_search_memory');
    expect(names).toContain('canopy_read_memory');
  });

  it('includes the nine code-graph specs when includeCodeGraph is true (default)', () => {
    const codeGraphToolNames = [
      'canopy_get_code_graph_context',
      'canopy_build_or_update_code_graph',
      'canopy_query_code_graph',
      'canopy_search_code_graph',
      'canopy_explain_code_symbol',
      'canopy_get_impact_radius',
      'canopy_detect_changed_symbols',
      'canopy_compare_change_impact',
      'canopy_get_review_context',
    ];
    const defaultNames = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).map((tool) => tool.name);
    const explicitNames = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      includeWorktreeActions: true,
      includeCodeGraph: true,
    }).map((tool) => tool.name);

    for (const name of codeGraphToolNames) {
      expect(defaultNames).toContain(name);
      expect(explicitNames).toContain(name);
    }
  });

  it('does not advertise retired review tools but retains compatibility dispatch', async () => {
    const names = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      isCodeReview: true,
    }).map((tool) => tool.name);
    expect(names).not.toContain('canopy_respond_to_comment');
    expect(names).not.toContain('canopy_get_review_comments');

    const respondToReviewComment = jest
      .fn()
      .mockResolvedValue({ ok: true, resolved: true });
    const getReviewCommentThread = jest
      .fn()
      .mockResolvedValue({ ok: true, text: 'No open comment threads.' });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      respondToReviewComment,
      getReviewCommentThread,
    };

    // The respond tool name was shared with the retired plan-chat takeover;
    // the dispatcher reaches the code-review hook.
    await expect(
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: 'canopy_respond_to_comment',
          arguments: { threadId: 't1', body: 'done', resolve: true },
        },
        runtime,
      ),
    ).resolves.toEqual({
      contentItems: [
        { type: 'inputText', text: 'Reply posted to thread t1 and resolved.' },
      ],
      success: true,
    });
    expect(respondToReviewComment).toHaveBeenCalledWith({
      threadId: 't1',
      body: 'done',
      resolve: true,
    });

    await expect(
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-2',
          namespace: null,
          tool: 'canopy_get_review_comments',
          arguments: {},
        },
        runtime,
      ),
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'No open comment threads.' }],
      success: true,
    });
    expect(getReviewCommentThread).toHaveBeenCalledWith({});
  });

  it('no longer dispatches GetPlanComments', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    // The plan-chat takeover that advertised it is retired; a stale call from
    // an old transcript gets the ordinary unsupported-tool answer.
    await expect(
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: 'canopy_get_plan_comments',
          arguments: {},
        },
        runtime,
      ),
    ).resolves.toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Unsupported dynamic tool: canopy_get_plan_comments',
        },
      ],
      success: false,
    });
  });

  it('returns a failed DynamicToolCallResponse for unknown tools', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    await expect(
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: 'unknown_tool',
          arguments: null,
        },
        runtime,
      ),
    ).resolves.toEqual({
      contentItems: [
        { type: 'inputText', text: 'Unsupported dynamic tool: unknown_tool' },
      ],
      success: false,
    });
  });

  it('accepts ImmediateTurnRestart without exposing it through Claude MCP', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    await expect(
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'restart-1',
          namespace: null,
          tool: 'canopy_immediate_turn_restart',
          arguments: {},
        },
        runtime,
      ),
    ).resolves.toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Restarting this turn with refreshed MCP connections.',
        },
      ],
      success: true,
    });
  });
});

describe('canopy dynamic tools — toolSchemaProfile', () => {
  const COMBINATORS = ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else'];

  function collectKeys(node: unknown, keys: Set<string>): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        collectKeys(item, keys);
      }
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        keys.add(key);
        collectKeys(value, keys);
      }
    }
  }

  function schemaKeywords(schema: unknown): Set<string> {
    const keys = new Set<string>();
    collectKeys(schema, keys);
    return keys;
  }

  it('leaves schemas untouched when the flag is off (default)', () => {
    const setupWatchers = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((tool) => tool.name === 'canopy_setup_watchers');
    const dispatch = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
    }).find((tool) => tool.name === 'canopy_dispatch_action');
    // The default (rich) schemas still carry the combinators the strict
    // dialect can't accept — this is what makes the flag meaningful.
    expect(schemaKeywords(setupWatchers?.inputSchema).has('anyOf')).toBe(true);
    expect(schemaKeywords(dispatch?.inputSchema).has('allOf')).toBe(true);
  });

  it('strips every combinator from setup_watchers and dispatch_action when on', () => {
    const specs = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      toolSchemaProfile: 'flat',
    });
    for (const name of ['canopy_setup_watchers', 'canopy_dispatch_action']) {
      const spec = specs.find((tool) => tool.name === name);
      expect(spec).toBeDefined();
      const keywords = schemaKeywords(spec?.inputSchema);
      for (const combinator of COMBINATORS) {
        expect(keywords.has(combinator)).toBe(false);
      }
    }
  });

  it('sanitizes every advertised tool, not just the known offenders', () => {
    const specs = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      toolSchemaProfile: 'flat',
    });
    for (const spec of specs) {
      const keywords = schemaKeywords(spec.inputSchema);
      for (const combinator of COMBINATORS) {
        expect(keywords.has(combinator)).toBe(false);
      }
    }
  });

  it('preserves field-level guidance (type enum + descriptions) after sanitizing', () => {
    const dispatchTool = buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      toolSchemaProfile: 'flat',
    }).find((tool) => tool.name === 'canopy_dispatch_action');
    const actionProperty = getSchemaProperty(
      dispatchTool?.inputSchema,
      'action',
    );
    const typeProperty = getSchemaProperty(actionProperty, 'type');
    // The action-type enum (model guidance) survives the combinator strip.
    expect(getStringArrayProperty(typeProperty, 'enum')).toEqual(
      expect.arrayContaining(['hook.pause', 'browser.navigate']),
    );
  });
});

describe('canopy dynamic tools — Ledger', () => {
  const LEDGER_CODEX_NAMES = [
    'canopy_add_feed_entry',
    'canopy_search_feed_entries',
    'canopy_update_feed_entry',
  ];

  it.each(['worktree', 'cowork'] as const)(
    'adds the Ledger tools in %s mode only for an exposed session',
    (mode) => {
      const exposed = buildCanopyDynamicToolSpecs({
        mode,
        includeLedger: true,
      }).map((tool) => tool.name);
      const hidden = buildCanopyDynamicToolSpecs({ mode }).map(
        (tool) => tool.name,
      );

      expect(exposed).toEqual(expect.arrayContaining(LEDGER_CODEX_NAMES));
      for (const name of LEDGER_CODEX_NAMES) {
        expect(hidden).not.toContain(name);
      }
    },
  );

  it('keeps the Ledger tools with or without the code graph and never in minimal mode', () => {
    const withoutGraph = buildCanopyDynamicToolSpecs({
      mode: 'worktree',
      includeCodeGraph: false,
      includeLedger: true,
    }).map((tool) => tool.name);
    const minimal = buildCanopyDynamicToolSpecs({
      mode: 'minimal',
      includeLedger: true,
    }).map((tool) => tool.name);

    expect(withoutGraph).toEqual(expect.arrayContaining(LEDGER_CODEX_NAMES));
    for (const name of LEDGER_CODEX_NAMES) {
      expect(minimal).not.toContain(name);
    }
  });

  it('derives the advertised Ledger schemas from the protocol tool inputs', () => {
    const specs = buildCanopyDynamicToolSpecs({
      mode: 'worktree',
      includeLedger: true,
    });
    const update = specs.find(
      (tool) => tool.name === 'canopy_update_feed_entry',
    );
    const inputSchema =
      update && update.type === 'function' ? update.inputSchema : undefined;

    expect(inputSchema).toMatchObject({
      type: 'object',
      required: ['entryId', 'expectedRevision'],
      additionalProperties: false,
    });
    expect(getSchemaProperty(inputSchema, 'requestKey')).toMatchObject({
      type: 'string',
      maxLength: 128,
    });
    expect(JSON.stringify(inputSchema)).not.toContain('$schema');
  });

  it('passes the Codex thread, turn and call identity to the Ledger runtime', async () => {
    const execute = jest.fn(() => Promise.resolve({ text: '{"ok":true}' }));
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      ledgerRuntime: { execute },
    };

    const response = await handleCanopyDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-2',
        callId: 'call-3',
        namespace: null,
        tool: 'canopy_add_feed_entry',
        arguments: { type: 'TASK', title: 'Plan', content: 'Plan it.' },
      },
      runtime,
    );

    expect(response).toEqual({
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
      success: true,
    });
    expect(execute).toHaveBeenCalledWith(
      'add_ledger_entry',
      { type: 'TASK', title: 'Plan', content: 'Plan it.' },
      { invocationId: 'codex:thread-1:turn-2:call-3' },
    );
  });

  it('answers a kept Ledger tool as unavailable when the session has no Ledger runtime', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    const response = await handleCanopyDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'canopy_search_feed_entries',
        arguments: {},
      },
      runtime,
    );

    expect(response.success).toBe(false);
    expect(JSON.stringify(response.contentItems)).toContain('FEED_UNAVAILABLE');
  });
});

it('forwards bot discovery targets through Codex dynamic DispatchAction', async () => {
  const execute = jest
    .spyOn(injectedToolCore, 'executeCanopyInjectedTool')
    .mockResolvedValue({ text: '{"ok":true}' });
  const runtime: CanopyInjectedToolRuntime = {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    worktreeActionRuntime: {
      projectId: 'origin-project',
      worktreeId: 'origin-task',
      chatId: 'origin-chat',
      cwd: '/repo',
      getWindow: () => null,
    },
  };
  const action = { type: 'bots.list_tasks', botId: 'app_advisor' };

  const response = await handleCanopyDynamicToolCall(
    {
      threadId: 'thread',
      turnId: 'turn',
      callId: 'bot-call',
      namespace: null,
      tool: 'canopy_dispatch_action',
      arguments: { action },
    },
    runtime,
  );

  expect(response.success).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    'dispatch_action',
    { action },
    runtime,
    expect.objectContaining({ toolUseId: 'codex-bot-call' }),
  );
  execute.mockRestore();
});

it.each(['worktree', 'directory'] as const)(
  'rechecks live bot access through Codex dynamic tools (%s)',
  async (executionScope) => {
    mockIsBotAccessAllowed
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'origin-project',
        worktreeId: 'origin-task',
        chatId: 'origin-chat',
        cwd: '/repo',
        executionScope,
        getWindow: () => null,
      },
    };
    const caller: ProjectDiscoveryCaller = {
      kind: 'project_agent',
      projectId: 'origin-project',
      worktreeId: 'origin-task',
      chatId: 'origin-chat',
    };
    const search = async (callId: string): Promise<string> => {
      const response = await handleCanopyDynamicToolCall(
        {
          threadId: 'thread',
          turnId: 'turn',
          callId,
          namespace: null,
          tool: 'canopy_search_actions',
          arguments: { query: 'bots', limit: 50 },
        },
        runtime,
      );
      const text = response.contentItems.find(
        (item) => item.type === 'inputText',
      )?.text;
      expect(response.success).toBe(true);
      expect(text).toBeDefined();
      return text ?? '';
    };

    const enabled: unknown = JSON.parse(await search('bot-search-enabled'));
    const disabled: unknown = JSON.parse(await search('bot-search-disabled'));
    const reenabled: unknown = JSON.parse(await search('bot-search-reenabled'));

    expect(enabled).toHaveProperty(
      'categories',
      expect.arrayContaining(['bots']),
    );
    expect(enabled).toHaveProperty('totalMatches', BOT_ACTION_TYPES.length);
    expect(disabled).toHaveProperty(
      'categories',
      expect.not.arrayContaining(['bots']),
    );
    expect(disabled).toHaveProperty('totalMatches', 0);
    expect(reenabled).toHaveProperty(
      'categories',
      expect.arrayContaining(['bots']),
    );
    expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
    expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(1, caller);
    expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(2, caller);
    expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(3, caller);
    expect(mockDispatchBotAction).not.toHaveBeenCalled();
    mockDispatchBotAction
      .mockResolvedValueOnce({ ok: true, result: { items: [] } })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'advisor_access_disabled', message: 'Access disabled.' },
      });
    const action = botActionSchema.parse({ type: 'bots.list' });
    for (const [callId, allowed] of [
      ['bot-dispatch-allowed', true],
      ['bot-dispatch-denied', false],
    ] as const) {
      const response = await handleCanopyDynamicToolCall(
        {
          threadId: 'thread',
          turnId: 'turn',
          callId,
          namespace: null,
          tool: 'canopy_dispatch_action',
          arguments: { action },
        },
        runtime,
      );
      expect(response.success).toBe(allowed);
      const text = response.contentItems.find(
        (item) => item.type === 'inputText',
      )?.text;
      const result: unknown = JSON.parse(text ?? 'null');
      expect(result).toMatchObject(
        allowed
          ? { ok: true }
          : {
              ok: false,
              error: { code: 'advisor_access_disabled' },
            },
      );
    }
    expect(mockDispatchBotAction).toHaveBeenCalledTimes(2);
    expect(mockDispatchBotAction).toHaveBeenNthCalledWith(1, action, caller);
    expect(mockDispatchBotAction).toHaveBeenNthCalledWith(2, action, caller);
    expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
  },
);

describe('canonical watcher Codex boundary', () => {
  const setupCanonical = jest.fn().mockResolvedValue({ ok: true, results: [] });
  beforeAll(() => {
    jest.doMock('../app-advisor/watchers', (): object => ({
      getAppAdvisorWatcherService: () => ({
        setupCanonicalChatWatchers: setupCanonical,
      }),
    }));
  });
  afterAll(() => {
    jest.dontMock('../app-advisor/watchers');
  });
  it('routes all four canonical triggers and rejects raw mixed-envelope smuggling', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'root',
        worktreeId: 'task',
        chatId: 'chat',
      },
    };
    const watchers = [
      {
        trigger: 'project_task_chat_completion',
        target: { projectId: 'p', taskId: 't', chatId: 'c' },
        armForNextCompletion: true,
      },
      {
        trigger: 'project_new_chat_started',
        target: { projectId: 'p', taskId: 't' },
      },
      {
        trigger: 'bot_task_chat_completion',
        target: { botId: 'app_advisor', taskId: 't', chatId: 'c' },
        armForNextCompletion: true,
      },
      { trigger: 'bot_new_chat_started', target: { botId: 'app_advisor' } },
    ];
    const call = (
      args: unknown,
    ): ReturnType<typeof handleCanopyDynamicToolCall> =>
      handleCanopyDynamicToolCall(
        {
          threadId: 'thread',
          turnId: 'turn',
          callId: 'call',
          namespace: null,
          tool: 'canopy_setup_watchers',
          arguments: args,
        },
        runtime,
      );
    expect((await call({ watchers })).success).toBe(true);
    expect(setupCanonical).toHaveBeenCalledWith({
      destination: runtime.worktreeWatcherRuntime,
      recipient: { kind: 'root' },
      watchers,
      createdByToolUseId: 'codex-call',
    });
    setupCanonical.mockClear();
    for (const args of [
      { watchers, destination: { projectId: 'forged' } },
      {
        watchers: [
          { target: { executionId: 'e' } },
          {
            ...watchers[0],
            target: { ...watchers[0]?.target, kind: 'project_task_chat' },
          },
        ],
      },
      { watchers: [{ ...watchers[0], owner: 'forged' }] },
    ]) {
      const response = await call(args);
      expect(response.success).toBe(false);
      expect(JSON.stringify(response.contentItems)).toContain(
        'Invalid arguments',
      );
    }
    expect(setupCanonical).not.toHaveBeenCalled();
    const tool = buildCanopyDynamicToolSpecs({}).find(
      (tool) => tool.name === 'canopy_setup_watchers',
    );
    const schema =
      tool && tool.type === 'function' ? tool.inputSchema : undefined;
    for (const watcher of watchers)
      expect(JSON.stringify(schema)).toContain(watcher.trigger);
  });
});
