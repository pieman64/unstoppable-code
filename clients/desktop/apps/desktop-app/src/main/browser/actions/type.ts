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
import type { ActionLaneContext } from './action-lane';
import type { BrowserCdpSend } from './actionability';
import {
  FormActionError,
  type FormActionOptions,
  type FormActionResult,
} from './form-action';
import { dispatchPress, type InputAttribution } from './input-dispatch';
import { keyDefinition, type KeyEvent } from './key-definitions';

interface TypingBaseOptions {
  send: BrowserCdpSend;
  cleanupSend?: BrowserCdpSend;
  lane: ActionLaneContext;
  sessionId?: string;
  beforeInput?: (event: InputAttribution) => void;
  delayMs?: number;
  getPendingDialog?: () => BrowserJavaScriptDialog | undefined;
}

/**
 * Whether the element, or one inside it, has focus. Resolved outward from the
 * element through each shadow root's host, so a closed shadow root, whose
 * host has no readable `shadowRoot`, works the same as an open one.
 */
export const HAS_FOCUS_FUNCTION = `function() {
  const owner = this.ownerDocument;
  let root = this.getRootNode();
  const active = root ? root.activeElement : null;
  if (!active || !(active === this || this.contains(active))) return false;
  while (root !== owner) {
    if (!(root instanceof ShadowRoot)) return false;
    const host = root.host;
    root = host.getRootNode();
    if (!root || root.activeElement !== host) return false;
  }
  return true;
}`;

/** The common trusted, character-at-a-time keyboard path for type and fill. */
export interface TypingDispatchOptions extends TypingBaseOptions {
  text: string;
  /**
   * Asked before every character after the first, without moving focus.
   * Keys go to whatever has focus, so typing stops once it says false.
   */
  keepsFocus?: () => Promise<boolean>;
}

export type TypingDispatchResult =
  | { inputMode: 'trusted'; completed: true; focusLost?: true }
  | { inputMode: 'trusted'; completed: false; dialog: BrowserJavaScriptDialog };

function delay(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

function characterEvents(character: string): KeyEvent[] {
  const newline = character === '\n';
  const definition = keyDefinition(newline ? 'Enter' : character);
  const text = newline ? '\r' : character;
  const base = {
    code: definition.code,
    key: definition.key,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    modifiers: 0,
  };
  return [
    { ...base, type: 'keyDown', text },
    { ...base, type: 'keyUp' },
  ];
}

/**
 * Sends trusted key events for each Unicode code point. The keyDown carries
 * the character, so a page that cancels the keydown inserts nothing (see
 * `buildKeyEventSequence`). CRLF and a lone CR are one line break: a CR sent
 * as its own key is a second Enter.
 */
export async function dispatchTyping(
  options: TypingDispatchOptions,
): Promise<TypingDispatchResult> {
  const characters = Array.from(options.text.replace(/\r\n?/g, '\n'));
  for (let index = 0; index < characters.length; index += 1) {
    options.lane.signal.throwIfAborted();
    const character = characters[index];
    if (character === undefined) continue;
    if (index > 0 && options.keepsFocus && !(await options.keepsFocus()))
      return { inputMode: 'trusted', completed: true, focusLost: true };
    const result = await dispatchPress({
      send: options.send,
      cleanupSend: options.cleanupSend,
      sessionId: options.sessionId,
      lane: options.lane,
      beforeInput: options.beforeInput,
      getPendingDialog: options.getPendingDialog,
      events: characterEvents(character),
    });
    if ('completed' in result && result.completed === false)
      return { inputMode: 'trusted', completed: false, dialog: result.dialog };
    if (index < characters.length - 1) await delay(options.delayMs ?? 0);
  }
  return { inputMode: 'trusted', completed: true };
}

interface TargetRead {
  connected: boolean;
  disabled: boolean;
  editable: boolean;
  editor: boolean;
  autocompleteWarning: boolean;
  settleMs: number;
}

interface NormalizedEditorTarget {
  target: ResolvedActionTarget;
  recordingTarget?: ResolvedActionTarget;
}

/**
 * Whether an element is editable through its contenteditable attributes, as
 * snapshot rows decide it: the nearest `true`, empty, or `plaintext-only`
 * value makes it editable and `false` does not; any other value, such as
 * `inherit`, leaves it to the parent. `designMode` is not considered, so a
 * whole document is never taken as one editor.
 */
export const CONTENT_EDITABLE_FUNCTION = `(element) => {
  for (let node = element; node; node = node.parentElement) {
    const value = node.getAttribute('contenteditable');
    if (value === null) continue;
    const keyword = value.toLowerCase();
    if (keyword === '' || keyword === 'true' || keyword === 'plaintext-only') return true;
    if (keyword === 'false') return false;
  }
  return false;
}`;

const TYPE_TARGET_FUNCTION = `function() {
  const element = this;
  const owner = element.ownerDocument;
  const view = owner ? owner.defaultView : null;
  if (!element.isConnected || !owner || !view || view.document !== owner) return { connected: false };
  const role = (element.getAttribute('role') || '').toLowerCase();
  const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
  const ariaReadOnly = element.closest('[aria-readonly="true" i]') !== null;
  const disabled = element.matches(':disabled') || element.closest('[aria-disabled="true" i]') !== null;
  const nativeText = element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(inputType));
  const editableContent = (${CONTENT_EDITABLE_FUNCTION})(element);
  const readOnly = element.matches('[readonly]') || ariaReadOnly;
  const editor = !nativeText && editableContent;
  const editable = !disabled && !readOnly && (nativeText || editor);
  const ariaAutocomplete = element.hasAttribute('aria-autocomplete');
  return {
    connected: true,
    tagName: element.tagName.toLowerCase(),
    role,
    inputType,
    disabled,
    readOnly,
    editable,
    editor,
    autocompleteWarning: role === 'combobox' || ariaAutocomplete || element.hasAttribute('list'),
    settleMs: role === 'combobox' || ariaAutocomplete ? 400 : 0
  };
}`;

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

function objectIdOf(response: unknown): string | undefined {
  if (!isCDPRecord(response) || !isCDPRecord(response.result)) return undefined;
  return readCDPString(response.result.objectId);
}

function valueOf(response: unknown): unknown {
  if (
    !isCDPRecord(response) ||
    response.exceptionDetails !== undefined ||
    !isCDPRecord(response.result)
  )
    return undefined;
  return response.result.value;
}

function decodeTargetRead(value: unknown): TargetRead | undefined {
  if (!isCDPRecord(value) || value.connected !== true) return undefined;
  if (
    typeof value.disabled !== 'boolean' ||
    typeof value.editable !== 'boolean' ||
    typeof value.editor !== 'boolean' ||
    typeof value.autocompleteWarning !== 'boolean' ||
    typeof value.settleMs !== 'number'
  )
    return undefined;
  return {
    connected: true,
    disabled: value.disabled,
    editable: value.editable,
    editor: value.editor,
    autocompleteWarning: value.autocompleteWarning,
    settleMs: value.settleMs,
  };
}

async function callTarget(
  options: FormActionOptions,
  objectId: string,
  functionDeclaration: string,
  returnByValue: boolean,
): Promise<unknown> {
  options.lane.signal.throwIfAborted();
  const response = await options.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration,
      returnByValue,
      objectGroup: options.target.objectGroup,
    },
    options.target.identity.sessionId,
  );
  options.lane.signal.throwIfAborted();
  return returnByValue ? valueOf(response) : objectIdOf(response);
}

function refusal(
  code: BrowserActionError['code'],
  message: string,
): FormActionError {
  return new FormActionError({ code, message, retryable: false });
}

async function normalizedEditorTarget(
  options: FormActionOptions,
): Promise<NormalizedEditorTarget | undefined> {
  const response = await options.send(
    'Runtime.callFunctionOn',
    {
      objectId: options.target.objectId,
      functionDeclaration: EDITING_HOST_FUNCTION,
      returnByValue: false,
      objectGroup: options.target.objectGroup,
    },
    options.target.identity.sessionId,
  );
  options.lane.signal.throwIfAborted();
  const objectId = objectIdOf(response);
  if (!objectId) return undefined;
  const described = await options.send(
    'DOM.describeNode',
    { objectId, depth: 0 },
    options.target.identity.sessionId,
  );
  options.lane.signal.throwIfAborted();
  if (!isCDPRecord(described) || !isCDPRecord(described.node)) return undefined;
  const backendNodeId = readCDPInteger(described.node.backendNodeId);
  if (backendNodeId === undefined) return undefined;
  const target: ResolvedActionTarget = {
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
  return {
    target,
    ...(backendNodeId === options.target.identity.backendNodeId
      ? {}
      : { recordingTarget: target }),
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

function withAutocomplete(
  result: FormActionResult,
  read: TargetRead,
): FormActionResult {
  const metadata = autocompleteMetadata(read);
  const warnings = [...(result.warnings ?? []), ...(metadata.warnings ?? [])];
  return {
    ...result,
    ...(warnings.length ? { warnings } : {}),
    ...(metadata.settleMs === undefined ? {} : { settleMs: metadata.settleMs }),
  };
}

export interface RunTypeOptions extends FormActionOptions {
  text: string;
  delayMs?: number;
  targeted: boolean;
}

/** The type action: validate, optionally focus, then send trusted key events. */
export async function runType(
  options: RunTypeOptions,
): Promise<FormActionResult> {
  const rawRead = await callTarget(
    options,
    options.target.objectId,
    TYPE_TARGET_FUNCTION,
    true,
  );
  const read = decodeTargetRead(rawRead);
  if (!read)
    throw refusal('target_stale', 'The target is no longer available.');
  options.lane.signal.throwIfAborted();
  if (read.disabled)
    throw refusal('target_disabled', 'The target is disabled.');
  if (!read.editable)
    throw refusal('not_editable', 'The target is not editable.');

  const editorTarget = read.editor
    ? await normalizedEditorTarget(options)
    : undefined;
  const recordingTarget = editorTarget?.recordingTarget;
  options.lane.signal.throwIfAborted();
  // The editing host receives the keys and is what the receipt describes:
  // its secrecy is read before it is focused.
  if (editorTarget && options.classifyInputTarget)
    await options.classifyInputTarget(editorTarget.target);
  options.lane.signal.throwIfAborted();
  if (read.editor) options.onEditor?.();

  const warnings: string[] = [];
  if (options.targeted) {
    const focused = editorTarget
      ? await options.focus({
          objectId: editorTarget.target.objectId,
          backendNodeId: editorTarget.target.identity.backendNodeId,
        })
      : await options.focus();
    if (!focused.completed)
      return withAutocomplete(
        {
          inputMode: focused.inputMode,
          completed: false,
          dialog: focused.dialog,
          ...(read.editor ? { editor: true } : {}),
          ...(recordingTarget ? { recordingTarget } : {}),
        },
        read,
      );
    if (!focused.focused) {
      warnings.push(
        focused.warning ??
          'The target could not be focused; no text was typed.',
      );
      return withAutocomplete(
        {
          inputMode: focused.inputMode,
          completed: true,
          readback: { code: 'state_unchanged' },
          ...(warnings.length ? { warnings } : {}),
          ...(read.editor ? { editor: true } : {}),
          ...(recordingTarget ? { recordingTarget } : {}),
        },
        read,
      );
    }
  }

  // A targeted type stops once its target loses focus; an untargeted one
  // types into whatever has focus.
  const focusTarget = editorTarget?.target.objectId ?? options.target.objectId;
  const dispatched = await dispatchTyping({
    send: options.send,
    cleanupSend: options.cleanupSend,
    sessionId: options.target.identity.sessionId,
    lane: options.lane,
    beforeInput: options.beforeInput,
    text: options.text,
    delayMs: options.delayMs,
    getPendingDialog: options.getPendingDialog,
    ...(options.targeted
      ? {
          keepsFocus: async (): Promise<boolean> =>
            (await callTarget(
              options,
              focusTarget,
              HAS_FOCUS_FUNCTION,
              true,
            )) === true,
        }
      : {}),
  });
  if (dispatched.completed === false)
    return withAutocomplete(
      {
        inputMode: dispatched.inputMode,
        completed: false,
        dialog: dispatched.dialog,
        ...(read.editor ? { editor: true } : {}),
        ...(recordingTarget ? { recordingTarget } : {}),
      },
      read,
    );
  if (dispatched.focusLost) {
    warnings.push(
      'The target lost focus while typing, so the rest of the text was not typed.',
    );
    return withAutocomplete(
      {
        inputMode: dispatched.inputMode,
        completed: true,
        readback: { code: 'state_unchanged' },
        warnings,
        ...(read.editor ? { editor: true } : {}),
        ...(recordingTarget ? { recordingTarget } : {}),
      },
      read,
    );
  }
  return withAutocomplete(
    {
      inputMode: dispatched.inputMode,
      completed: true,
      ...(warnings.length ? { warnings } : {}),
      ...(read.editor ? { editor: true } : {}),
      ...(recordingTarget ? { recordingTarget } : {}),
    },
    read,
  );
}
