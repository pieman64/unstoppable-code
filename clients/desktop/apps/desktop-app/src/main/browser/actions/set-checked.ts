import type { BrowserActionTargetState } from '@canopy/desktop-shared/types/browser';
import { isCDPRecord, readCDPInteger } from '../frames/cdp-decode';
import { remoteObjectId, remoteValue } from '../frames/host-cdp';
import {
  FormActionError,
  type FormActionOptions,
  type FormActionResult,
} from './form-action';

type CheckedKind = 'checkbox' | 'radio' | 'aria';
type CheckedValue = boolean | 'mixed';

interface CheckedObservation {
  kind: CheckedKind;
  radio: boolean;
  checked: CheckedValue;
  disabled: boolean;
  hidden: boolean;
  hasLabel: boolean;
}

const CHECKED_OBSERVATION = `function() {
  const el = this;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
  const role = String(el.getAttribute('role') || '').toLowerCase();
  const kind = type === 'checkbox' || type === 'radio' ? type :
    ['checkbox', 'switch', 'radio', 'menuitemcheckbox'].includes(role) ? 'aria' : '';
  if (!kind) return { supported: false };
  const ariaValue = String(el.getAttribute('aria-checked') || '').toLowerCase();
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView;
  const clippedByOverflowAncestor = () => {
    const clips = value => ['hidden', 'clip', 'scroll', 'auto'].includes(value);
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = win ? win.getComputedStyle(ancestor) : null;
      const overflowX = ancestorStyle?.overflowX || ancestorStyle?.overflow || '';
      const overflowY = ancestorStyle?.overflowY || ancestorStyle?.overflow || '';
      const ancestorRect = ancestor.getBoundingClientRect();
      if (clips(overflowX) &&
          (rect.right <= ancestorRect.left || rect.left >= ancestorRect.right)) return true;
      if (clips(overflowY) &&
          (rect.bottom <= ancestorRect.top || rect.top >= ancestorRect.bottom)) return true;
    }
    return false;
  };
  const checked = kind === 'aria'
    ? (ariaValue === 'mixed' ? 'mixed' : ariaValue === 'true')
    : (el.indeterminate === true ? 'mixed' : el.checked === true);
  const labels = kind !== 'aria' && el.labels ? Array.from(el.labels) : [];
  const wrappingLabel = kind !== 'aria' ? el.closest('label') : null;
  const hasLabel = labels.length > 0 || !!wrappingLabel;
  const style = win ? win.getComputedStyle(el) : null;
  let disabled = el.matches(':disabled');
  for (let ancestor = el; !disabled && ancestor; ancestor = ancestor.parentElement) {
    disabled = (ancestor.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
  }
  const clipPath = String(style?.clipPath || '').trim().toLowerCase();
  const clip = String(style?.clip || '').trim().toLowerCase();
  const hidden = kind !== 'aria' && (
    rect.width <= 0 || rect.height <= 0 || style?.opacity === '0' ||
    style?.display === 'none' || style?.visibility === 'hidden' ||
    (clipPath !== '' && clipPath !== 'none') ||
    (clip !== '' && clip !== 'auto') ||
    clippedByOverflowAncestor()
  );
  return { supported: true, kind, radio: type === 'radio' || role === 'radio', checked, disabled, hidden, hasLabel };
}`;

const ASSOCIATED_LABEL = `function() {
  const labels = this.labels ? Array.from(this.labels) : [];
  return labels[0] || this.closest('label') || null;
}`;

const DIRECT_CLICK = `function() {
  this.click();
  const role = String(this.getAttribute('role') || '').toLowerCase();
  const type = this.tagName.toLowerCase() === 'input'
    ? String(this.type || '').toLowerCase() : '';
  if (type === 'checkbox' || type === 'radio')
    return { checked: this.indeterminate === true ? 'mixed' : this.checked === true };
  const value = String(this.getAttribute('aria-checked') || '').toLowerCase();
  return { checked: value === 'mixed' ? 'mixed' : value === 'true', role };
}`;

const READ_CHECKED = `function() {
  const type = this.tagName.toLowerCase() === 'input'
    ? String(this.type || '').toLowerCase() : '';
  if (type === 'checkbox' || type === 'radio')
    return { checked: this.indeterminate === true ? 'mixed' : this.checked === true };
  const value = String(this.getAttribute('aria-checked') || '').toLowerCase();
  return { checked: value === 'mixed' ? 'mixed' : value === 'true' };
}`;

function checkedValue(value: unknown): CheckedValue | undefined {
  return value === true || value === false || value === 'mixed'
    ? value
    : undefined;
}

function observation(value: unknown): CheckedObservation | undefined {
  if (!isCDPRecord(value) || value.supported !== true) return undefined;
  const kind = value.kind;
  const checked = checkedValue(value.checked);
  if (
    (kind !== 'checkbox' && kind !== 'radio' && kind !== 'aria') ||
    checked === undefined
  )
    return undefined;
  return {
    kind,
    radio: value.radio === true,
    checked,
    disabled: value.disabled === true,
    hidden: value.hidden === true,
    hasLabel: value.hasLabel === true,
  };
}

function matchesRequested(
  kind: CheckedKind,
  actual: CheckedValue,
  requested: boolean,
): boolean {
  return (
    actual === requested ||
    (kind === 'aria' && actual === 'mixed' && !requested)
  );
}

function refusal(
  code: 'unsupported_control' | 'target_disabled',
  message: string,
): FormActionError {
  return new FormActionError({
    code,
    message,
    retryable: code === 'target_disabled',
  });
}

async function callPage(
  options: FormActionOptions,
  functionDeclaration: string,
  returnByValue = true,
  userGesture = false,
): Promise<unknown> {
  const response = await options.send(
    'Runtime.callFunctionOn',
    {
      objectId: options.target.objectId,
      functionDeclaration,
      returnByValue,
      ...(userGesture ? { userGesture: true } : {}),
    },
    options.target.identity.sessionId,
  );
  return returnByValue ? remoteValue(response) : response;
}

async function labelTarget(
  options: FormActionOptions,
): Promise<{ objectId: string; backendNodeId: number } | undefined> {
  const response = await callPage(options, ASSOCIATED_LABEL, false);
  const objectId = remoteObjectId(response);
  if (!objectId) return undefined;
  const described = await options.send(
    'DOM.describeNode',
    { objectId },
    options.target.identity.sessionId,
  );
  const node =
    isCDPRecord(described) && isCDPRecord(described.node)
      ? described.node
      : undefined;
  const backendNodeId = readCDPInteger(node?.backendNodeId);
  return backendNodeId === undefined ? undefined : { objectId, backendNodeId };
}

async function releaseObject(
  options: FormActionOptions,
  objectId: string,
): Promise<void> {
  await (options.cleanupSend ?? options.send)(
    'Runtime.releaseObject',
    { objectId },
    options.target.identity.sessionId,
  ).catch(() => undefined);
}

async function readChecked(options: FormActionOptions): Promise<CheckedValue> {
  const result = await callPage(options, READ_CHECKED);
  const checked = isCDPRecord(result)
    ? checkedValue(result.checked)
    : undefined;
  if (checked === undefined)
    throw new Error('Could not read the checked state.');
  return checked;
}

function targetState(checked: CheckedValue): Partial<BrowserActionTargetState> {
  return { checked };
}

/** Set a native or ARIA checked state through real input, then verify it. */
export async function runSetChecked(
  options: FormActionOptions & { checked: boolean },
): Promise<FormActionResult> {
  const initial = observation(await callPage(options, CHECKED_OBSERVATION));
  if (!initial)
    throw refusal(
      'unsupported_control',
      'This element is not a checkbox, radio button, switch, or menu item checkbox.',
    );
  if (initial.disabled)
    throw refusal('target_disabled', 'This checked control is disabled.');
  if (initial.radio && initial.checked === true && !options.checked)
    throw refusal(
      'unsupported_control',
      'A radio button cannot be unchecked. Check another option in its group.',
    );
  if (matchesRequested(initial.kind, initial.checked, options.checked))
    return { target: targetState(initial.checked) };

  let clickTarget = {
    objectId: options.target.objectId,
    backendNodeId: options.target.identity.backendNodeId,
  };
  let releaseClickTarget: string | undefined;
  if (initial.hidden && initial.hasLabel) {
    const related = await labelTarget(options);
    if (related) {
      clickTarget = related;
      releaseClickTarget = related.objectId;
    }
  }

  try {
    const clicked = await options.click(clickTarget);
    if (!clicked.completed)
      return {
        inputMode: clicked.inputMode,
        completed: false,
        dialog: clicked.dialog,
      };
    const afterRealClick = await readChecked(options);
    if (matchesRequested(initial.kind, afterRealClick, options.checked))
      return {
        inputMode: clicked.inputMode,
        target: targetState(afterRealClick),
      };

    options.lane.signal.throwIfAborted();
    options.lane.beginDispatch();
    await callPage(options, DIRECT_CLICK, true, true);
    const finalChecked = await readChecked(options);
    if (matchesRequested(initial.kind, finalChecked, options.checked))
      return {
        inputMode: 'synthetic',
        target: targetState(finalChecked),
      };
    return {
      inputMode: 'synthetic',
      readback: { code: 'state_unchanged' },
      warnings: ['The page did not change the checked state after a click.'],
      target: targetState(finalChecked),
    };
  } finally {
    if (releaseClickTarget) await releaseObject(options, releaseClickTarget);
  }
}
