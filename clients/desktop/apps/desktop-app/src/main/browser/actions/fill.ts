import type {
  BrowserActionError,
  BrowserJavaScriptDialog,
} from '@canopy/execution-engine/types/browser';
import type { ResolvedActionTarget } from '../frames/action-targets';
import {
  isCDPRecord,
  readCDPInteger,
  readCDPString,
} from '../frames/cdp-decode';
import { EDITOR_TEXT_FUNCTION } from '../frames/target-state';
import { dispatchFill, dispatchPress } from './input-dispatch';
import { buildKeyEventSequence, parseKeyCombo } from './key-definitions';
import {
  FormActionError,
  type FormActionOptions,
  type FormActionResult,
} from './form-action';
import {
  CONTENT_EDITABLE_FUNCTION,
  dispatchTyping,
  HAS_FOCUS_FUNCTION,
} from './type';

export interface RunFillOptions extends FormActionOptions {
  text: string;
  platform: NodeJS.Platform;
  /** The host-world prototype setter; its return value intentionally carries no state. */
  fillDirect: () => Promise<unknown>;
}

type FillKind =
  | 'text'
  | 'compound'
  | 'editor'
  | 'checkable'
  | 'select'
  | 'listbox'
  | 'combobox'
  | 'file'
  | 'other';

interface TargetRead {
  connected: boolean;
  tagName: string;
  role: string;
  inputType: string;
  /** An input that takes several values, such as a list of addresses. */
  multiple: boolean;
  disabled: boolean;
  readOnly: boolean;
  editable: boolean;
  editor: boolean;
  kind: FillKind;
  autocompleteWarning: boolean;
  settleMs: number;
  format?: string;
}

interface Verdict {
  matches: boolean;
  retainedAppend: boolean;
}

interface PageEditor {
  objectId: string;
  target: ResolvedActionTarget;
  recordingTarget?: ResolvedActionTarget;
}

type InputResult =
  | { completed: true; focusLost?: true }
  | { completed: false; dialog: BrowserJavaScriptDialog };

const FILL_TARGET_FUNCTION = `function() {
  const element = this;
  const owner = element.ownerDocument;
  const view = owner ? owner.defaultView : null;
  if (!element.isConnected || !owner || !view || view.document !== owner) return { connected: false };
  const tagName = element.tagName.toLowerCase();
  const role = (element.getAttribute('role') || '').toLowerCase();
  const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
  const disabled = element.matches(':disabled') || element.closest('[aria-disabled="true" i]') !== null;
  const readOnly = element.matches('[readonly]') || element.closest('[aria-readonly="true" i]') !== null;
  const editableContent = (${CONTENT_EDITABLE_FUNCTION})(element);
  const nativeText = element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(inputType));
  const editor = !nativeText && editableContent;
  const checkable = inputType === 'checkbox' || inputType === 'radio' || ['checkbox', 'radio', 'switch', 'menuitemcheckbox'].includes(role);
  const file = inputType === 'file';
  const listbox = tagName === 'select' || role === 'listbox';
  const combobox = role === 'combobox' && !nativeText && !editor;
  const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
  const datepicker = tagName === 'input' && inputType === 'text' &&
    (/datepicker|daterangepicker|datetimepicker/.test(className) ||
     element.hasAttribute('data-datepicker') || element.hasAttribute('data-date-format') ||
     element.hasAttribute('data-provide'));
  const compound = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(inputType) || datepicker;
  let kind = 'other';
  if (file) kind = 'file';
  else if (checkable) kind = 'checkable';
  else if (tagName === 'select') kind = 'select';
  else if (role === 'listbox') kind = 'listbox';
  else if (combobox) kind = 'combobox';
  else if (editor) kind = 'editor';
  else if (compound) kind = 'compound';
  else if (nativeText) kind = 'text';
  let format;
  if (inputType === 'date') format = 'YYYY-MM-DD';
  else if (inputType === 'time') format = 'HH:MM';
  else if (inputType === 'datetime-local') format = 'YYYY-MM-DDTHH:MM';
  else if (inputType === 'month') format = 'YYYY-MM';
  else if (inputType === 'week') format = 'YYYY-Www';
  else if (inputType === 'color') format = '#RRGGBB';
  // The defaults a range takes without the attributes, as snapshot rows give them.
  else if (inputType === 'range') format = (element.min || '0') + ' to ' + (element.max || '100') + ' in steps of ' + (element.step || '1');
  const ariaAutocomplete = element.hasAttribute('aria-autocomplete');
  return {
    connected: true,
    tagName,
    role,
    inputType,
    multiple: element instanceof HTMLInputElement && element.multiple === true,
    disabled,
    readOnly,
    editor,
    editable: !disabled && !readOnly && (nativeText || editor),
    kind,
    autocompleteWarning: role === 'combobox' || ariaAutocomplete || element.hasAttribute('list'),
    settleMs: role === 'combobox' || ariaAutocomplete ? 400 : 0,
    ...(format === undefined ? {} : { format })
};
}`;

function fillKind(value: string): FillKind | undefined {
  if (value === 'text') return 'text';
  if (value === 'compound') return 'compound';
  if (value === 'editor') return 'editor';
  if (value === 'checkable') return 'checkable';
  if (value === 'select') return 'select';
  if (value === 'listbox') return 'listbox';
  if (value === 'combobox') return 'combobox';
  if (value === 'file') return 'file';
  if (value === 'other') return 'other';
  return undefined;
}

const EDITING_HOST_FUNCTION = `function() {
  const element = this;
  const editable = ${CONTENT_EDITABLE_FUNCTION};
  if (!editable(element)) return null;
  let host = element;
  for (let parent = host.parentElement; parent; parent = parent.parentElement) {
    const parentEditable = editable(parent);
    if (!parentEditable) break;
    host = parent;
  }
  return host;
}`;

/**
 * The value an input stores for `text` where the browser rewrites a valid
 * value: a color in lower case, and a local date-time without zero seconds
 * and with `T` between its date and time. Any other text is compared as
 * given: a time input stores a valid time, seconds included, unchanged.
 */
export const NORMALIZED_INPUT_VALUE_FUNCTION = `(type, text) => {
  if (type === 'color') return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : text;
  const clock = value => {
    const match = /^(\\d{2}:\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?$/.exec(value);
    if (!match) return undefined;
    const fraction = (match[3] || '').replace(/0+$/, '');
    if (!match[2] || (match[2] === '00' && fraction === '')) return match[1];
    return match[1] + ':' + match[2] + (fraction ? '.' + fraction : '');
  };
  if (type === 'datetime-local') {
    const match = /^(\\d{4,}-\\d{2}-\\d{2})[T ](.+)$/.exec(text);
    const time = match ? clock(match[2]) : undefined;
    return match && time !== undefined ? match[1] + 'T' + time : text;
  }
  return text;
}`;

const WAIT_AND_COMPARE_FUNCTION = `async function(expected) {
  const element = this;
  const view = element.ownerDocument.defaultView;
  await new Promise(resolve => {
    const afterFrame = () => view.setTimeout(resolve, 50);
    if (typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(afterFrame);
    else view.setTimeout(resolve, 50);
  });
  const current = element.value;
  const stored = (${NORMALIZED_INPUT_VALUE_FUNCTION})(element.type, expected);
  return {
    matches: current === stored,
    retainedAppend: current.length > stored.length && current.includes(stored)
  };
}`;

const COMPOUND_SET_FUNCTION = `function(text) {
  const element = this;
  if (!element.isConnected || !(element instanceof HTMLInputElement)) return false;
  element.value = text;
  for (const type of ['focus', 'input', 'change', 'blur'])
    element.dispatchEvent(new Event(type, { bubbles: true }));
  return true;
}`;

const READ_VALUE_FUNCTION = 'function() { return this.value; }';

const CLEAR_EDITOR_FUNCTION = `function() {
  const element = this;
  if (!element.isConnected) return false;
  element.focus();
  while (element.firstChild) element.removeChild(element.firstChild);
  const selection = element.ownerDocument.getSelection();
  if (selection) {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  // An editor that keeps its own document model learns it is empty, or it
  // would draw its old text again at the next keystroke.
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  return element.textContent === '';
}`;

const EDITOR_EMPTY_FUNCTION = 'function() { return this.textContent === ""; }';
// The editor's text is read with each no-break space as a space, so the
// requested text is folded the same way.
const EDITOR_MATCHES_FUNCTION = `function(expected) {
  return (${EDITOR_TEXT_FUNCTION}).call(this) === String(expected).replace(/\\u00a0/g, ' ');
}`;
// The editor's text before the first character of a block, kept in this
// isolated world so a secret editor's text never leaves the page. An editor
// that dropped the character leaves its text unchanged, whatever ends its
// lines: a block, a <br>, or a newline in a text node.
const EDITOR_MARK_FUNCTION = `function() {
  if (!globalThis.__canopyEditorMarks) globalThis.__canopyEditorMarks = new WeakMap();
  globalThis.__canopyEditorMarks.set(this, this.textContent);
  return true;
}`;
const EDITOR_CHANGED_FUNCTION = `function() {
  const before = globalThis.__canopyEditorMarks?.get(this);
  globalThis.__canopyEditorMarks?.delete(this);
  return before === undefined || this.textContent !== before;
}`;

function valueOf(response: unknown): unknown {
  if (
    !isCDPRecord(response) ||
    response.exceptionDetails !== undefined ||
    !isCDPRecord(response.result)
  )
    return undefined;
  return response.result.value;
}

function objectIdOf(response: unknown): string | undefined {
  if (!isCDPRecord(response) || !isCDPRecord(response.result)) return undefined;
  return readCDPString(response.result.objectId);
}

function decodeTargetRead(value: unknown): TargetRead | undefined {
  if (!isCDPRecord(value) || value.connected !== true) return undefined;
  const tagName = readCDPString(value.tagName);
  const role = readCDPString(value.role);
  const inputType = readCDPString(value.inputType);
  const kindValue = readCDPString(value.kind);
  const kind = kindValue === undefined ? undefined : fillKind(kindValue);
  const settleMs =
    typeof value.settleMs === 'number' ? value.settleMs : undefined;
  if (
    tagName === undefined ||
    role === undefined ||
    inputType === undefined ||
    typeof value.disabled !== 'boolean' ||
    typeof value.readOnly !== 'boolean' ||
    typeof value.editable !== 'boolean' ||
    typeof value.editor !== 'boolean' ||
    typeof value.autocompleteWarning !== 'boolean' ||
    settleMs === undefined ||
    kind === undefined
  )
    return undefined;
  const format = readCDPString(value.format);
  return {
    connected: true,
    tagName,
    role,
    inputType,
    multiple: value.multiple === true,
    disabled: value.disabled,
    readOnly: value.readOnly,
    editable: value.editable,
    editor: value.editor,
    kind,
    autocompleteWarning: value.autocompleteWarning,
    settleMs,
    ...(format === undefined ? {} : { format }),
  };
}

async function callValue(
  options: FormActionOptions,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = [],
  awaitPromise = false,
  userGesture = false,
  tracked = true,
): Promise<unknown> {
  const command = options.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      ...(awaitPromise ? { awaitPromise: true } : {}),
      ...(userGesture ? { userGesture: true } : {}),
      objectGroup: options.target.objectGroup,
    },
    options.target.identity.sessionId,
  );
  const response = tracked
    ? await options.lane.trackCommand(command)
    : await command;
  return valueOf(response);
}

async function callObject(
  options: FormActionOptions,
  objectId: string,
  functionDeclaration: string,
  tracked = true,
): Promise<string | undefined> {
  const command = options.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration,
      returnByValue: false,
      objectGroup: options.target.objectGroup,
    },
    options.target.identity.sessionId,
  );
  const response = tracked
    ? await options.lane.trackCommand(command)
    : await command;
  return objectIdOf(response);
}

function refusal(
  code: BrowserActionError['code'],
  message: string,
  next?: string,
): FormActionError {
  return new FormActionError({
    code,
    message,
    retryable: false,
    ...(next === undefined ? {} : { next }),
  });
}

async function preflight(options: RunFillOptions): Promise<TargetRead> {
  options.lane.signal.throwIfAborted();
  const raw = await callValue(
    options,
    options.target.objectId,
    FILL_TARGET_FUNCTION,
    [],
    false,
    false,
    false,
  );
  options.lane.signal.throwIfAborted();
  const read = decodeTargetRead(raw);
  if (!read)
    throw refusal('target_stale', 'The target is no longer available.');
  options.lane.signal.throwIfAborted();
  if (read.disabled)
    throw refusal('target_disabled', 'The target is disabled.');
  if (read.kind === 'file')
    throw refusal(
      'unsupported_control',
      'Use browser.upload_files to attach files to a file input, or browser.request_files to ask the user to choose them.',
      'browser.upload_files',
    );
  if (read.kind === 'checkable')
    throw refusal(
      'unsupported_control',
      'Use browser.set_checked instead of filling a checkbox or radio button.',
      'browser.set_checked',
    );
  if (
    read.kind === 'select' ||
    read.kind === 'listbox' ||
    read.kind === 'combobox'
  )
    throw refusal(
      'unsupported_control',
      'Use browser.select_option instead of filling a select, listbox, or non-editable combobox.',
      'browser.select_option',
    );
  if (!read.editable)
    throw refusal('not_editable', 'The target is not editable.');
  if (read.kind === 'editor' && options.pickMode)
    throw refusal(
      'execution_failed',
      'The user is picking an element. Try again after they finish.',
    );
  if (read.kind === 'editor' && options.text.length > 4000)
    throw refusal(
      'unsupported_control',
      'The text is too long to type into this editor: 4,000 characters at most.',
    );
  return read;
}

async function normalizedEditor(
  options: FormActionOptions,
): Promise<PageEditor | undefined> {
  const objectId = await callObject(
    options,
    options.target.objectId,
    EDITING_HOST_FUNCTION,
    false,
  );
  options.lane.signal.throwIfAborted();
  if (!objectId) return undefined;
  const response = await options.send(
    'DOM.describeNode',
    { objectId, depth: 0 },
    options.target.identity.sessionId,
  );
  options.lane.signal.throwIfAborted();
  if (!isCDPRecord(response) || !isCDPRecord(response.node)) return undefined;
  const backendNodeId = readCDPInteger(response.node.backendNodeId);
  if (backendNodeId === undefined) return undefined;
  const hostTarget: ResolvedActionTarget = {
    identity: { ...options.target.identity, backendNodeId },
    frameRef: options.target.frameRef,
    objectId,
    objectGroup: options.target.objectGroup,
    outOfProcess: options.target.outOfProcess,
    ...(options.target.point ? { point: options.target.point } : {}),
    ...(options.target.scrollNode !== undefined
      ? { scrollNode: options.target.scrollNode }
      : {}),
  };
  const recordingTarget =
    backendNodeId === options.target.identity.backendNodeId
      ? undefined
      : hostTarget;
  return {
    objectId,
    target: hostTarget,
    ...(recordingTarget ? { recordingTarget } : {}),
  };
}

function autocompleteMetadata(
  read: TargetRead,
): Pick<FormActionResult, 'warnings' | 'settleMs'> {
  return {
    ...(read.autocompleteWarning
      ? {
          warnings: [
            'Wait for suggestions and click one instead of pressing Enter.',
          ],
        }
      : {}),
    ...(read.settleMs > 0 ? { settleMs: read.settleMs } : {}),
  };
}

function withWarnings(
  result: FormActionResult,
  read: TargetRead,
  warnings: string[] = [],
): FormActionResult {
  const autocomplete = autocompleteMetadata(read);
  const combined = [...warnings, ...(autocomplete.warnings ?? [])];
  return {
    ...result,
    ...(combined.length ? { warnings: combined } : {}),
    ...(autocomplete.settleMs === undefined
      ? {}
      : { settleMs: autocomplete.settleMs }),
  };
}

async function compareValue(
  options: RunFillOptions,
  objectId: string,
  expected = options.text,
): Promise<Verdict> {
  const value = await callValue(
    options,
    objectId,
    WAIT_AND_COMPARE_FUNCTION,
    [expected],
    true,
  );
  if (!isCDPRecord(value)) return { matches: false, retainedAppend: false };
  return {
    matches: value.matches === true,
    retainedAppend: value.retainedAppend === true,
  };
}

async function observedValue(
  options: RunFillOptions,
  objectId: string,
): Promise<string | undefined> {
  if (options.secret) return undefined;
  const value = await callValue(options, objectId, READ_VALUE_FUNCTION);
  return typeof value === 'string' ? value : undefined;
}

async function dispatchCombo(
  options: Pick<
    RunFillOptions,
    | 'send'
    | 'cleanupSend'
    | 'lane'
    | 'target'
    | 'beforeInput'
    | 'getPendingDialog'
    | 'platform'
  >,
  combo: string,
): Promise<InputResult> {
  options.lane.signal.throwIfAborted();
  const parsed = parseKeyCombo(combo, options.platform);
  if (!parsed.ok) throw new Error('The built-in editing key is invalid.');
  const result = await dispatchPress({
    send: options.send,
    cleanupSend: options.cleanupSend,
    sessionId: options.target.identity.sessionId,
    lane: options.lane,
    beforeInput: options.beforeInput,
    getPendingDialog: options.getPendingDialog,
    events: buildKeyEventSequence(parsed, options.platform),
  });
  return 'completed' in result && result.completed === false
    ? { completed: false, dialog: result.dialog }
    : { completed: true };
}

/** Types `text`; with `focusTarget`, stops once that element loses focus. */
async function typeText(
  options: RunFillOptions,
  text: string,
  focusTarget?: string,
): Promise<InputResult> {
  const result = await dispatchTyping({
    send: options.send,
    cleanupSend: options.cleanupSend,
    sessionId: options.target.identity.sessionId,
    lane: options.lane,
    beforeInput: options.beforeInput,
    text,
    getPendingDialog: options.getPendingDialog,
    ...(focusTarget === undefined
      ? {}
      : {
          keepsFocus: async (): Promise<boolean> =>
            (await callValue(options, focusTarget, HAS_FOCUS_FUNCTION)) ===
            true,
        }),
  });
  if (!result.completed) return { completed: false, dialog: result.dialog };
  return result.focusLost
    ? { completed: true, focusLost: true }
    : { completed: true };
}

function inputResult(
  inputMode: 'trusted' | 'direct',
  result: InputResult,
  options: { editor?: boolean; recordingTarget?: ResolvedActionTarget } = {},
): FormActionResult {
  return {
    inputMode,
    completed: result.completed,
    ...(!result.completed ? { dialog: result.dialog } : {}),
    ...(options.editor ? { editor: true } : {}),
    ...(options.recordingTarget
      ? { recordingTarget: options.recordingTarget }
      : {}),
  };
}

async function directFill(options: RunFillOptions): Promise<InputResult> {
  const result = await dispatchFill({
    lane: options.lane,
    fillPrepared: options.fillDirect,
    getPendingDialog: options.getPendingDialog,
  });
  return result.completed
    ? { completed: true }
    : { completed: false, dialog: result.dialog };
}

async function readEditorEmpty(
  options: RunFillOptions,
  objectId: string,
): Promise<boolean> {
  return (await callValue(options, objectId, EDITOR_EMPTY_FUNCTION)) === true;
}

async function readEditorText(
  options: RunFillOptions,
  objectId: string,
): Promise<string | undefined> {
  if (options.secret) return undefined;
  const value = await callValue(options, objectId, EDITOR_TEXT_FUNCTION);
  return typeof value === 'string' ? value : undefined;
}

async function clearEditor(
  options: RunFillOptions,
  editor: PageEditor,
): Promise<InputResult> {
  options.lane.signal.throwIfAborted();
  options.lane.beginDispatch();
  try {
    const cleared = await callValue(
      options,
      editor.objectId,
      CLEAR_EDITOR_FUNCTION,
      [],
      false,
      true,
    );
    if (cleared === true) return { completed: true };
  } catch {
    const dialog = options.getPendingDialog?.();
    if (dialog) return { completed: false, dialog };
    options.lane.signal.throwIfAborted();
  }

  // Keys go to whatever has focus, and the click runs page handlers that
  // can move it: each clearing key is sent only while the editor has it.
  const editorFocused = async (): Promise<boolean> =>
    (await callValue(options, editor.objectId, HAS_FOCUS_FUNCTION)) === true;
  const clicked = await options.click(
    {
      objectId: editor.objectId,
      backendNodeId: editor.target.identity.backendNodeId,
    },
    3,
  );
  if (!clicked.completed) return { completed: false, dialog: clicked.dialog };
  if (!(await editorFocused())) return { completed: true, focusLost: true };
  const deleted = await dispatchCombo(options, 'Delete');
  if (!deleted.completed) return deleted;
  if (await readEditorEmpty(options, editor.objectId))
    return { completed: true };

  if (!(await editorFocused())) return { completed: true, focusLost: true };
  const selected = await dispatchCombo(options, 'ControlOrMeta+A');
  if (!selected.completed) return selected;
  if (!(await editorFocused())) return { completed: true, focusLost: true };
  const backspaced = await dispatchCombo(options, 'Backspace');
  if (!backspaced.completed) return backspaced;
  return { completed: true };
}

/** The editor no longer has focus: nothing more is typed. */
async function editorLostFocus(
  options: RunFillOptions,
  editor: PageEditor,
  read: TargetRead,
  message = 'The editor lost focus, so the text was not typed.',
): Promise<FormActionResult> {
  const lost = [message];
  const observed = await readEditorText(options, editor.objectId);
  return withWarnings(
    {
      inputMode: 'trusted',
      completed: true,
      editor: true,
      ...(editor.recordingTarget
        ? { recordingTarget: editor.recordingTarget }
        : {}),
      readback: { code: 'state_unchanged' },
      warnings: lost,
      ...(observed === undefined ? {} : { target: { value: observed } }),
    },
    read,
    lost,
  );
}

async function fillEditor(
  given: RunFillOptions,
  read: TargetRead,
): Promise<FormActionResult> {
  const editor = await normalizedEditor(given);
  if (!editor)
    throw refusal('target_stale', 'The editing host is no longer available.');
  given.lane.signal.throwIfAborted();
  // The editing host receives the input and is what the receipt describes.
  // Its secrecy is read before it is focused or cleared, since a page can
  // drop the marker then.
  const hostSecret =
    !given.secret &&
    given.classifyInputTarget !== undefined &&
    (await given.classifyInputTarget(editor.target));
  const options: RunFillOptions = hostSecret
    ? { ...given, secret: true }
    : given;
  options.lane.signal.throwIfAborted();
  options.onEditor?.();

  const warnings: string[] = [];
  let cleared: InputResult;
  try {
    cleared = await clearEditor(options, editor);
  } catch (error) {
    if (!(error instanceof FormActionError)) throw error;
    // The direct clear has already crossed the dispatch boundary.
    const observed = await readEditorText(options, editor.objectId);
    return withWarnings(
      {
        inputMode: 'trusted',
        completed: true,
        editor: true,
        ...(editor.recordingTarget
          ? { recordingTarget: editor.recordingTarget }
          : {}),
        readback: { code: 'state_unchanged' },
        ...(observed === undefined ? {} : { target: { value: observed } }),
      },
      read,
      ['The editor could not be cleared before filling it.'],
    );
  }
  if (!cleared.completed)
    return withWarnings(
      inputResult('trusted', cleared, {
        editor: true,
        recordingTarget: editor.recordingTarget,
      }),
      read,
      warnings,
    );
  if (cleared.focusLost)
    return editorLostFocus(
      options,
      editor,
      read,
      'The editor lost focus while it was cleared, so the text was not typed.',
    );

  const empty = await readEditorEmpty(options, editor.objectId);
  if (!empty) {
    const observed = await readEditorText(options, editor.objectId);
    return withWarnings(
      {
        inputMode: 'trusted',
        completed: true,
        editor: true,
        ...(editor.recordingTarget
          ? { recordingTarget: editor.recordingTarget }
          : {}),
        readback: { code: 'state_unchanged' },
        ...(observed === undefined ? {} : { target: { value: observed } }),
      },
      read,
      ['The editor could not be cleared before filling it.'],
    );
  }

  // Clearing runs page handlers, which can move focus, and keys go to
  // whatever has focus. An empty editor has nowhere else for the caret.
  const focused = await options.focus({
    objectId: editor.objectId,
    backendNodeId: editor.target.identity.backendNodeId,
  });
  if (!focused.completed)
    return withWarnings(
      inputResult('trusted', focused, {
        editor: true,
        recordingTarget: editor.recordingTarget,
      }),
      read,
      warnings,
    );
  if (!focused.focused) return editorLostFocus(options, editor, read);

  // An editor's text holds each line break as LF, as a textarea does.
  const text = options.text.replace(/\r\n?/g, '\n');
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += 1) {
    options.lane.signal.throwIfAborted();
    const character = characters[index];
    if (character === undefined) continue;
    // The page's handlers can move focus after any character. Focus is
    // checked, not taken, so the caret stays where typing left it.
    if (
      index > 0 &&
      (await callValue(options, editor.objectId, HAS_FOCUS_FUNCTION)) !== true
    )
      return editorLostFocus(
        options,
        editor,
        read,
        'The editor lost focus while typing, so the rest of the text was not typed.',
      );
    // Enter is never a dropped first character; the check applies to the
    // first character of each block.
    const blockStart =
      character !== '\n' && (index === 0 || characters[index - 1] === '\n');
    if (blockStart)
      await callValue(options, editor.objectId, EDITOR_MARK_FUNCTION);
    const typed = await typeText(options, character);
    if (!typed.completed)
      return withWarnings(
        inputResult('trusted', typed, {
          editor: true,
          recordingTarget: editor.recordingTarget,
        }),
        read,
        warnings,
      );
    if (blockStart) {
      const accepted = await callValue(
        options,
        editor.objectId,
        EDITOR_CHANGED_FUNCTION,
      );
      if (accepted !== true) {
        // A retry must not move the caret, so focus is checked, not taken.
        if (
          (await callValue(options, editor.objectId, HAS_FOCUS_FUNCTION)) !==
          true
        )
          return editorLostFocus(options, editor, read);
        const retried = await typeText(options, character);
        if (!retried.completed)
          return withWarnings(
            inputResult('trusted', retried, {
              editor: true,
              recordingTarget: editor.recordingTarget,
            }),
            read,
            warnings,
          );
      }
    }
  }

  const matches =
    (await callValue(options, editor.objectId, EDITOR_MATCHES_FUNCTION, [
      text,
    ])) === true;
  const observed = await readEditorText(options, editor.objectId);
  if (!matches) warnings.push('The editor did not accept the complete text.');
  return withWarnings(
    {
      inputMode: 'trusted',
      completed: true,
      editor: true,
      ...(editor.recordingTarget
        ? { recordingTarget: editor.recordingTarget }
        : {}),
      ...(matches ? {} : { readback: { code: 'state_unchanged' } }),
      ...(warnings.length ? { warnings } : {}),
      ...(observed === undefined ? {} : { target: { value: observed } }),
    },
    read,
    warnings,
  );
}

async function fillCompound(
  options: RunFillOptions,
  read: TargetRead,
): Promise<FormActionResult> {
  options.lane.signal.throwIfAborted();
  options.lane.beginDispatch();
  try {
    await callValue(
      options,
      options.target.objectId,
      COMPOUND_SET_FUNCTION,
      [options.text],
      false,
      true,
    );
  } catch {
    const dialog = options.getPendingDialog?.();
    if (dialog)
      return withWarnings(
        inputResult('direct', { completed: false, dialog }),
        read,
      );
    throw new Error('The compound control could not be filled.');
  }

  const verdict = await compareValue(options, options.target.objectId);
  if (verdict.matches)
    return withWarnings(inputResult('direct', { completed: true }), read);

  const observed = await observedValue(options, options.target.objectId);
  const formatMismatch = options.text.length > 0 && !options.secret;
  const warning = formatMismatch
    ? read.format
      ? `The value was not accepted. Expected format: ${read.format}.`
      : 'The datepicker value was not accepted.'
    : options.text.length === 0
      ? 'The control did not accept the empty value.'
      : 'The control did not accept the value.';
  return withWarnings(
    {
      inputMode: 'direct',
      completed: true,
      ...(formatMismatch
        ? {
            readback: {
              code: 'invalid_format',
              ...(read.format ? { expectedFormat: read.format } : {}),
            },
          }
        : { readback: { code: 'state_unchanged' } }),
      warnings: [warning],
      ...(observed === undefined ? {} : { target: { value: observed } }),
    },
    read,
    [warning],
  );
}

/**
 * The text a field holds for `text`. A single-line input drops line breaks
 * from any value it is given, and a textarea stores each as LF. An email or
 * URL input also strips ASCII whitespace from both ends, and an email input
 * that takes several addresses strips it around each one. Only ASCII
 * whitespace: the browser keeps a no-break space.
 */
function storedText(read: TargetRead, text: string): string {
  if (read.tagName !== 'input') return text.replace(/\r\n?/g, '\n');
  const line = text.replace(/[\r\n]/g, '');
  const strip = (value: string): string =>
    value.replace(/^[\t\f ]+|[\t\f ]+$/g, '');
  if (read.inputType === 'url') return strip(line);
  if (read.inputType !== 'email') return line;
  return read.multiple ? line.split(',').map(strip).join(',') : strip(line);
}

async function fillTextInput(
  options: RunFillOptions,
  read: TargetRead,
): Promise<FormActionResult> {
  const initial = await directFill(options);
  if (!initial.completed)
    return withWarnings(inputResult('direct', initial), read);
  // The value is compared, and typed, the way the field holds it: a typed CR
  // would be one more Enter, and in an input Enter can submit the form.
  const expected = storedText(read, options.text);
  let verdict = await compareValue(options, options.target.objectId, expected);
  if (verdict.matches)
    return withWarnings(inputResult('direct', { completed: true }), read);

  // Focusing the field can fall back to a real click, which would be the
  // user's pick.
  const typing = options.text.length <= 4000 && options.pickMode !== true;
  const warnings = typing
    ? ['The page reverted the value; typed it instead.']
    : options.pickMode === true
      ? [
          'The page reverted the value. It was not typed instead, because the user is picking an element and focusing the field can take a click.',
        ]
      : [
          'The page reverted the value; the text is too long for trusted typing.',
        ];
  let inputMode: 'trusted' | 'direct' = 'direct';
  if (typing) {
    // Keys go to whatever has focus, and the page's handlers may have moved
    // it while they reverted the value.
    const focused = await options.focus();
    if (!focused.completed)
      return withWarnings(inputResult('trusted', focused), read, warnings);
    if (!focused.focused) {
      const lost = ['The field lost focus, so the text was not typed.'];
      const observed = await observedValue(options, options.target.objectId);
      return withWarnings(
        {
          inputMode,
          completed: true,
          readback: { code: 'state_unchanged' },
          warnings: lost,
          ...(observed === undefined ? {} : { target: { value: observed } }),
        },
        read,
        lost,
      );
    }
    const fieldLostFocus = async (): Promise<FormActionResult> => {
      const lost = [
        'The field lost focus while typing, so the rest of the text was not typed.',
      ];
      const observed = await observedValue(options, options.target.objectId);
      return withWarnings(
        {
          inputMode: 'trusted',
          completed: true,
          readback: { code: 'state_unchanged' },
          ...(observed === undefined ? {} : { target: { value: observed } }),
        },
        read,
        lost,
      );
    };
    const selected = await dispatchCombo(options, 'ControlOrMeta+A');
    if (!selected.completed)
      return withWarnings(inputResult('trusted', selected), read, warnings);
    // A select-all handler can move focus too; the next key would replace
    // another field's content.
    if (
      (await callValue(
        options,
        options.target.objectId,
        HAS_FOCUS_FUNCTION,
      )) !== true
    )
      return fieldLostFocus();
    const typed =
      expected === ''
        ? await dispatchCombo(options, 'Backspace')
        : await typeText(options, expected, options.target.objectId);
    if (!typed.completed)
      return withWarnings(inputResult('trusted', typed), read, warnings);
    if ('focusLost' in typed && typed.focusLost) return fieldLostFocus();
    inputMode = 'trusted';
    verdict = await compareValue(options, options.target.objectId, expected);
  }

  if (!verdict.matches && verdict.retainedAppend) {
    const retried = await directFill(options);
    if (!retried.completed)
      return withWarnings(inputResult(inputMode, retried), read, warnings);
    verdict = await compareValue(options, options.target.objectId, expected);
    if (inputMode === 'trusted')
      warnings.push('The value setter was retried after typing.');
  }

  if (verdict.matches)
    return withWarnings(
      inputResult(inputMode, { completed: true }),
      read,
      warnings,
    );

  warnings.push('The page did not accept the filled value.');
  const observed = await observedValue(options, options.target.objectId);
  return withWarnings(
    {
      inputMode,
      completed: true,
      readback: { code: 'state_unchanged' },
      warnings,
      ...(observed === undefined ? {} : { target: { value: observed } }),
    },
    read,
    warnings,
  );
}

/** Fills a supported form control, using real keys when the page rejects a setter. */
export async function runFill(
  options: RunFillOptions,
): Promise<FormActionResult> {
  const read = await preflight(options);
  if (read.kind === 'editor') return fillEditor(options, read);
  if (read.kind === 'compound') return fillCompound(options, read);
  return fillTextInput(options, read);
}
