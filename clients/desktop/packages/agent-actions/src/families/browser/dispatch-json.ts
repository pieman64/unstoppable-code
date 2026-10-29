import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import type { AgentJsonSchema } from '../../tools/definition';
import {
  browserDownloadWaitJsonSchema,
  browserPointerViewportJsonSchemaProperties,
  browserTransferJsonSchemaRules,
  browserUploadWaitJsonSchema,
  mcpBrowserDispatchJsonSchemaRules,
} from './schemas';

/** Advertised payload properties of the browser actions. */
export const BROWSER_DISPATCH_JSON_PROPERTIES: AgentJsonSchema = {
  transferId: {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
    description: 'Transfer id returned by browser.list_transfers.',
  },
  downloadId: {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
    description:
      'For browser.save_download, a finished download id from browser.list_transfers.',
  },
  path: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    description:
      'For browser.save_download, the file path relative to the workspace root.',
  },
  overwrite: {
    type: 'boolean',
    description:
      'For browser.save_download, replace a file that already has the name.',
  },
  fileName: {
    type: 'string',
    minLength: 1,
    maxLength: 120,
    pattern: '\\S',
    description:
      "For browser.save_pdf, the file's name before .pdf. Defaults to the page title.",
  },
  landscape: {
    type: 'boolean',
    description: 'For browser.save_pdf, print in landscape.',
  },
  printBackground: {
    type: 'boolean',
    description:
      'For browser.save_pdf, print background colors and images. Defaults to true.',
  },
  scale: {
    type: 'number',
    minimum: 0.1,
    maximum: 2,
    description: 'For browser.save_pdf, the print scale. Defaults to 1.',
  },
  paperFormat: {
    type: 'string',
    enum: ['letter', 'legal', 'a4', 'a3', 'tabloid'],
    description: 'For browser.save_pdf, the paper size. Defaults to letter.',
  },
  pageRanges: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description:
      "For browser.save_pdf, the pages to print, such as '1-3, 5'. Defaults to every page.",
  },
  displayHeaderFooter: {
    type: 'boolean',
    description:
      'For browser.save_pdf, print the page URL and page numbers in the margins.',
  },
  kind: {
    description:
      'For browser.list_transfers, filter transfer kind (download, copy, or upload).',
  },
  files: {
    type: 'array',
    minItems: 1,
    maxItems: 50,
    items: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        downloadId: { type: 'string', minLength: 1, pattern: '\\S' },
        attachmentId: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          pattern: '\\S',
        },
      },
      additionalProperties: false,
    },
    description:
      'For browser.upload_files and browser.drop_files, the files to attach or drop: each { path } relative to the workspace root, { downloadId } of a finished download, or { attachmentId }, the file name of a file the user attached to this chat. Every upload asks this chat to approve the site, in every approval mode.',
  },
  chooserId: {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
    description:
      'For browser.upload_files and browser.request_files, a file chooser your action opened, from effects.fileChooser. Use instead of ref or locator.',
  },
  purpose: {
    type: 'string',
    minLength: 1,
    maxLength: 500,
    pattern: '\\S',
    description:
      'For browser.request_files, why you need the files. The user sees it as your words when asked to choose them.',
  },
  status: {
    description: 'For browser.list_transfers, filter transfer status.',
  },
  browserId: {
    type: 'string',
    description:
      'Optional browser id returned by browser.list. Defaults to the active browser.',
  },
  expectedRuntimeGeneration: {
    type: 'integer',
    minimum: 1,
    description:
      'Runtime generation returned with the target browser. Required for commands on an existing tab; refresh after switching profiles.',
  },
  handoff: {
    type: 'boolean',
    description:
      'Request a user browser handoff; pending until the origin chat accepts a user reply.',
  },
  selection: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['task', 'named'] },
      profileId: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['kind'],
    additionalProperties: false,
    description:
      'Profile for browser.open or browser.profile.switch. Omission on open uses the task default. New tabs require agent enable permission.',
    oneOf: [
      {
        type: 'object',
        properties: { kind: { const: 'task' } },
        required: ['kind'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'named' },
          profileId: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['kind', 'profileId'],
        additionalProperties: false,
      },
    ],
  },
  profileId: { type: 'string', minLength: 1 },
  operationId: {
    type: 'string',
    minLength: 1,
    description:
      'Caller-generated idempotency key for profile switch or clear.',
  },
  mode: {
    type: 'string',
    description:
      'For browser.profile.switch, replace or new-tab. Other actions use their own mode values from SearchActions.',
  },
  storageGeneration: { type: 'integer', minimum: 1 },
  metadataRevision: { type: 'integer', minimum: 1 },
  token: {
    type: 'string',
    minLength: 1,
    description:
      'Current preview token returned by browser.profile.preview_clear.',
  },
  jobId: { type: 'string', minLength: 1 },
  operation: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['cache', 'reset', 'site'] },
      origin: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: false,
    oneOf: [
      {
        type: 'object',
        properties: { kind: { enum: ['cache', 'reset'] } },
        required: ['kind'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: 'site' },
          origin: { type: 'string' },
        },
        required: ['kind', 'origin'],
        additionalProperties: false,
      },
    ],
  },
  ref: {
    type: 'string',
    minLength: 1,
    description: 'Interactive element ref returned by browser.input_snapshot.',
  },
  locator: {
    type: 'string',
    minLength: 1,
    description:
      'CSS selector or one of the documented Playwright-like locator forms. For browser.wait_for, use this as one of the single wait conditions; state applies to the locator and defaults to visible.',
  },
  frame: {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
    description:
      'Frame ref from browser.input_snapshot or CSS selector for the iframe element. Elements in iframes have their own refs; frame narrows a locator to one frame. Use only with locator on click, fill, press, focus, hover, and inspect; with locator or text on wait_for; with locator or toText on scroll; or as a filter on input_snapshot.',
  },
  x: { type: 'number', description: 'Viewport x coordinate.' },
  y: { type: 'number', description: 'Viewport y coordinate.' },
  ...browserPointerViewportJsonSchemaProperties(),
  button: {
    type: 'string',
    enum: ['left', 'right', 'middle'],
    description: 'Mouse button for browser.click. Defaults to left.',
  },
  clickCount: {
    type: 'integer',
    minimum: 1,
    maximum: 3,
    description: 'Number of clicks for browser.click. Defaults to 1.',
  },
  modifiers: {
    type: 'array',
    items: {
      type: 'string',
      enum: ['Alt', 'Control', 'Meta', 'Shift'],
    },
    maxItems: 4,
    uniqueItems: true,
    description:
      'Keyboard modifiers held during browser.click or browser.drag.',
  },
  position: {
    type: 'object',
    properties: {
      x: {
        type: 'number',
        minimum: 0,
        description: 'Nonnegative x offset within the target element.',
      },
      y: {
        type: 'number',
        minimum: 0,
        description: 'Nonnegative y offset within the target element.',
      },
    },
    required: ['x', 'y'],
    additionalProperties: false,
    description:
      'Optional click point relative to the target element. Cannot be combined with force, even when force is false.',
  },
  force: {
    type: 'boolean',
    description:
      'For browser.click, skip actionability checks and use the direct element action. Cannot be combined with position.',
  },
  actionId: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '\\S',
    description:
      'Optional trimmed, non-empty idempotency key (up to 128 characters). A repeated key for this browser runtime returns its retained receipt without dispatching again; reuse with different command arguments is rejected.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1,
    maximum: 120_000,
    description:
      'Optional actionability/settle timeout in milliseconds. Defaults to 5,000 for other actions (maximum 60,000); browser.wait_for defaults to 10,000 (maximum 120,000).',
  },
  url: {
    type: 'string',
    description:
      'HTTP(S), file URL, or absolute local file path for navigation. For browser.wait_for, use a URL substring or a glob containing * as its single wait condition.',
  },
  text: {
    type: 'string',
    description:
      'Text to fill into a control. For browser.wait_for, use visible page text as its single wait condition; state defaults to visible.',
  },
  state: {
    type: 'string',
    enum: ['visible', 'hidden', 'attached', 'detached'],
    description:
      'For browser.wait_for locator or text conditions, the desired state. Defaults to visible.',
  },
  download: {
    ...browserDownloadWaitJsonSchema,
    description:
      'For browser.wait_for, wait for this download id, or the next download when omitted. Cannot be combined with another wait condition, state, or frame.',
  },
  upload: {
    ...browserUploadWaitJsonSchema,
    description:
      'For browser.wait_for, wait for an upload from browser.upload_files to be attached or to end without attaching. Cannot be combined with another wait condition, state, or frame.',
  },
  loadState: {
    type: 'string',
    enum: ['load', 'domcontentloaded', 'network_idle'],
    description:
      'For browser.wait_for, wait for this page load state as its single condition.',
  },
  key: {
    type: 'string',
    description: 'Keyboard key such as Enter, Escape, or Tab.',
  },
  dialogId: {
    type: 'string',
    minLength: 1,
    description:
      'Pending JavaScript dialog id returned by browser.get_dialog or a dialog-producing action.',
  },
  accept: {
    type: 'boolean',
    description:
      'Whether browser.handle_dialog accepts or dismisses the pending dialog.',
  },
  promptText: {
    type: 'string',
    maxLength: 10000,
    description: 'Optional prompt response text for browser.handle_dialog.',
  },
  dialogResponse: {
    type: 'object',
    description:
      'Optional response pre-armed before a browser action that is expected to open a JavaScript dialog. Without it, respond to the returned pending dialog with browser.handle_dialog.',
    properties: {
      accept: {
        type: 'boolean',
        description: 'Whether to accept or dismiss the dialog synchronously.',
      },
      promptText: {
        type: 'string',
        maxLength: 10000,
        description:
          'Text returned by prompt() when accept is true. Omit for alert() and confirm().',
      },
    },
    required: ['accept'],
    additionalProperties: false,
  },
  saveToAttachments: {
    type: 'boolean',
    description:
      'Whether to also save the browser artifact to worktree attachments.',
  },
  inputType: {
    type: 'string',
    minLength: 1,
    description:
      'For browser.input_snapshot, an exact case-insensitive HTML input type filter.',
  },
  role: {
    type: 'string',
    minLength: 1,
    description:
      'For browser.input_snapshot, an exact case-insensitive semantic role filter.',
  },
  name: {
    type: 'string',
    minLength: 1,
    description:
      'For browser.input_snapshot, a fuzzy case-insensitive accessible name, text, or placeholder filter.',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    description:
      'For browser.input_snapshot or browser.list_transfers, the zero-based pagination offset.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description:
      'For browser.input_snapshot or browser.list_transfers, the page size. Defaults to 25; maximum 100.',
  },
};

/** The browser family's advertised DispatchAction payload schema. */
export const browserDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: BROWSER_DISPATCH_JSON_PROPERTIES,
  allOf: [
    ...mcpBrowserDispatchJsonSchemaRules(),
    ...browserTransferJsonSchemaRules(),
  ],
};
