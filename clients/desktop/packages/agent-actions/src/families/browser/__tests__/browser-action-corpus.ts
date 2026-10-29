/** Stable, test-only inputs for the pre-refactor browser action contracts. */
export interface BrowserActionCase {
  id: string;
  action: Record<string, unknown> & { type: string };
}

export type BrowserActionRendererDecision = boolean | 'not-handled';

export interface BrowserActionValidatorDecisions {
  mcp: boolean;
  advisor: boolean;
  renderer: BrowserActionRendererDecision;
}

export interface BrowserActionEffectiveRoutes {
  mcp: boolean;
  advisor: boolean | 'not-handled';
}

export interface BrowserActionDecisionCase extends BrowserActionCase {
  before: BrowserActionValidatorDecisions;
  after: BrowserActionValidatorDecisions;
  effectiveRoutes: {
    before: BrowserActionEffectiveRoutes;
    after: BrowserActionEffectiveRoutes;
  };
  note?: string;
}

const generation = { expectedRuntimeGeneration: 1 };
const named = { kind: 'named', profileId: 'work-profile' };
const selectValuesAtLimit = Array.from(
  { length: 50 },
  (_, index) => `value-${index}`,
);
const typeTextAtLimit = 't'.repeat(4_000);
const typeTextOverLimit = 't'.repeat(4_001);
const maxSelectorValue = 'v'.repeat(500);
const overlongSelectorValue = 'v'.repeat(501);
const maxSearchText = 's'.repeat(200);
const overlongSearchText = 's'.repeat(201);

const browserActionCorpusCases = [
  {
    id: 'valid-profile-preview-clear',
    action: {
      type: 'browser.profile.preview_clear',
      profileId: 'work-profile',
      storageGeneration: 1,
      metadataRevision: 1,
      operation: { kind: 'cache' },
    },
  },
  {
    id: 'valid-profile-clear',
    action: {
      type: 'browser.profile.clear',
      operationId: 'op',
      token: 'token',
    },
  },
  {
    id: 'valid-profile-job-get',
    action: { type: 'browser.profile.job_get', jobId: 'job' },
  },
  {
    id: 'valid-profile-job-cancel',
    action: { type: 'browser.profile.job_cancel', jobId: 'job' },
  },
  {
    id: 'valid-profile-list',
    action: { type: 'browser.profile.list', offset: 0 },
  },
  {
    id: 'valid-profile-get',
    action: { type: 'browser.profile.get', profileId: 'work-profile' },
  },
  {
    id: 'valid-profile-switch',
    action: {
      type: 'browser.profile.switch',
      operationId: 'op',
      browserId: 'tab',
      ...generation,
      selection: named,
      mode: 'replace',
    },
  },
  { id: 'valid-list', action: { type: 'browser.list' } },
  {
    id: 'valid-open',
    action: {
      type: 'browser.open',
      url: 'https://example.test',
      selection: named,
    },
  },
  {
    id: 'valid-navigate',
    action: {
      type: 'browser.navigate',
      ...generation,
      url: 'https://example.test',
    },
  },
  { id: 'valid-back', action: { type: 'browser.back', ...generation } },
  { id: 'valid-forward', action: { type: 'browser.forward', ...generation } },
  { id: 'valid-reload', action: { type: 'browser.reload', ...generation } },
  { id: 'valid-stop', action: { type: 'browser.stop', ...generation } },
  {
    id: 'valid-get-dialog',
    action: { type: 'browser.get_dialog', ...generation },
  },
  {
    id: 'valid-handle-dialog',
    action: {
      type: 'browser.handle_dialog',
      ...generation,
      dialogId: 'dialog',
      accept: true,
    },
  },
  {
    id: 'valid-click',
    action: { type: 'browser.click', ...generation, ref: 'button' },
  },
  {
    id: 'valid-fill',
    action: {
      type: 'browser.fill',
      ...generation,
      locator: '#input',
      text: 'hello',
    },
  },
  {
    id: 'valid-press',
    action: { type: 'browser.press', ...generation, key: 'Enter' },
  },
  {
    id: 'valid-screenshot',
    action: {
      type: 'browser.screenshot',
      ...generation,
      saveToAttachments: true,
    },
  },
  {
    id: 'valid-input-snapshot',
    action: {
      type: 'browser.input_snapshot',
      ...generation,
      role: 'textbox',
      limit: 1,
    },
  },
  {
    id: 'valid-inspect',
    action: { type: 'browser.inspect', ...generation, x: 10, y: 20 },
  },
  {
    id: 'valid-get-console',
    action: { type: 'browser.get_console', ...generation, level: 'error' },
  },
  {
    id: 'valid-get-network',
    action: { type: 'browser.get_network', ...generation, status: 200 },
  },
  {
    id: 'valid-start-recording',
    action: { type: 'browser.start_recording', ...generation },
  },
  {
    id: 'valid-stop-recording',
    action: {
      type: 'browser.stop_recording',
      ...generation,
      saveToAttachments: false,
    },
  },
  {
    id: 'valid-open-external',
    action: {
      type: 'browser.open_external',
      ...generation,
      url: 'https://example.test',
    },
  },

  {
    id: 'click-x-without-y',
    action: { type: 'browser.click', ...generation, x: 4 },
  },
  {
    id: 'inspect-y-without-x',
    action: { type: 'browser.inspect', ...generation, y: 4 },
  },
  {
    id: 'click-ref-and-locator',
    action: { type: 'browser.click', ...generation, ref: 'r', locator: '#r' },
  },
  {
    id: 'inspect-ref-and-locator',
    action: { type: 'browser.inspect', ...generation, ref: 'r', locator: '#r' },
  },
  {
    id: 'click-whitespace-ref',
    action: { type: 'browser.click', ...generation, ref: ' ' },
  },
  {
    id: 'click-empty-ref',
    action: { type: 'browser.click', ...generation, ref: '' },
  },
  {
    id: 'fill-empty-ref',
    action: { type: 'browser.fill', ...generation, ref: '', text: 'text' },
  },
  {
    id: 'fill-whitespace-ref',
    action: { type: 'browser.fill', ...generation, ref: ' ', text: 'text' },
  },
  {
    id: 'click-three-targets',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'r',
      locator: '#r',
      x: 1,
      y: 2,
    },
  },
  { id: 'click-no-target', action: { type: 'browser.click', ...generation } },
  {
    id: 'inspect-no-target',
    action: { type: 'browser.inspect', ...generation },
  },
  {
    id: 'fill-no-target',
    action: { type: 'browser.fill', ...generation, text: 'text' },
  },
  {
    id: 'fill-two-targets',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'r',
      locator: '#r',
      text: 'text',
    },
  },
  {
    id: 'fill-extra-dialog-response',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'r',
      text: 'text',
      dialogResponse: { accept: true },
    },
  },
  {
    id: 'inspect-extra-dialog-response',
    action: {
      type: 'browser.inspect',
      ...generation,
      ref: 'r',
      dialogResponse: { accept: true },
    },
  },
  {
    id: 'navigate-extra-dialog-response',
    action: {
      type: 'browser.navigate',
      ...generation,
      url: 'https://example.test',
      dialogResponse: { accept: true },
    },
  },
  {
    id: 'handle-dialog-no-accept',
    action: {
      type: 'browser.handle_dialog',
      ...generation,
      dialogId: 'dialog',
    },
  },
  {
    id: 'handle-dialog-no-id',
    action: { type: 'browser.handle_dialog', ...generation, accept: true },
  },
  {
    id: 'navigate-no-url',
    action: { type: 'browser.navigate', ...generation },
  },
  {
    id: 'fill-empty-text',
    action: { type: 'browser.fill', ...generation, ref: 'r', text: '' },
  },
  {
    id: 'press-two-targets',
    action: {
      type: 'browser.press',
      ...generation,
      key: 'Enter',
      ref: 'r',
      locator: '#r',
    },
  },
  {
    id: 'open-selection',
    action: { type: 'browser.open', selection: { kind: 'task' } },
  },
  {
    id: 'switch-selection',
    action: {
      type: 'browser.profile.switch',
      operationId: 'op',
      browserId: 'tab',
      ...generation,
      selection: { kind: 'task' },
      mode: 'new-tab',
    },
  },
  {
    id: 'back-extra-selection',
    action: { type: 'browser.back', ...generation, selection: named },
  },
  {
    id: 'click-extra-selection',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'r',
      selection: named,
    },
  },
  {
    id: 'open-selection-extra-key',
    action: { type: 'browser.open', selection: { ...named, extra: true } },
  },
  {
    id: 'switch-selection-extra-key',
    action: {
      type: 'browser.profile.switch',
      operationId: 'op',
      browserId: 'tab',
      ...generation,
      selection: { ...named, extra: true },
      mode: 'replace',
    },
  },
  {
    id: 'fractional-network-status',
    action: { type: 'browser.get_network', ...generation, status: 200.5 },
  },
  {
    id: 'dialog-prompt-too-long',
    action: {
      type: 'browser.handle_dialog',
      ...generation,
      dialogId: 'dialog',
      accept: true,
      promptText: 'x'.repeat(10_001),
    },
  },
  {
    id: 'supplied-scope-pair',
    action: {
      type: 'browser.back',
      ...generation,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  },
  {
    id: 'supplied-project-only',
    action: { type: 'browser.back', ...generation, projectId: 'project-1' },
  },
  {
    id: 'supplied-worktree-only',
    action: { type: 'browser.back', ...generation, worktreeId: 'worktree-1' },
  },
  {
    id: 'open-browser-id-no-generation',
    action: { type: 'browser.open', browserId: 'tab' },
  },
  { id: 'back-no-generation', action: { type: 'browser.back' } },
  {
    id: 'click-no-target-with-generation',
    action: { type: 'browser.click', ...generation },
  },
  {
    id: 'click-whitespace-ref-with-generation',
    action: { type: 'browser.click', ...generation, ref: ' ' },
  },
  {
    id: 'click-x-ref-no-y',
    action: { type: 'browser.click', ...generation, x: 4, ref: 'r' },
  },
  {
    id: 'profile-empty-ids',
    action: { type: 'browser.profile.clear', operationId: '', token: '' },
  },
  {
    id: 'input-snapshot-empty-filter',
    action: { type: 'browser.input_snapshot', ...generation, role: '' },
  },
  {
    id: 'press-empty-key',
    action: { type: 'browser.press', ...generation, key: '' },
  },
  {
    id: 'click-coordinate-force',
    action: { type: 'browser.click', ...generation, x: 10, y: 20, force: true },
  },
  {
    id: 'click-coordinate-force-false',
    action: {
      type: 'browser.click',
      ...generation,
      x: 10,
      y: 20,
      force: false,
    },
  },
  {
    id: 'click-position',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: 10, y: 20 },
    },
  },
  {
    id: 'click-position-force-false',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: 10, y: 20 },
      force: false,
    },
  },
  {
    id: 'click-position-missing-y',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: 10 },
    },
  },
  {
    id: 'click-position-negative',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: -1, y: 20 },
    },
  },
  {
    id: 'click-position-extra-key',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: 10, y: 20, extra: true },
    },
  },
  {
    id: 'click-position-infinite',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: Number.POSITIVE_INFINITY, y: 20 },
    },
  },
  {
    id: 'click-button-middle',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      button: 'middle',
    },
  },
  {
    id: 'click-button-invalid',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      button: 'top',
    },
  },
  {
    id: 'click-count-minimum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      clickCount: 1,
    },
  },
  {
    id: 'click-count-maximum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      clickCount: 3,
    },
  },
  {
    id: 'click-count-zero',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      clickCount: 0,
    },
  },
  {
    id: 'click-count-too-large',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      clickCount: 4,
    },
  },
  {
    id: 'click-count-fractional',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      clickCount: 1.5,
    },
  },
  {
    id: 'click-modifiers-maximum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      modifiers: ['Alt', 'Control', 'Meta', 'Shift'],
    },
  },
  {
    id: 'click-modifiers-duplicate',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      modifiers: ['Alt', 'Alt'],
    },
  },
  {
    id: 'click-modifier-invalid',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      modifiers: ['Command'],
    },
  },
  {
    id: 'click-modifiers-too-many',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      modifiers: ['Alt', 'Control', 'Meta', 'Shift', 'Alt'],
    },
  },
  {
    id: 'click-action-id-trimmed',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      actionId: ' click-save ',
    },
  },
  {
    id: 'click-action-id-empty',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      actionId: '',
    },
  },
  {
    id: 'click-action-id-whitespace',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      actionId: '   ',
    },
  },
  {
    id: 'click-action-id-maximum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      actionId: 'a'.repeat(128),
    },
  },
  {
    id: 'click-action-id-too-long',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      actionId: 'a'.repeat(129),
    },
  },
  {
    id: 'click-timeout-minimum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      timeoutMs: 1,
    },
  },
  {
    id: 'click-timeout-maximum',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'click-timeout-zero',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      timeoutMs: 0,
    },
  },
  {
    id: 'click-timeout-too-large',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      timeoutMs: 60_001,
    },
  },
  {
    id: 'click-timeout-fractional',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      timeoutMs: 1.5,
    },
  },
  {
    id: 'fill-timeout-valid',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'field',
      text: 'value',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'fill-timeout-fractional',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'field',
      text: 'value',
      timeoutMs: 1.5,
    },
  },
  {
    id: 'press-timeout-valid',
    action: {
      type: 'browser.press',
      ...generation,
      key: 'Enter',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'press-timeout-fractional',
    action: {
      type: 'browser.press',
      ...generation,
      key: 'Enter',
      timeoutMs: 1.5,
    },
  },
  {
    id: 'valid-focus',
    action: {
      type: 'browser.focus',
      ...generation,
      ref: 'button',
      actionId: 'focus',
    },
  },
  {
    id: 'focus-by-locator',
    action: {
      type: 'browser.focus',
      ...generation,
      locator: 'button[title="Save"]',
      actionId: 'focus-save',
    },
  },
  {
    id: 'focus-no-target',
    action: { type: 'browser.focus', ...generation, actionId: 'focus' },
  },
  {
    id: 'focus-two-targets',
    action: {
      type: 'browser.focus',
      ...generation,
      ref: 'button',
      locator: 'button',
      actionId: 'focus',
    },
  },
  {
    id: 'focus-whitespace-target',
    action: {
      type: 'browser.focus',
      ...generation,
      locator: '   ',
      actionId: 'focus',
    },
  },
  {
    id: 'focus-action-id-empty',
    action: {
      type: 'browser.focus',
      ...generation,
      ref: 'button',
      actionId: '',
    },
  },
  {
    id: 'press-whitespace-key',
    action: { type: 'browser.press', ...generation, key: '   ' },
  },
  {
    id: 'fill-whitespace-text',
    action: { type: 'browser.fill', ...generation, ref: 'field', text: '   ' },
  },
  {
    id: 'input-snapshot-whitespace-name',
    action: {
      type: 'browser.input_snapshot',
      ...generation,
      name: '   ',
    },
  },
  {
    id: 'input-snapshot-empty-name',
    action: {
      type: 'browser.input_snapshot',
      ...generation,
      name: '',
    },
  },
  {
    id: 'profile-whitespace-ids',
    action: {
      type: 'browser.profile.clear',
      operationId: ' ',
      token: ' ',
    },
  },
  {
    id: 'valid-wait-for',
    action: {
      type: 'browser.wait_for',
      ...generation,
      locator: 'button[title="Save"]',
      state: 'visible',
      actionId: 'wait-save',
    },
  },
  {
    id: 'wait-for-text-hidden',
    action: {
      type: 'browser.wait_for',
      ...generation,
      text: 'Saved',
      state: 'hidden',
      actionId: 'wait-saved',
    },
  },
  {
    id: 'wait-for-url',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      actionId: 'wait-settings',
    },
  },
  {
    id: 'wait-for-load-state',
    action: {
      type: 'browser.wait_for',
      ...generation,
      loadState: 'domcontentloaded',
      actionId: 'wait-load',
    },
  },
  {
    id: 'wait-for-no-condition',
    action: { type: 'browser.wait_for', ...generation, actionId: 'wait' },
  },
  {
    id: 'wait-for-multiple-conditions',
    action: {
      type: 'browser.wait_for',
      ...generation,
      locator: 'button',
      text: 'Saved',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-state-on-url',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      state: 'visible',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-state-on-load-state',
    action: {
      type: 'browser.wait_for',
      ...generation,
      loadState: 'load',
      state: 'visible',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-invalid-state',
    action: {
      type: 'browser.wait_for',
      ...generation,
      locator: 'button',
      state: 'disabled',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-invalid-load-state',
    action: {
      type: 'browser.wait_for',
      ...generation,
      loadState: 'idle',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-whitespace-url',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '   ',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-whitespace-text',
    action: {
      type: 'browser.wait_for',
      ...generation,
      text: '   ',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-whitespace-locator',
    action: {
      type: 'browser.wait_for',
      ...generation,
      locator: '   ',
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-timeout-minimum',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      timeoutMs: 1,
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-timeout-maximum',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      timeoutMs: 120_000,
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-timeout-zero',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      timeoutMs: 0,
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-timeout-too-large',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      timeoutMs: 120_001,
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-timeout-fractional',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      timeoutMs: 1.5,
      actionId: 'wait',
    },
  },
  {
    id: 'wait-for-action-id-whitespace',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      actionId: '   ',
    },
  },
  {
    id: 'wait-for-action-id-too-long',
    action: {
      type: 'browser.wait_for',
      ...generation,
      url: '**/settings',
      actionId: 'a'.repeat(129),
    },
  },
  {
    id: 'task-selection-extra-key',
    action: {
      type: 'browser.open',
      selection: { kind: 'task', extra: true },
    },
  },
  {
    id: 'v8-ui-only-click-fields',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      button: 'left',
      focus: true,
      focused: false,
    },
  },
  {
    id: 'back-invalid-runtime-generation',
    action: { type: 'browser.back', expectedRuntimeGeneration: 0 },
  },
  {
    id: 'click-position-with-xy',
    action: {
      type: 'browser.click',
      ...generation,
      x: 10,
      y: 20,
      position: { x: 3, y: 5 },
    },
  },
  {
    id: 'click-position-force-true',
    action: {
      type: 'browser.click',
      ...generation,
      ref: 'button',
      position: { x: 3, y: 5 },
      force: true,
    },
  },
  {
    id: 'focus-timeout-maximum',
    action: {
      type: 'browser.focus',
      ...generation,
      ref: 'button',
      actionId: 'focus',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'focus-timeout-too-large',
    action: {
      type: 'browser.focus',
      ...generation,
      ref: 'button',
      actionId: 'focus',
      timeoutMs: 60_001,
    },
  },
  {
    id: 'fill-action-id-valid',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'field',
      text: 'value',
      actionId: 'fill-value',
    },
  },
  {
    id: 'fill-action-id-empty',
    action: {
      type: 'browser.fill',
      ...generation,
      ref: 'field',
      text: 'value',
      actionId: '',
    },
  },
  {
    id: 'press-action-id-valid',
    action: {
      type: 'browser.press',
      ...generation,
      key: 'Enter',
      actionId: 'press-enter',
    },
  },
  {
    id: 'press-action-id-empty',
    action: {
      type: 'browser.press',
      ...generation,
      key: 'Enter',
      actionId: '',
    },
  },
  {
    id: 'click-position-no-target',
    action: {
      type: 'browser.click',
      ...generation,
      position: { x: 10, y: 20 },
    },
  },
  {
    id: 'focus-no-generation',
    action: { type: 'browser.focus', ref: 'r' },
  },
  {
    id: 'wait-for-no-generation',
    action: { type: 'browser.wait_for', text: 'Ready' },
  },
  {
    id: 'frame-locator-stray-coordinates-click',
    action: {
      type: 'browser.click',
      ...generation,
      locator: '#ready',
      frame: 'f-checkout-1',
      x: 1,
      y: 2,
    },
  },
  {
    id: 'frame-locator-stray-coordinates-inspect',
    action: {
      type: 'browser.inspect',
      ...generation,
      locator: '#ready',
      frame: 'f-checkout-1',
      x: 1,
      y: 2,
    },
  },
  {
    id: 'frame-locator-stray-coordinates-fill',
    action: {
      type: 'browser.fill',
      ...generation,
      locator: '#ready',
      frame: 'f-checkout-1',
      x: 1,
      y: 2,
      text: '',
    },
  },
  {
    id: 'frame-locator-stray-coordinates-press',
    action: {
      type: 'browser.press',
      ...generation,
      locator: '#ready',
      frame: 'f-checkout-1',
      x: 1,
      y: 2,
      key: 'Enter',
    },
  },
  {
    id: 'frame-locator-stray-coordinates-focus',
    action: {
      type: 'browser.focus',
      ...generation,
      locator: '#ready',
      frame: 'f-checkout-1',
      x: 1,
      y: 2,
    },
  },
  {
    id: 'phase06-valid-set-checked-ref',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: false,
      actionId: '  checked-action  ',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'phase06-valid-set-checked-locator-frame',
    action: {
      type: 'browser.set_checked',
      ...generation,
      locator: 'input[type=checkbox]',
      frame: 'checkout-frame',
      checked: true,
      timeoutMs: 1,
    },
  },
  {
    id: 'phase06-valid-select-empty-value',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: [''],
    },
  },
  {
    id: 'phase06-valid-select-value-max-length',
    action: {
      type: 'browser.select_option',
      ...generation,
      locator: 'select[name=country]',
      frame: 'checkout-frame',
      values: [maxSelectorValue],
    },
  },
  {
    id: 'phase06-valid-select-label-boundaries',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: ['x', maxSelectorValue],
      searchText: 'United',
    },
  },
  {
    id: 'phase06-valid-select-index-boundaries',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: [0, 9_999],
      searchText: 'A',
    },
  },
  {
    id: 'phase06-valid-select-maximum-size',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: selectValuesAtLimit,
    },
  },
  {
    id: 'phase06-valid-select-search-text-maximum',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: ['Country'],
      searchText: maxSearchText,
      actionId: 'select-action',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'phase06-valid-type-untargeted',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'Hello',
      delayMs: 0,
    },
  },
  {
    id: 'phase06-valid-type-targeted-frame',
    action: {
      type: 'browser.type',
      ...generation,
      locator: 'input[name=search]',
      frame: 'checkout-frame',
      text: 'search text',
      delayMs: 500,
    },
  },
  {
    id: 'phase06-valid-type-text-budget-maximum',
    action: {
      type: 'browser.type',
      ...generation,
      text: typeTextAtLimit,
      delayMs: 0,
    },
  },
  {
    id: 'phase06-valid-type-high-delay-budget-boundary',
    action: {
      type: 'browser.type',
      ...generation,
      ref: 'search',
      text: 't'.repeat(100),
      delayMs: 500,
      actionId: 'type-action',
      timeoutMs: 60_000,
    },
  },
  {
    id: 'phase06-set-checked-missing-target',
    action: {
      type: 'browser.set_checked',
      ...generation,
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-missing-state',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
    },
  },
  {
    id: 'phase06-set-checked-invalid-state',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: 'true',
    },
  },
  {
    id: 'phase06-set-checked-two-targets',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      locator: 'input[type=checkbox]',
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-whitespace-ref',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: ' ',
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-frame-with-ref',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      frame: 'frame',
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-frame-without-locator',
    action: {
      type: 'browser.set_checked',
      ...generation,
      frame: 'frame',
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-empty-frame',
    action: {
      type: 'browser.set_checked',
      ...generation,
      locator: '#checkbox',
      frame: '',
      checked: true,
    },
  },
  {
    id: 'phase06-set-checked-known-stray-field',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: true,
      force: false,
    },
  },
  {
    id: 'phase06-set-checked-unknown-field',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: true,
      unknownField: true,
    },
  },
  {
    id: 'phase06-set-checked-empty-action-id',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: true,
      actionId: ' ',
    },
  },
  {
    id: 'phase06-set-checked-long-timeout',
    action: {
      type: 'browser.set_checked',
      ...generation,
      ref: 'checkbox',
      checked: true,
      timeoutMs: 60_001,
    },
  },
  {
    id: 'phase06-select-no-target',
    action: {
      type: 'browser.select_option',
      ...generation,
      values: ['value'],
    },
  },
  {
    id: 'phase06-select-frame-with-ref',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      frame: 'checkout-frame',
      values: ['value'],
    },
  },
  {
    id: 'phase06-select-frame-without-locator',
    action: {
      type: 'browser.select_option',
      ...generation,
      frame: 'checkout-frame',
      values: ['value'],
    },
  },
  {
    id: 'phase06-select-values-not-array',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: 'value',
    },
  },
  {
    id: 'phase06-select-label-wrong-entry-type',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: [true],
    },
  },
  {
    id: 'phase06-select-index-wrong-entry-type',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: ['0'],
    },
  },
  {
    id: 'phase06-select-two-targets',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      locator: 'select[name=country]',
      values: ['value'],
    },
  },
  {
    id: 'phase06-select-no-choice',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
    },
  },
  {
    id: 'phase06-select-multiple-choices',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      labels: ['label'],
    },
  },
  {
    id: 'phase06-select-empty-values-array',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: [],
    },
  },
  {
    id: 'phase06-select-empty-labels-array',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: [],
    },
  },
  {
    id: 'phase06-select-empty-indexes-array',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: [],
    },
  },
  {
    id: 'phase06-select-too-many-values',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: [...selectValuesAtLimit, 'overflow'],
    },
  },
  {
    id: 'phase06-select-too-many-labels',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: Array.from({ length: 51 }, (_, index) => `label-${index}`),
    },
  },
  {
    id: 'phase06-select-too-many-indexes',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: Array.from({ length: 51 }, (_, index) => index),
    },
  },
  {
    id: 'phase06-select-overlong-value',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: [overlongSelectorValue],
    },
  },
  {
    id: 'phase06-select-empty-label',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: [''],
    },
  },
  {
    id: 'phase06-select-overlong-label',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      labels: [overlongSelectorValue],
    },
  },
  {
    id: 'phase06-select-negative-index',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: [-1],
    },
  },
  {
    id: 'phase06-select-index-over-limit',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: [10_000],
    },
  },
  {
    id: 'phase06-select-fractional-index',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      indexes: [1.5],
    },
  },
  {
    id: 'phase06-select-empty-search-text',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      searchText: '',
    },
  },
  {
    id: 'phase06-select-overlong-search-text',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      searchText: overlongSearchText,
    },
  },
  {
    id: 'phase06-select-known-stray-field',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      checked: true,
    },
  },
  {
    id: 'phase06-select-unknown-field',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      unknownField: true,
    },
  },
  {
    id: 'phase06-select-long-action-id',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      actionId: 'a'.repeat(129),
    },
  },
  {
    id: 'phase06-select-fractional-timeout',
    action: {
      type: 'browser.select_option',
      ...generation,
      ref: 'country',
      values: ['value'],
      timeoutMs: 1.5,
    },
  },
  {
    id: 'phase06-type-missing-text',
    action: {
      type: 'browser.type',
      ...generation,
    },
  },
  {
    id: 'phase06-type-empty-text',
    action: {
      type: 'browser.type',
      ...generation,
      text: '',
    },
  },
  {
    id: 'phase06-type-overlong-text',
    action: {
      type: 'browser.type',
      ...generation,
      text: typeTextOverLimit,
    },
  },
  {
    id: 'phase06-type-negative-delay',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'a',
      delayMs: -1,
    },
  },
  {
    id: 'phase06-type-delay-over-limit',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'a',
      delayMs: 501,
    },
  },
  {
    id: 'phase06-type-fractional-delay',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'a',
      delayMs: 0.5,
    },
  },
  {
    id: 'phase06-type-over-budget-short-delay',
    action: {
      type: 'browser.type',
      ...generation,
      text: typeTextAtLimit,
      delayMs: 1,
    },
  },
  {
    id: 'phase06-type-over-budget-high-delay',
    action: {
      type: 'browser.type',
      ...generation,
      text: 't'.repeat(101),
      delayMs: 500,
    },
  },
  {
    id: 'phase06-type-frame-without-locator',
    action: {
      type: 'browser.type',
      ...generation,
      frame: 'frame',
      text: 'text',
    },
  },
  {
    id: 'phase06-type-two-targets',
    action: {
      type: 'browser.type',
      ...generation,
      ref: 'field',
      locator: '#field',
      text: 'text',
    },
  },
  {
    id: 'phase06-type-frame-with-ref',
    action: {
      type: 'browser.type',
      ...generation,
      ref: 'field',
      frame: 'frame',
      text: 'text',
    },
  },
  {
    id: 'phase06-type-whitespace-locator',
    action: {
      type: 'browser.type',
      ...generation,
      locator: ' ',
      text: 'text',
    },
  },
  {
    id: 'phase06-type-whitespace-frame',
    action: {
      type: 'browser.type',
      ...generation,
      locator: '#field',
      frame: ' ',
      text: 'text',
    },
  },
  {
    id: 'phase06-type-known-stray-field',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'text',
      force: false,
    },
  },
  {
    id: 'phase06-type-unknown-field',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'text',
      unknownField: true,
    },
  },
  {
    id: 'phase06-type-timeout-zero',
    action: {
      type: 'browser.type',
      ...generation,
      text: 'text',
      timeoutMs: 0,
    },
  },
] as const satisfies readonly BrowserActionCase[];

export const browserActionCorpus: readonly BrowserActionCase[] =
  browserActionCorpusCases;

type BrowserActionCorpusId = (typeof browserActionCorpusCases)[number]['id'];

function decisions(
  mcp: boolean,
  advisor: boolean,
  renderer: BrowserActionRendererDecision,
): BrowserActionValidatorDecisions {
  return { mcp, advisor, renderer };
}

function effectiveRoutes(
  validation: BrowserActionValidatorDecisions,
): BrowserActionEffectiveRoutes {
  return {
    mcp: validation.mcp,
    advisor:
      validation.advisor === false
        ? false
        : validation.renderer === 'not-handled'
          ? 'not-handled'
          : validation.renderer && validation.advisor,
  };
}

const accept = decisions(true, true, true);
const reject = decisions(false, false, false);
const mcpRejects = decisions(false, true, true);
const mcpOnly = decisions(true, false, false);
const mcpAdvisorRejects = decisions(true, false, true);
const advisorOnly = decisions(false, true, true);
const advisorRejected = decisions(false, false, false);
const profileAccept = decisions(true, true, 'not-handled');
const profileMcpRejects = decisions(false, true, 'not-handled');
const profileAdvisorRejects = decisions(false, false, 'not-handled');
const mcpRendererRejects = decisions(false, true, false);
const advisorRendererRejects = decisions(true, true, false);

const beforeDecisions: Readonly<
  Record<BrowserActionCorpusId, BrowserActionValidatorDecisions>
> = {
  'frame-locator-stray-coordinates-click': reject,
  'frame-locator-stray-coordinates-inspect': reject,
  'frame-locator-stray-coordinates-fill': accept,
  'frame-locator-stray-coordinates-press': accept,
  'frame-locator-stray-coordinates-focus': accept,
  'valid-profile-preview-clear': profileAccept,
  'valid-profile-clear': profileAccept,
  'valid-profile-job-get': profileAccept,
  'valid-profile-job-cancel': profileAccept,
  'valid-profile-list': profileAccept,
  'valid-profile-get': profileAccept,
  'valid-profile-switch': profileAccept,
  'valid-list': accept,
  'valid-open': accept,
  'valid-navigate': accept,
  'valid-back': accept,
  'valid-forward': accept,
  'valid-reload': accept,
  'valid-stop': accept,
  'valid-get-dialog': accept,
  'valid-handle-dialog': accept,
  'valid-click': accept,
  'valid-fill': accept,
  'valid-press': accept,
  'valid-screenshot': accept,
  'valid-input-snapshot': accept,
  'valid-inspect': accept,
  'valid-get-console': accept,
  'valid-get-network': accept,
  'valid-start-recording': accept,
  'valid-stop-recording': accept,
  'valid-open-external': accept,
  'click-x-without-y': mcpRendererRejects,
  'inspect-y-without-x': mcpRendererRejects,
  'click-ref-and-locator': mcpRendererRejects,
  'inspect-ref-and-locator': mcpRendererRejects,
  'click-whitespace-ref': decisions(false, true, true),
  'click-empty-ref': mcpRendererRejects,
  'fill-empty-ref': mcpRendererRejects,
  'fill-whitespace-ref': decisions(false, true, true),
  'click-three-targets': mcpRendererRejects,
  'click-no-target': mcpRendererRejects,
  'inspect-no-target': mcpRendererRejects,
  'fill-no-target': mcpRendererRejects,
  'fill-two-targets': mcpRendererRejects,
  'fill-extra-dialog-response': accept,
  'inspect-extra-dialog-response': accept,
  'navigate-extra-dialog-response': accept,
  'handle-dialog-no-accept': reject,
  'handle-dialog-no-id': reject,
  'navigate-no-url': reject,
  'fill-empty-text': advisorRendererRejects,
  'press-two-targets': decisions(false, true, false),
  'open-selection': accept,
  'switch-selection': profileAccept,
  'back-extra-selection': decisions(false, true, true),
  'click-extra-selection': decisions(false, true, true),
  'open-selection-extra-key': decisions(false, true, true),
  'switch-selection-extra-key': profileMcpRejects,
  'fractional-network-status': decisions(false, false, true),
  'dialog-prompt-too-long': decisions(false, false, true),
  'supplied-scope-pair': accept,
  'supplied-project-only': decisions(true, true, false),
  'supplied-worktree-only': decisions(true, true, false),
  'open-browser-id-no-generation': mcpAdvisorRejects,
  'back-no-generation': mcpAdvisorRejects,
  'click-no-target-with-generation': mcpRendererRejects,
  'click-whitespace-ref-with-generation': decisions(false, true, true),
  'click-x-ref-no-y': decisions(false, true, false),
  'profile-empty-ids': profileMcpRejects,
  'input-snapshot-empty-filter': mcpRejects,
  'press-empty-key': decisions(true, true, false),
  'click-coordinate-force': accept,
  'click-coordinate-force-false': accept,
  'click-position': accept,
  'click-position-force-false': accept,
  'click-position-missing-y': accept,
  'click-position-negative': accept,
  'click-position-extra-key': accept,
  'click-position-infinite': accept,
  'click-button-middle': accept,
  'click-button-invalid': accept,
  'click-count-minimum': accept,
  'click-count-maximum': accept,
  'click-count-zero': accept,
  'click-count-too-large': accept,
  'click-count-fractional': accept,
  'click-modifiers-maximum': accept,
  'click-modifiers-duplicate': accept,
  'click-modifier-invalid': accept,
  'click-modifiers-too-many': accept,
  'click-action-id-trimmed': accept,
  'click-action-id-empty': accept,
  'click-action-id-whitespace': accept,
  'click-action-id-maximum': accept,
  'click-action-id-too-long': accept,
  'click-timeout-minimum': accept,
  'click-timeout-maximum': accept,
  'click-timeout-zero': accept,
  'click-timeout-too-large': accept,
  'click-timeout-fractional': accept,
  'fill-timeout-valid': accept,
  'fill-timeout-fractional': accept,
  'press-timeout-valid': accept,
  'press-timeout-fractional': accept,
  'valid-focus': reject,
  'focus-by-locator': reject,
  'focus-no-target': reject,
  'focus-two-targets': reject,
  'focus-whitespace-target': reject,
  'focus-action-id-empty': reject,
  'valid-wait-for': reject,
  'wait-for-text-hidden': reject,
  'wait-for-url': reject,
  'wait-for-load-state': reject,
  'wait-for-no-condition': reject,
  'wait-for-multiple-conditions': reject,
  'wait-for-state-on-url': reject,
  'wait-for-state-on-load-state': reject,
  'wait-for-invalid-state': reject,
  'wait-for-invalid-load-state': reject,
  'wait-for-whitespace-url': reject,
  'wait-for-whitespace-text': reject,
  'wait-for-whitespace-locator': reject,
  'wait-for-timeout-minimum': reject,
  'wait-for-timeout-maximum': reject,
  'wait-for-timeout-zero': reject,
  'wait-for-timeout-too-large': reject,
  'wait-for-timeout-fractional': reject,
  'wait-for-action-id-whitespace': reject,
  'wait-for-action-id-too-long': reject,
  'press-whitespace-key': accept,
  'fill-whitespace-text': accept,
  'input-snapshot-whitespace-name': accept,
  'input-snapshot-empty-name': mcpRejects,
  'profile-whitespace-ids': profileAccept,
  'task-selection-extra-key': mcpRejects,
  'v8-ui-only-click-fields': mcpRejects,
  'back-invalid-runtime-generation': decisions(false, false, true),
  'click-position-with-xy': accept,
  'click-position-force-true': accept,
  'focus-timeout-maximum': reject,
  'focus-timeout-too-large': reject,
  'fill-action-id-valid': accept,
  'fill-action-id-empty': accept,
  'press-action-id-valid': accept,
  'press-action-id-empty': accept,
  'click-position-no-target': decisions(false, true, false),
  'focus-no-generation': reject,
  'wait-for-no-generation': reject,
  'phase06-valid-set-checked-ref': reject,
  'phase06-valid-set-checked-locator-frame': reject,
  'phase06-valid-select-empty-value': reject,
  'phase06-valid-select-value-max-length': reject,
  'phase06-valid-select-label-boundaries': reject,
  'phase06-valid-select-index-boundaries': reject,
  'phase06-valid-select-maximum-size': reject,
  'phase06-valid-select-search-text-maximum': reject,
  'phase06-valid-type-untargeted': reject,
  'phase06-valid-type-targeted-frame': reject,
  'phase06-valid-type-text-budget-maximum': reject,
  'phase06-valid-type-high-delay-budget-boundary': reject,
  'phase06-set-checked-missing-target': reject,
  'phase06-set-checked-missing-state': reject,
  'phase06-set-checked-invalid-state': reject,
  'phase06-set-checked-two-targets': reject,
  'phase06-set-checked-whitespace-ref': reject,
  'phase06-set-checked-frame-with-ref': reject,
  'phase06-set-checked-frame-without-locator': reject,
  'phase06-set-checked-empty-frame': reject,
  'phase06-set-checked-known-stray-field': reject,
  'phase06-set-checked-unknown-field': reject,
  'phase06-set-checked-empty-action-id': reject,
  'phase06-set-checked-long-timeout': reject,
  'phase06-select-no-target': reject,
  'phase06-select-frame-with-ref': reject,
  'phase06-select-frame-without-locator': reject,
  'phase06-select-values-not-array': reject,
  'phase06-select-label-wrong-entry-type': reject,
  'phase06-select-index-wrong-entry-type': reject,
  'phase06-select-two-targets': reject,
  'phase06-select-no-choice': reject,
  'phase06-select-multiple-choices': reject,
  'phase06-select-empty-values-array': reject,
  'phase06-select-empty-labels-array': reject,
  'phase06-select-empty-indexes-array': reject,
  'phase06-select-too-many-values': reject,
  'phase06-select-too-many-labels': reject,
  'phase06-select-too-many-indexes': reject,
  'phase06-select-overlong-value': reject,
  'phase06-select-empty-label': reject,
  'phase06-select-overlong-label': reject,
  'phase06-select-negative-index': reject,
  'phase06-select-index-over-limit': reject,
  'phase06-select-fractional-index': reject,
  'phase06-select-empty-search-text': reject,
  'phase06-select-overlong-search-text': reject,
  'phase06-select-known-stray-field': reject,
  'phase06-select-unknown-field': reject,
  'phase06-select-long-action-id': reject,
  'phase06-select-fractional-timeout': reject,
  'phase06-type-missing-text': reject,
  'phase06-type-empty-text': reject,
  'phase06-type-overlong-text': reject,
  'phase06-type-negative-delay': reject,
  'phase06-type-delay-over-limit': reject,
  'phase06-type-fractional-delay': reject,
  'phase06-type-over-budget-short-delay': reject,
  'phase06-type-over-budget-high-delay': reject,
  'phase06-type-frame-without-locator': reject,
  'phase06-type-two-targets': reject,
  'phase06-type-frame-with-ref': reject,
  'phase06-type-whitespace-locator': reject,
  'phase06-type-whitespace-frame': reject,
  'phase06-type-known-stray-field': reject,
  'phase06-type-unknown-field': reject,
  'phase06-type-timeout-zero': reject,
};

const afterDecisions: Readonly<
  Record<BrowserActionCorpusId, BrowserActionValidatorDecisions>
> = {
  'frame-locator-stray-coordinates-click': reject,
  'frame-locator-stray-coordinates-inspect': reject,
  'frame-locator-stray-coordinates-fill': accept,
  'frame-locator-stray-coordinates-press': accept,
  'frame-locator-stray-coordinates-focus': accept,
  'valid-profile-preview-clear': profileAccept,
  'valid-profile-clear': profileAccept,
  'valid-profile-job-get': profileAccept,
  'valid-profile-job-cancel': profileAccept,
  'valid-profile-list': profileAccept,
  'valid-profile-get': profileAccept,
  'valid-profile-switch': profileAccept,
  'valid-list': accept,
  'valid-open': accept,
  'valid-navigate': accept,
  'valid-back': accept,
  'valid-forward': accept,
  'valid-reload': accept,
  'valid-stop': accept,
  'valid-get-dialog': accept,
  'valid-handle-dialog': accept,
  'valid-click': accept,
  'valid-fill': accept,
  'valid-press': accept,
  'valid-screenshot': accept,
  'valid-input-snapshot': accept,
  'valid-inspect': accept,
  'valid-get-console': accept,
  'valid-get-network': accept,
  'valid-start-recording': accept,
  'valid-stop-recording': accept,
  'valid-open-external': accept,
  'click-x-without-y': reject,
  'inspect-y-without-x': reject,
  'click-ref-and-locator': reject,
  'inspect-ref-and-locator': reject,
  'click-whitespace-ref': reject,
  'click-empty-ref': reject,
  'fill-empty-ref': reject,
  'fill-whitespace-ref': reject,
  'click-three-targets': reject,
  'click-no-target': reject,
  'inspect-no-target': reject,
  'fill-no-target': reject,
  'fill-two-targets': reject,
  'fill-extra-dialog-response': accept,
  'inspect-extra-dialog-response': accept,
  'navigate-extra-dialog-response': accept,
  'handle-dialog-no-accept': reject,
  'handle-dialog-no-id': reject,
  'navigate-no-url': reject,
  'fill-empty-text': accept,
  'press-two-targets': reject,
  'open-selection': accept,
  'switch-selection': profileAccept,
  'back-extra-selection': mcpRejects,
  'click-extra-selection': mcpRejects,
  'open-selection-extra-key': reject,
  'switch-selection-extra-key': profileAdvisorRejects,
  'fractional-network-status': reject,
  'dialog-prompt-too-long': reject,
  'supplied-scope-pair': accept,
  'supplied-project-only': decisions(true, false, false),
  'supplied-worktree-only': decisions(true, false, false),
  'open-browser-id-no-generation': mcpOnly,
  'back-no-generation': mcpOnly,
  'click-no-target-with-generation': reject,
  'click-whitespace-ref-with-generation': reject,
  'click-x-ref-no-y': reject,
  'profile-empty-ids': profileAdvisorRejects,
  'input-snapshot-empty-filter': reject,
  'press-empty-key': reject,
  'click-coordinate-force': accept,
  'click-coordinate-force-false': accept,
  'click-position': accept,
  'click-position-force-false': accept,
  'click-position-missing-y': advisorRejected,
  'click-position-negative': advisorRejected,
  'click-position-extra-key': advisorRejected,
  'click-position-infinite': advisorRejected,
  'click-button-middle': accept,
  'click-button-invalid': advisorRejected,
  'click-count-minimum': accept,
  'click-count-maximum': accept,
  'click-count-zero': advisorRejected,
  'click-count-too-large': advisorRejected,
  'click-count-fractional': advisorRejected,
  'click-modifiers-maximum': accept,
  'click-modifiers-duplicate': advisorRejected,
  'click-modifier-invalid': advisorRejected,
  'click-modifiers-too-many': advisorRejected,
  'click-action-id-trimmed': accept,
  'click-action-id-empty': advisorRejected,
  'click-action-id-whitespace': advisorRejected,
  'click-action-id-maximum': accept,
  'click-action-id-too-long': advisorRejected,
  'click-timeout-minimum': accept,
  'click-timeout-maximum': accept,
  'click-timeout-zero': advisorRejected,
  'click-timeout-too-large': advisorRejected,
  'click-timeout-fractional': advisorRejected,
  'fill-timeout-valid': accept,
  'fill-timeout-fractional': advisorRejected,
  'press-timeout-valid': accept,
  'press-timeout-fractional': advisorRejected,
  'valid-focus': accept,
  'focus-by-locator': accept,
  'focus-no-target': advisorRejected,
  'focus-two-targets': advisorRejected,
  'focus-whitespace-target': advisorRejected,
  'focus-action-id-empty': advisorRejected,
  'valid-wait-for': accept,
  'wait-for-text-hidden': accept,
  'wait-for-url': accept,
  'wait-for-load-state': accept,
  'wait-for-no-condition': advisorRejected,
  'wait-for-multiple-conditions': advisorRejected,
  'wait-for-state-on-url': advisorRejected,
  'wait-for-state-on-load-state': advisorRejected,
  'wait-for-invalid-state': advisorRejected,
  'wait-for-invalid-load-state': advisorRejected,
  'wait-for-whitespace-url': advisorRejected,
  'wait-for-whitespace-text': advisorRejected,
  'wait-for-whitespace-locator': advisorRejected,
  'wait-for-timeout-minimum': accept,
  'wait-for-timeout-maximum': accept,
  'wait-for-timeout-zero': advisorRejected,
  'wait-for-timeout-too-large': advisorRejected,
  'wait-for-timeout-fractional': advisorRejected,
  'wait-for-action-id-whitespace': advisorRejected,
  'wait-for-action-id-too-long': advisorRejected,
  'press-whitespace-key': advisorRejected,
  'fill-whitespace-text': accept,
  'input-snapshot-whitespace-name': reject,
  'input-snapshot-empty-name': reject,
  'profile-whitespace-ids': profileAdvisorRejects,
  'task-selection-extra-key': reject,
  'v8-ui-only-click-fields': advisorOnly,
  'back-invalid-runtime-generation': reject,
  'click-position-with-xy': advisorRejected,
  'click-position-force-true': advisorRejected,
  'focus-timeout-maximum': accept,
  'focus-timeout-too-large': advisorRejected,
  'fill-action-id-valid': accept,
  'fill-action-id-empty': advisorRejected,
  'press-action-id-valid': accept,
  'press-action-id-empty': advisorRejected,
  'click-position-no-target': reject,
  'focus-no-generation': mcpOnly,
  'wait-for-no-generation': mcpOnly,
  'phase06-valid-set-checked-ref': accept,
  'phase06-valid-set-checked-locator-frame': accept,
  'phase06-valid-select-empty-value': accept,
  'phase06-valid-select-value-max-length': accept,
  'phase06-valid-select-label-boundaries': accept,
  'phase06-valid-select-index-boundaries': accept,
  'phase06-valid-select-maximum-size': accept,
  'phase06-valid-select-search-text-maximum': accept,
  'phase06-valid-type-untargeted': accept,
  'phase06-valid-type-targeted-frame': accept,
  'phase06-valid-type-text-budget-maximum': accept,
  'phase06-valid-type-high-delay-budget-boundary': accept,
  'phase06-set-checked-missing-target': reject,
  'phase06-set-checked-missing-state': reject,
  'phase06-set-checked-invalid-state': reject,
  'phase06-set-checked-two-targets': reject,
  'phase06-set-checked-whitespace-ref': reject,
  'phase06-set-checked-frame-with-ref': reject,
  'phase06-set-checked-frame-without-locator': reject,
  'phase06-set-checked-empty-frame': reject,
  'phase06-set-checked-known-stray-field': reject,
  'phase06-set-checked-unknown-field': reject,
  'phase06-set-checked-empty-action-id': reject,
  'phase06-set-checked-long-timeout': reject,
  'phase06-select-no-target': reject,
  'phase06-select-frame-with-ref': reject,
  'phase06-select-frame-without-locator': reject,
  'phase06-select-values-not-array': reject,
  'phase06-select-label-wrong-entry-type': reject,
  'phase06-select-index-wrong-entry-type': reject,
  'phase06-select-two-targets': reject,
  'phase06-select-no-choice': reject,
  'phase06-select-multiple-choices': reject,
  'phase06-select-empty-values-array': reject,
  'phase06-select-empty-labels-array': reject,
  'phase06-select-empty-indexes-array': reject,
  'phase06-select-too-many-values': reject,
  'phase06-select-too-many-labels': reject,
  'phase06-select-too-many-indexes': reject,
  'phase06-select-overlong-value': reject,
  'phase06-select-empty-label': reject,
  'phase06-select-overlong-label': reject,
  'phase06-select-negative-index': reject,
  'phase06-select-index-over-limit': reject,
  'phase06-select-fractional-index': reject,
  'phase06-select-empty-search-text': reject,
  'phase06-select-overlong-search-text': reject,
  'phase06-select-known-stray-field': reject,
  'phase06-select-unknown-field': reject,
  'phase06-select-long-action-id': reject,
  'phase06-select-fractional-timeout': reject,
  'phase06-type-missing-text': reject,
  'phase06-type-empty-text': reject,
  'phase06-type-overlong-text': reject,
  'phase06-type-negative-delay': reject,
  'phase06-type-delay-over-limit': reject,
  'phase06-type-fractional-delay': reject,
  'phase06-type-over-budget-short-delay': reject,
  'phase06-type-over-budget-high-delay': reject,
  'phase06-type-frame-without-locator': reject,
  'phase06-type-two-targets': reject,
  'phase06-type-frame-with-ref': reject,
  'phase06-type-whitespace-locator': reject,
  'phase06-type-whitespace-frame': reject,
  'phase06-type-known-stray-field': reject,
  'phase06-type-unknown-field': reject,
  'phase06-type-timeout-zero': reject,
};

const decisionNotes: Readonly<Partial<Record<BrowserActionCorpusId, string>>> =
  {
    'supplied-scope-pair':
      'V6: Advisor validates the explicit project/worktree pair; MCP strips those fields.',
    'supplied-project-only':
      'V6: Advisor requires projectId and worktreeId together; MCP strips the supplied scope.',
    'supplied-worktree-only':
      'V6: Advisor requires projectId and worktreeId together; MCP strips the supplied scope.',
    'open-browser-id-no-generation':
      'V7: runtime generation is optional for MCP, validated when supplied, and required by Advisor for an existing tab.',
    'back-no-generation':
      'V7: runtime generation is optional for MCP, validated when supplied, and required by Advisor for an existing tab.',
    'focus-no-generation':
      'V7: runtime generation is optional for MCP, validated when supplied, and required by Advisor for an existing tab.',
    'wait-for-no-generation':
      'V7: runtime generation is optional for MCP, validated when supplied, and required by Advisor for an existing tab.',
    'back-invalid-runtime-generation':
      'V7: runtime generation is optional for MCP, validated when supplied, and required by Advisor for an existing tab.',
    'back-extra-selection':
      'V8: selection is UI-only for browser.back; MCP rejects the key while Advisor strips it.',
    'click-extra-selection':
      'V8: selection is UI-only for browser.click; MCP rejects the key while Advisor strips it.',
    'v8-ui-only-click-fields':
      'V8: UI-only click fields are rejected by MCP and accepted/stripped by Advisor.',
  };

/**
 * Profiles have no renderer validator. Their effective Advisor route is false
 * when the Advisor schema rejects the payload and otherwise 'not-handled'.
 */
export const browserActionDecisionTable: readonly BrowserActionDecisionCase[] =
  browserActionCorpusCases.map(({ id, action }) => {
    const before = beforeDecisions[id];
    const after = afterDecisions[id];
    return {
      id,
      action,
      before,
      after,
      effectiveRoutes: {
        before: effectiveRoutes(before),
        after: effectiveRoutes(after),
      },
      ...(decisionNotes[id] === undefined ? {} : { note: decisionNotes[id] }),
    };
  });

/** Phase 05 JSON-representable payloads: one decision on every route. */
export const pointerViewportCorpus: readonly (BrowserActionCase & {
  accepted: boolean;
})[] = [
  {
    id: 'valid-pv-hover-0',
    action: { type: 'browser.hover', expectedRuntimeGeneration: 1, ref: 'r' },
    accepted: true,
  },
  {
    id: 'valid-pv-hover-1',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      locator: '#r',
      frame: 'f',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-hover-2',
    action: { type: 'browser.hover', expectedRuntimeGeneration: 1, x: 0, y: 2 },
    accepted: true,
  },
  {
    // Off the page past the top edge, for exit-intent popups.
    id: 'valid-pv-hover-3',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      x: 300,
      y: -5,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-0',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-1',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'up',
      pages: 0.1,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-2',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'left',
      pages: 10,
      ref: 'r',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-3',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'right',
      pixels: 100000,
      locator: '#list',
      frame: 'f',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-4',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      intoView: true,
      ref: 'r',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-5',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      intoView: true,
      locator: '#r',
      frame: 'f',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-6',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: 'Ready',
      frame: 'f',
    },
    accepted: true,
  },
  {
    id: 'valid-pv-drag-0',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
    },
    accepted: true,
  },
  {
    id: 'valid-pv-drag-1',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { locator: '#r', frame: 'f' },
      to: { locator: '#s', frame: 'f' },
      steps: 1,
      modifiers: ['Shift'],
    },
    accepted: true,
  },
  {
    id: 'valid-pv-drag-2',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { x: 0, y: 0 },
      steps: 100,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-drag-3',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { dx: -2, dy: 0 },
    },
    accepted: true,
  },
  {
    id: 'invalid-pv-hover-0',
    action: { type: 'browser.hover', expectedRuntimeGeneration: 1 },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-1',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      locator: '#r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-2',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      x: 1,
      y: 2,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-3',
    action: { type: 'browser.hover', expectedRuntimeGeneration: 1, x: 1 },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-4',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      x: '1',
      y: 2,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-5',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      frame: 'f',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-6',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      x: 1,
      y: 2,
      frame: 'f',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-7',
    action: { type: 'browser.hover', expectedRuntimeGeneration: 1, ref: ' ' },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-8',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      locator: null,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-9',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      force: true,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-0',
    action: { type: 'browser.scroll', expectedRuntimeGeneration: 1 },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-1',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pages: 1,
      pixels: 1,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-2',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      intoView: true,
      ref: 'r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-3',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      toText: 'Ready',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-4',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      intoView: false,
      ref: 'r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-5',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      intoView: true,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-6',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: '',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-7',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: ' ',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-8',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: null,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-9',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: 'Ready',
      ref: 'r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-10',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      toText: 'Ready',
      locator: '#r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-11',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      intoView: true,
      ref: 'r',
      pixels: 1,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-12',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      frame: 'f',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-13',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      ref: 'r',
      frame: 'f',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-14',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      ref: 'r',
      locator: '#r',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-15',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'diagonal',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-16',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pages: 0.09,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-17',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pages: 10.1,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-18',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pixels: 0,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-19',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pixels: 1.5,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-20',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      pixels: 100001,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-21',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      x: 1,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-0',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: {},
      to: { ref: 's' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-1',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r', locator: '#r' },
      to: { ref: 's' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-2',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r', frame: 'f' },
      to: { ref: 's' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-3',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r', extra: 1 },
      to: { ref: 's' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-4',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: {},
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-5',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { x: 1, y: 2, dx: 1, dy: 2 },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-6',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { x: 1 },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-7',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { dx: 1 },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-8',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { x: -1, y: 2 },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-9',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's', frame: 'f' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-10',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { locator: ' ' },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-11',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's', extra: 1 },
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-12',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      steps: 0,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-13',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      steps: 101,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-14',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      steps: 1.5,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-15',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      modifiers: ['Alt', 'Alt'],
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-16',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      modifiers: ['Command'],
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-17',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      position: { x: 1, y: 2 },
    },
    accepted: false,
  },
  {
    id: 'valid-pv-hover-timeoutMs-60000',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      timeoutMs: 60000,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-hover-actionId-retry',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      actionId: 'retry',
    },
    accepted: true,
  },
  {
    id: 'invalid-pv-hover-timeoutMs-60001',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      timeoutMs: 60001,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-timeoutMs-0',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      timeoutMs: 0,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-timeoutMs-1.5',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      timeoutMs: 1.5,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-actionId-',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      actionId: '',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-actionId- ',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      actionId: ' ',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-hover-extra-True',
    action: {
      type: 'browser.hover',
      expectedRuntimeGeneration: 1,
      ref: 'r',
      extra: true,
    },
    accepted: false,
  },
  {
    id: 'valid-pv-scroll-timeoutMs-60000',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      timeoutMs: 60000,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-scroll-actionId-retry',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      actionId: 'retry',
    },
    accepted: true,
  },
  {
    id: 'invalid-pv-scroll-timeoutMs-60001',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      timeoutMs: 60001,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-timeoutMs-0',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      timeoutMs: 0,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-timeoutMs-1.5',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      timeoutMs: 1.5,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-actionId-',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      actionId: '',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-actionId- ',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      actionId: ' ',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-scroll-extra-True',
    action: {
      type: 'browser.scroll',
      expectedRuntimeGeneration: 1,
      direction: 'down',
      extra: true,
    },
    accepted: false,
  },
  {
    id: 'valid-pv-drag-timeoutMs-60000',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      timeoutMs: 60000,
    },
    accepted: true,
  },
  {
    id: 'valid-pv-drag-actionId-retry',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      actionId: 'retry',
    },
    accepted: true,
  },
  {
    id: 'invalid-pv-drag-timeoutMs-60001',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      timeoutMs: 60001,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-timeoutMs-0',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      timeoutMs: 0,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-timeoutMs-1.5',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      timeoutMs: 1.5,
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-actionId-',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      actionId: '',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-actionId- ',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      actionId: ' ',
    },
    accepted: false,
  },
  {
    id: 'invalid-pv-drag-extra-True',
    action: {
      type: 'browser.drag',
      expectedRuntimeGeneration: 1,
      from: { ref: 'r' },
      to: { ref: 's' },
      extra: true,
    },
    accepted: false,
  },
];
