import type {
  BrowserActionError,
  BrowserActionTargetState,
  BrowserInputOption,
  BrowserOptionChoice,
} from '@canopy/desktop-shared/types/browser';
import {
  isCDPRecord,
  readCDPArray,
  readCDPInteger,
  readCDPString,
} from '../frames/cdp-decode';
import { SECRET_AUTOCOMPLETE_TOKENS } from '@canopy/desktop-shared/browser/secret-fields';
import { remoteObjectId, remoteValue } from '../frames/host-cdp';
import { ARIA_OPTION_ELEMENTS_FUNCTION } from '../frames/target-state';
import {
  FormActionError,
  type FormActionOptions,
  type FormActionResult,
} from './form-action';
import {
  dispatchTyping,
  HAS_FOCUS_FUNCTION,
  type TypingDispatchOptions,
} from './type';

interface OptionRow extends BrowserInputOption {
  index: number;
  hidden: boolean;
}

interface SelectionObservation {
  kind: 'native' | 'listbox' | 'combobox' | 'unsupported';
  multiple: boolean;
  targetDisabled: boolean;
  listFound: boolean;
  choiceCount: number;
  matches: number[];
  missingCount: number;
  allValuesEmpty: boolean;
  disabled: boolean;
  hidden: boolean;
  disabledLabel?: string;
  already: boolean;
  verified?: boolean;
  /** A combobox whose named list is already open (`aria-expanded`). */
  expanded?: boolean;
  /** The list has its own secret autocomplete token; its options were withheld. */
  secretList?: boolean;
  optionCount: number;
  options?: OptionRow[];
}

const NATIVE_VERIFY_SETTLE_MS = 50;
const COMBO_OPEN_SETTLE_MS = 50;
const COMBO_SEARCH_SETTLE_MS = 450;

/**
 * The options a list control offers: a listbox's own options, or every
 * option in the elements a combobox names with `aria-controls` or
 * `aria-owns`, looked up in the combobox's own tree (its document or shadow
 * root). The inspection and the option click share it, so an index names the
 * same element in both.
 */
/** Whether an element's autocomplete names a secret field, as in the page model. */
const SECRET_AUTOCOMPLETE_FUNCTION = `(element) => {
  const tokens = new Set(${JSON.stringify(Array.from(SECRET_AUTOCOMPLETE_TOKENS))});
  return String(element.getAttribute('autocomplete') || '')
    .toLowerCase().split(/\\s+/).some(token => tokens.has(token));
}`;

const ARIA_ROWS_FUNCTION = `(el, combobox) => {
  if (!combobox) return { found: true, rows: (${ARIA_OPTION_ELEMENTS_FUNCTION})(el), secret: false };
  const secretList = ${SECRET_AUTOCOMPLETE_FUNCTION};
  const scope = el.getRootNode();
  const names = [
    ...String(el.getAttribute('aria-controls') || '').split(/\\s+/),
    ...String(el.getAttribute('aria-owns') || '').split(/\\s+/)
  ].filter(Boolean);
  const rows = [];
  let found = false;
  let secret = false;
  for (const name of names) {
    const container = typeof scope.getElementById === 'function' ? scope.getElementById(name) : null;
    if (!container) continue;
    found = true;
    // A list is secret, as in the page model, when it has its own secret
    // autocomplete token, or when a secret control in the same tree names
    // it, even when the combobox that opens it is not secret.
    if ([container, ...Array.from(container.querySelectorAll('[role="listbox"]'))].some(secretList))
      secret = true;
    // So is one inside a secret list.
    for (let node = container.parentElement; node; node = node.parentElement)
      if (secretList(node)) secret = true;
    const namedBySecret = Array.from(scope.querySelectorAll('[aria-controls], [aria-owns]')).some(control => {
      const ids = [
        ...String(control.getAttribute('aria-controls') || '').split(/\\s+/),
        ...String(control.getAttribute('aria-owns') || '').split(/\\s+/)
      ];
      if (!ids.includes(name)) return false;
      const type = String(control.getAttribute('type') || '').toLowerCase();
      return (control.tagName === 'INPUT' && type === 'password') || secretList(control);
    });
    if (namedBySecret) secret = true;
    for (const option of (${ARIA_OPTION_ELEMENTS_FUNCTION})(container))
      if (!rows.includes(option)) rows.push(option);
  }
  return { found, rows, secret };
}`;

const SELECT_INSPECT = `function(choice, secret, afterOpen, verifyIndex, afterApply, typed) {
  const verifying = typeof verifyIndex === 'number';
  const el = this;
  const view = el.ownerDocument.defaultView;
  const normalizeSpace = value => String(value || '').replace(/\\s+/g, ' ').trim();
  const labelFor = option => normalizeSpace(
    option.hasAttribute('label') ? option.getAttribute('label') : option.textContent
  );
  const role = String(el.getAttribute('role') || '').toLowerCase();
  const native = el.tagName.toLowerCase() === 'select';
  const listbox = !native && role === 'listbox';
  const combobox = !native && role === 'combobox';
  if (!native && !listbox && !combobox)
    return { kind: 'unsupported' };
  // The option a click was about to choose, kept in this isolated world so
  // it can be checked after a popup that unmounts on select.
  const expectations = globalThis.__canopySelectExpectations ||
    (globalThis.__canopySelectExpectations = new WeakMap());
  // aria-disabled on the control or an ancestor disables it too.
  let ariaDisabled = false;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement)
    if ((node.getAttribute('aria-disabled') || '').toLowerCase() === 'true') ariaDisabled = true;
  const targetDisabled = el.matches(':disabled') || ariaDisabled;

  const key = Array.isArray(choice.values) ? 'values' :
    Array.isArray(choice.labels) ? 'labels' : 'indexes';
  const requested = Array.isArray(choice[key]) ? choice[key] : [];
  const distinct = [];
  for (const entry of requested) {
    const normalized = key === 'indexes'
      ? String(entry)
      : key === 'labels'
        ? normalizeSpace(entry).toLowerCase()
        : String(entry).toLowerCase();
    if (!distinct.some(item => item.normalized === normalized))
      distinct.push({ entry, normalized });
  }
  const emptyResult = {
    kind: native ? 'native' : listbox ? 'listbox' : 'combobox',
    multiple: native && el.multiple === true,
    targetDisabled,
    listFound: false,
    choiceCount: distinct.length,
    matches: [],
    missingCount: distinct.length,
    allValuesEmpty: false,
    disabled: false,
    already: false,
    optionCount: 0
  };
  let rows = [];
  let listFound = true;
  let expanded = false;
  // A select or listbox can gain a secret autocomplete token, for example on
  // focus; from then on it is treated as secret.
  let listSecret = (${SECRET_AUTOCOMPLETE_FUNCTION})(el);
  if (native) {
    rows = Array.from(el.options);
  } else {
    const collected = (${ARIA_ROWS_FUNCTION})(el, combobox);
    // An open combobox is read as it is; opening one that toggles would
    // close it.
    expanded = combobox && collected.found &&
      String(el.getAttribute('aria-expanded') || '').toLowerCase() === 'true';
    if (combobox && afterOpen !== true && !expanded) return emptyResult;
    rows = collected.rows;
    listFound = collected.found;
    listSecret = listSecret || collected.secret;
    if (!listFound && !verifying) return { ...emptyResult, listFound: false };
  }

  const descriptor = option => {
    const label = native ? labelFor(option) : normalizeSpace(option.textContent);
    // An ARIA option without a value attribute is known by its label, as
    // snapshot rows and receipts give it.
    const value = native
      ? String(option.value)
      : (option.getAttribute('data-value') ?? option.getAttribute('value') ?? label);
    const selected = native
      ? option.selected === true
      : (option.getAttribute('aria-selected') || '').toLowerCase() === 'true';
    const disabled = native
      ? option.disabled === true || !!option.closest('optgroup[disabled]')
      : (option.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    let hidden = false;
    for (let node = option; node && node !== el; node = node.parentElement) {
      const style = view ? view.getComputedStyle(node) : null;
      if (
        node.hasAttribute('hidden') ||
        (node.getAttribute('aria-hidden') || '').toLowerCase() === 'true' ||
        style?.display === 'none' ||
        style?.visibility === 'hidden'
      ) {
        hidden = true;
        break;
      }
    }
    return { value, label, selected, disabled, hidden };
  };
  const descriptors = rows.map(descriptor);
  const matches = [];
  let missingCount = 0;
  // The options the first attempt chose, kept in this isolated world. After
  // it, an index means that option wherever it now is: a focus handler may
  // have reordered the options.
  const plans = globalThis.__canopySelectPlans ||
    (globalThis.__canopySelectPlans = new WeakMap());
  const plan = native && afterApply === true && key === 'indexes' ? plans.get(el) : undefined;
  if (native && afterApply !== true) plans.delete(el);
  for (const request of distinct) {
    let index = descriptors.findIndex((row, rowIndex) => {
      if (plan) return rows[rowIndex] === plan[distinct.indexOf(request)];
      if (key === 'indexes') return rowIndex === request.entry;
      if (key === 'labels')
        return row.label.toLowerCase() === request.normalized;
      return row.value.toLowerCase() === request.normalized;
    });
    // As Playwright's selectOption(string): a value no option has matches a label.
    if (index < 0 && key === 'values' && !plan) {
      const label = normalizeSpace(request.entry).toLowerCase();
      index = descriptors.findIndex(row => row.label.toLowerCase() === label);
    }
    if (index < 0) missingCount += 1;
    else if (!matches.includes(index)) matches.push(index);
  }
  const disabledIndex = matches.find(index => descriptors[index]?.disabled === true);
  const hiddenIndex = matches.find(index => descriptors[index]?.hidden === true);
  const selectedIndexes = descriptors
    .map((row, index) => row.selected ? index : -1)
    .filter(index => index >= 0);
  // A button has a value property too, but shows its text.
  const showsValue = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  const comboValue = normalizeSpace(showsValue ? el.value : el.textContent);
  // A list that takes several options: there aria-selected is the selection.
  const multiple = index =>
    (rows[index].closest('[role="listbox"]')?.getAttribute('aria-multiselectable') || '')
      .toLowerCase() === 'true';
  // In a combobox popup aria-selected can mark the highlighted option, not
  // the chosen one. It is the choice when the list takes several options,
  // or when the combobox itself shows the option's label and this action
  // typed no search text, which would be what it shows.
  const chosen = index => !combobox || multiple(index) ||
    (typeof typed !== 'string' &&
      comboValue.toLowerCase() === descriptors[index].label.toLowerCase());
  // Complete only when every requested option is there.
  const already = missingCount === 0 && (native
    ? matches.length === selectedIndexes.length &&
      matches.every(index => selectedIndexes.includes(index))
    : matches.length === 1 && selectedIndexes.includes(matches[0]) &&
      chosen(matches[0]));
  const hide = secret || listSecret;
  let verified;
  const sameLabelCount = label => descriptors
    .filter(item => item.label.toLowerCase() === label.toLowerCase()).length;
  if (!native && !verifying && matches.length > 0) {
    const chosen = descriptors[matches[0]];
    if (chosen) expectations.set(el, {
      label: chosen.label,
      value: chosen.value,
      uniqueLabel: sameLabelCount(chosen.label) === 1
    });
  }
  if (verifying && !native) {
    const expected = expectations.get(el) ?? descriptors[verifyIndex];
    expectations.delete(el);
    const rowIndex = expected
      ? descriptors.findIndex(item => item.label === expected.label && item.value === expected.value)
      : -1;
    const row = rowIndex < 0 ? undefined : descriptors[rowIndex];
    // The shown text proves the choice only when no other option has its label.
    const labelTells = !!expected && expected.uniqueLabel !== false &&
      sameLabelCount(expected.label) <= 1;
    // What held before the click holds after it. While a combobox's list
    // still shows the option, aria-selected can be the highlight, and a
    // label this action typed as search text proves nothing. Once the list
    // has closed, or in a list that takes several options, aria-selected is
    // the selection.
    const open = combobox && !!row && row.hidden !== true;
    const selection = row?.selected === true && (!open || multiple(rowIndex));
    const typedLabel = typeof typed === 'string' && !!expected &&
      normalizeSpace(typed).toLowerCase() === expected.label.toLowerCase();
    const text = combobox && labelTells && !(open && typedLabel) &&
      comboValue.toLowerCase() === expected.label.toLowerCase();
    verified = !!expected && (selection || text);
  }
  const result = {
    kind: native ? 'native' : listbox ? 'listbox' : 'combobox',
    multiple: native && el.multiple === true,
    targetDisabled,
    listFound,
    choiceCount: distinct.length,
    matches,
    missingCount,
    allValuesEmpty: rows.length === 0 || rows.every(option => String(option.value ?? '') === ''),
    disabled: disabledIndex !== undefined,
    hidden: hiddenIndex !== undefined,
    already,
    optionCount: rows.length,
    ...(expanded ? { expanded: true } : {}),
    ...(listSecret ? { secretList: true } : {}),
    ...(disabledIndex === undefined || hide
      ? {}
      : { disabledLabel: descriptors[disabledIndex]?.label || '' }),
    ...(verified === undefined ? {} : { verified })
  };
  return hide
    ? result
    : {
        ...result,
        options: descriptors.map((row, index) => ({ ...row, index }))
      };
}`;

/** Whether a native select is disabled, by itself, a fieldset, or aria-disabled. */
const NATIVE_SELECT_DISABLED_FUNCTION = `(select) => {
  if (select.matches(':disabled')) return true;
  for (let node = select; node && node.nodeType === 1; node = node.parentElement)
    if ((node.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
  return false;
}`;

const NATIVE_OPTION_DISABLED_FUNCTION = `(option) =>
  option.disabled === true || !!option.closest('optgroup[disabled]')`;

const NATIVE_APPLY = `function(indexes) {
  const select = this;
  const selectDisabled = ${NATIVE_SELECT_DISABLED_FUNCTION};
  const optionDisabled = ${NATIVE_OPTION_DISABLED_FUNCTION};
  // A handler can give the select a secret token and take it away again
  // before this returns, so it is looked for after each step.
  const hasSecretToken = ${SECRET_AUTOCOMPLETE_FUNCTION};
  let secret = false;
  const note = () => { if (hasSecretToken(select)) secret = true; };
  // A focus handler can reorder or replace the options, so the planned ones
  // are found again after focus: the same element, or else one with the same
  // value and label.
  const planned = indexes
    .map(index => select.options[index])
    .filter(Boolean)
    .map(option => ({ option, value: option.value, label: option.label }));
  select.focus();
  note();
  const current = Array.from(select.options);
  const wanted = new Set();
  const chosen = planned.map(item => {
    let index = current.indexOf(item.option);
    if (index < 0)
      index = current.findIndex((option, position) =>
        !wanted.has(position) && option.value === item.value && option.label === item.label);
    if (index < 0) return undefined;
    wanted.add(index);
    return current[index];
  });
  if (!globalThis.__canopySelectPlans) globalThis.__canopySelectPlans = new WeakMap();
  globalThis.__canopySelectPlans.set(select, chosen);
  const selectedNow = () => Array.from(select.options, (option, index) => option.selected ? index : -1)
    .filter(index => index >= 0);
  // A focus handler that removed a requested option, or disabled the select
  // or an option, leaves the selection as it was.
  if (chosen.some(option => !option || optionDisabled(option)) || selectDisabled(select)) {
    select.blur();
    note();
    return { selected: selectedNow(), secret };
  }
  for (let index = 0; index < current.length; index++)
    current[index].selected = wanted.has(index);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  note();
  select.dispatchEvent(new Event('change', { bubbles: true }));
  note();
  select.blur();
  note();
  return { selected: selectedNow(), secret };
}`;

const NATIVE_FALLBACK = `function(indexes, multiple) {
  const select = this;
  const selectDisabled = ${NATIVE_SELECT_DISABLED_FUNCTION};
  const optionDisabled = ${NATIVE_OPTION_DISABLED_FUNCTION};
  const hasSecretToken = ${SECRET_AUTOCOMPLETE_FUNCTION};
  let secret = false;
  const note = () => { if (hasSecretToken(select)) secret = true; };
  const selectedNow = () => Array.from(select.options, (option, index) => option.selected ? index : -1)
    .filter(index => index >= 0);
  const wanted = new Set(indexes);
  if (multiple) {
    for (let index = 0; index < select.options.length; index++)
      select.options[index].selected = wanted.has(index);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    note();
  } else {
    const index = indexes[0];
    const option = index === undefined ? undefined : select.options[index];
    if (!option) return { selected: [], secret };
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    note();
    // A mousedown handler can move, remove, or disable the option: it is
    // found again by identity, and is not chosen if it is gone or disabled.
    const current = Array.from(select.options).indexOf(option);
    if (current < 0 || optionDisabled(option) || selectDisabled(select))
      return { selected: selectedNow(), secret };
    select.selectedIndex = current;
    option.click();
    note();
    select.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    note();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    note();
    select.blur();
    note();
  }
  return { selected: selectedNow(), secret };
}`;

const ARIA_OPTION_AT_INDEX = `function(index) {
  const el = this;
  const combobox = String(el.getAttribute('role') || '').toLowerCase() === 'combobox';
  const rows = (${ARIA_ROWS_FUNCTION})(el, combobox).rows;
  return rows[index] || null;
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readOptions(value: unknown): OptionRow[] | undefined {
  const raw = readCDPArray(value);
  if (!raw) return undefined;
  const options: OptionRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    const index = readCDPInteger(item.index);
    const value = readCDPString(item.value);
    const label = readCDPString(item.label);
    const selected = readBoolean(item.selected);
    const disabled = readBoolean(item.disabled);
    const hidden = readBoolean(item.hidden);
    if (
      index === undefined ||
      value === undefined ||
      label === undefined ||
      selected === undefined ||
      disabled === undefined ||
      hidden === undefined
    )
      return undefined;
    options.push({ index, value, label, selected, disabled, hidden });
  }
  return options;
}

function observation(value: unknown, secret: boolean): SelectionObservation {
  if (!isRecord(value)) throw new Error('Could not read the select options.');
  const kind = value.kind;
  if (
    kind !== 'native' &&
    kind !== 'listbox' &&
    kind !== 'combobox' &&
    kind !== 'unsupported'
  )
    throw new Error('Could not read the select options.');
  const options =
    secret || value.secretList === true
      ? undefined
      : readOptions(value.options);
  return {
    kind,
    multiple: value.multiple === true,
    targetDisabled: value.targetDisabled === true,
    listFound: value.listFound === true,
    choiceCount: readCDPInteger(value.choiceCount) ?? 0,
    matches: (readCDPArray(value.matches) ?? []).flatMap((item) => {
      const index = readCDPInteger(item);
      return index === undefined ? [] : [index];
    }),
    missingCount: readCDPInteger(value.missingCount) ?? 0,
    allValuesEmpty: value.allValuesEmpty === true,
    disabled: value.disabled === true,
    hidden: value.hidden === true,
    ...(secret
      ? {}
      : typeof value.disabledLabel === 'string'
        ? { disabledLabel: value.disabledLabel }
        : {}),
    already: value.already === true,
    ...(typeof value.verified === 'boolean'
      ? { verified: value.verified }
      : {}),
    ...(value.expanded === true ? { expanded: true } : {}),
    ...(value.secretList === true ? { secretList: true } : {}),
    optionCount: readCDPInteger(value.optionCount) ?? 0,
    ...(secret || options === undefined ? {} : { options }),
  };
}

function targetOptions(observed: SelectionObservation): BrowserInputOption[] {
  return (observed.options ?? [])
    .slice(0, 50)
    .map(({ value, label, selected, disabled }) => ({
      value,
      label,
      selected,
      disabled,
    }));
}

function selectedOptions(
  observed: SelectionObservation,
): Array<{ value: string; label: string }> {
  return (observed.options ?? [])
    .filter((option) => option.selected)
    .map(({ value, label }) => ({ value, label }));
}

function targetState(
  observed: SelectionObservation,
  secret: boolean,
  includeOptions = false,
): Partial<BrowserActionTargetState> {
  if (secret) return { optionsRedacted: true };
  return {
    selectedOptions: selectedOptions(observed),
    ...(includeOptions ? { options: targetOptions(observed) } : {}),
  };
}

function optionMessage(
  kind: 'native' | 'aria',
  issue: 'missing' | 'disabled' | 'list' | 'hidden' | 'stale' | 'unchanged',
  label?: string,
  secret = false,
): string {
  if (issue === 'missing') return 'No option matched the requested choice.';
  if (issue === 'list') return 'The combobox did not expose its option list.';
  if (issue === 'hidden') return 'The requested option is not visible.';
  if (issue === 'stale') return 'The requested option is no longer available.';
  if (issue === 'unchanged')
    return 'The list did not keep the requested option selection.';
  if (secret) return 'The requested option is disabled.';
  return label
    ? `The option '${label}' is disabled.`
    : `The requested ${kind === 'native' ? 'select option' : 'list option'} is disabled.`;
}

function throwChoiceError(
  code: BrowserActionError['code'],
  message: string,
  secret: boolean,
  options?: BrowserInputOption[],
): never {
  throw new FormActionError({
    code,
    message,
    retryable: code === 'target_disabled',
    ...(options === undefined || secret ? {} : { options }),
    ...(secret ? { candidatesRedacted: true } : {}),
  });
}

async function callPage(
  options: FormActionOptions,
  functionDeclaration: string,
  arguments_: readonly unknown[] = [],
  returnByValue = true,
  userGesture = false,
): Promise<unknown> {
  const response = await options.send(
    'Runtime.callFunctionOn',
    {
      objectId: options.target.objectId,
      functionDeclaration,
      arguments: arguments_.map((value) => ({ value })),
      returnByValue,
      ...(userGesture ? { userGesture: true } : {}),
    },
    options.target.identity.sessionId,
  );
  return returnByValue ? remoteValue(response) : response;
}

async function inspect(
  options: FormActionOptions,
  choice: BrowserOptionChoice,
  afterOpen: boolean,
  verifyIndex?: number,
  afterApply = false,
  typed?: string,
): Promise<SelectionObservation> {
  return observation(
    await callPage(options, SELECT_INSPECT, [
      choice,
      options.secret,
      afterOpen,
      verifyIndex ?? null,
      afterApply,
      typed ?? null,
    ]),
    options.secret,
  );
}

async function clickOption(
  options: FormActionOptions,
  index: number,
): Promise<{ objectId: string; backendNodeId: number } | undefined> {
  const response = await callPage(
    options,
    ARIA_OPTION_AT_INDEX,
    [index],
    false,
  );
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
  if (backendNodeId === undefined) {
    await releaseObject(options, objectId);
    return undefined;
  }
  return { objectId, backendNodeId };
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

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function optionsForError(
  observed: SelectionObservation,
  secret: boolean,
): BrowserInputOption[] | undefined {
  return secret ? undefined : targetOptions(observed);
}

function comboFailure(
  observed: SelectionObservation,
  secret: boolean,
  issue: 'missing' | 'disabled' | 'list' | 'hidden' | 'stale' | 'unchanged',
  settleMs?: number,
): FormActionResult {
  const label = secret ? undefined : observed.disabledLabel;
  return {
    inputMode: 'trusted',
    readback: { code: 'state_unchanged' },
    warnings: [
      // An option in a list that is still open can carry aria-selected as
      // the highlight, so the combobox is what has to show the choice.
      issue === 'unchanged'
        ? 'The combobox did not show the requested option as its choice.'
        : optionMessage('aria', issue, label, secret),
    ],
    target: targetState(observed, secret, true),
    ...(settleMs === undefined ? {} : { settleMs }),
  };
}

async function runNativeSelect(
  options: FormActionOptions,
  choice: BrowserOptionChoice,
): Promise<FormActionResult> {
  // A select can become secret, for example on focus; once it is, nothing
  // about its options is reported.
  let secret = options.secret;
  const latchSecret = (): void => {
    secret = true;
    options.markSecret?.();
  };
  const look = async (afterApply = false): Promise<SelectionObservation> => {
    const seen = await inspect(
      { ...options, secret },
      choice,
      false,
      undefined,
      afterApply,
    );
    if (seen.secretList === true) latchSecret();
    return seen;
  };
  // A handler can mark the select secret and take the mark away within one
  // page call, where no later read sees it; the call reports it.
  const apply = async (
    declaration: string,
    arguments_: unknown[],
  ): Promise<void> => {
    const applied = await callPage(
      options,
      declaration,
      arguments_,
      true,
      true,
    );
    if (isCDPRecord(applied) && applied.secret === true) latchSecret();
  };
  let observed = await look();
  if (observed.kind !== 'native')
    throwChoiceError(
      'unsupported_control',
      'This element is not a select.',
      secret,
    );
  if (observed.targetDisabled)
    throwChoiceError('target_disabled', 'The select is disabled.', secret);
  if (!observed.multiple && observed.choiceCount > 1)
    throwChoiceError(
      'unsupported_control',
      'This select takes one option.',
      secret,
    );

  let lazyFocusMode: 'trusted' | undefined;
  if (observed.missingCount > 0 && observed.allValuesEmpty) {
    const focused = await options.focus();
    lazyFocusMode = focused.inputMode;
    if (!focused.completed)
      return {
        inputMode: focused.inputMode,
        completed: false,
        dialog: focused.dialog,
      };
    let elapsed = 0;
    while (observed.missingCount > 0 && elapsed < 1_000) {
      options.lane.signal.throwIfAborted();
      await delay(100);
      options.lane.signal.throwIfAborted();
      elapsed += 100;
      observed = await look();
      if (observed.kind !== 'native') break;
    }
    if (observed.kind !== 'native')
      throw new Error('The select was no longer available after focus.');
    if (observed.targetDisabled)
      return {
        inputMode: lazyFocusMode,
        readback: { code: 'state_unchanged' },
        warnings: ['The select became disabled after it was focused.'],
        target: targetState(observed, secret, true),
      };
    if (observed.missingCount > 0) {
      return {
        inputMode: lazyFocusMode,
        readback: { code: 'state_unchanged' },
        warnings: [
          'The requested option did not appear after focusing the select.',
        ],
        target: targetState(observed, secret, true),
      };
    }
    if (observed.disabled)
      return {
        inputMode: lazyFocusMode,
        readback: { code: 'state_unchanged' },
        warnings: [
          optionMessage('native', 'disabled', observed.disabledLabel, secret),
        ],
        target: targetState(observed, secret, true),
      };
  } else if (observed.missingCount > 0) {
    throwChoiceError(
      'option_not_found',
      optionMessage('native', 'missing'),
      secret,
      optionsForError(observed, secret),
    );
  }

  if (observed.disabled)
    throwChoiceError(
      'target_disabled',
      optionMessage('native', 'disabled', observed.disabledLabel, secret),
      secret,
    );
  if (observed.already)
    return {
      ...(lazyFocusMode === undefined ? {} : { inputMode: lazyFocusMode }),
      target: targetState(observed, secret),
    };

  options.lane.signal.throwIfAborted();
  options.lane.beginDispatch();
  await apply(NATIVE_APPLY, [observed.matches]);
  await delay(NATIVE_VERIFY_SETTLE_MS);
  options.lane.signal.throwIfAborted();
  let final = await look(true);
  if (final.already)
    return { inputMode: 'direct', target: targetState(final, secret) };
  if (final.targetDisabled)
    return {
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
      warnings: ['The select became disabled after it was focused.'],
      target: targetState(final, secret),
    };
  if (final.disabled)
    return {
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
      warnings: [
        optionMessage('native', 'disabled', final.disabledLabel, secret),
      ],
      target: targetState(final, secret),
    };

  // The page removed or replaced the requested option: a second attempt
  // would have nothing to select.
  if (final.missingCount > 0 || final.matches.length === 0)
    return {
      inputMode: 'direct',
      readback: { code: 'state_unchanged' },
      warnings: ['The requested option is no longer available.'],
      target: targetState(final, secret),
    };
  options.lane.signal.throwIfAborted();
  options.lane.beginDispatch();
  // The options as they are now, after the first attempt's focus.
  await apply(NATIVE_FALLBACK, [final.matches, observed.multiple]);
  await delay(NATIVE_VERIFY_SETTLE_MS);
  options.lane.signal.throwIfAborted();
  final = await look(true);
  if (final.already)
    return { inputMode: 'direct', target: targetState(final, secret) };
  return {
    inputMode: 'direct',
    readback: { code: 'state_unchanged' },
    warnings: ['The select did not keep the requested option selection.'],
    target: targetState(final, secret),
  };
}

async function runAriaSelect(
  options: FormActionOptions,
  choice: BrowserOptionChoice,
  searchText?: string,
): Promise<FormActionResult> {
  // A list that appears when the combobox opens can be secret even though
  // the combobox is not; once one is seen, nothing about it is reported.
  let secret = options.secret;
  const look = async (
    afterOpen: boolean,
    verifyIndex?: number,
  ): Promise<SelectionObservation> => {
    const seen = await inspect(
      { ...options, secret },
      choice,
      afterOpen,
      verifyIndex,
      false,
      searchText,
    );
    if (seen.secretList === true) {
      secret = true;
      options.markSecret?.();
    }
    return seen;
  };
  let observed = await look(false);
  if (observed.kind === 'unsupported')
    throwChoiceError(
      'unsupported_control',
      'This element is not a select, listbox, or combobox.',
      secret,
    );
  if (observed.kind === 'native') return runNativeSelect(options, choice);
  if (observed.targetDisabled)
    throwChoiceError(
      'target_disabled',
      'The list control is disabled.',
      secret,
    );
  if (observed.choiceCount > 1)
    throwChoiceError(
      'unsupported_control',
      'This list takes one option.',
      secret,
    );

  let settleMs: number | undefined;
  // A combobox that is already open is read like a listbox, before any
  // input: clicking it would close one that toggles. With searchText it is
  // focused instead, for the typing.
  const alreadyOpen =
    observed.kind === 'combobox' &&
    observed.expanded === true &&
    searchText === undefined;
  if (observed.kind === 'listbox' || alreadyOpen) {
    if (observed.missingCount > 0)
      throwChoiceError(
        'option_not_found',
        optionMessage('aria', 'missing'),
        secret,
        optionsForError(observed, secret),
      );
    if (observed.disabled)
      throwChoiceError(
        'target_disabled',
        optionMessage('aria', 'disabled', observed.disabledLabel, secret),
        secret,
      );
    if (observed.hidden)
      throwChoiceError(
        'target_not_visible',
        optionMessage('aria', 'hidden'),
        secret,
        optionsForError(observed, secret),
      );
    if (observed.already) return { target: targetState(observed, secret) };
  } else {
    const opened = observed.expanded
      ? await options.focus()
      : await options.click({
          objectId: options.target.objectId,
          backendNodeId: options.target.identity.backendNodeId,
        });
    if (!opened.completed)
      return {
        inputMode: opened.inputMode,
        completed: false,
        dialog: opened.dialog,
      };
    if (searchText !== undefined) {
      // Keys go to whatever has focus, and opening can move it.
      const focused = (await callPage(options, HAS_FOCUS_FUNCTION)) === true;
      if (!focused)
        return {
          inputMode: opened.inputMode,
          readback: { code: 'state_unchanged' },
          warnings: [
            'The combobox did not keep focus, so the search text was not typed.',
          ],
          target: targetState(observed, secret, true),
        };
      const typingOptions: TypingDispatchOptions = {
        send: options.send,
        lane: options.lane,
        sessionId: options.target.identity.sessionId,
        text: searchText,
        ...(options.cleanupSend === undefined
          ? {}
          : { cleanupSend: options.cleanupSend }),
        ...(options.beforeInput === undefined
          ? {}
          : { beforeInput: options.beforeInput }),
        ...(options.getPendingDialog === undefined
          ? {}
          : { getPendingDialog: options.getPendingDialog }),
        keepsFocus: async (): Promise<boolean> =>
          (await callPage(options, HAS_FOCUS_FUNCTION)) === true,
      };
      const typed = await dispatchTyping(typingOptions);
      if (!typed.completed)
        return {
          inputMode: typed.inputMode,
          completed: false,
          dialog: typed.dialog,
          ...(searchText.length > 0
            ? { settleMs: COMBO_SEARCH_SETTLE_MS }
            : {}),
        };
      if (typed.focusLost)
        return {
          inputMode: typed.inputMode,
          readback: { code: 'state_unchanged' },
          warnings: [
            'The combobox lost focus while typing, so the rest of the search text was not typed.',
          ],
          target: targetState(observed, secret, true),
          settleMs: COMBO_SEARCH_SETTLE_MS,
        };
    }

    settleMs = searchText === undefined ? undefined : COMBO_SEARCH_SETTLE_MS;
    await delay(
      searchText === undefined ? COMBO_OPEN_SETTLE_MS : COMBO_SEARCH_SETTLE_MS,
    );
    options.lane.signal.throwIfAborted();
    // The page model knows what the page check cannot, such as a field that
    // was ever a password, so it is asked about the list the page opened.
    if (!secret && options.refreshSecret && (await options.refreshSecret()))
      secret = true;
    options.lane.signal.throwIfAborted();

    observed = await look(true);
    if (observed.kind !== 'combobox')
      return {
        inputMode: opened.inputMode,
        readback: { code: 'state_unchanged' },
        warnings: ['The combobox was no longer available after opening.'],
        target: targetState(observed, secret, true),
        ...(settleMs === undefined ? {} : { settleMs }),
      };
    if (!observed.listFound || observed.optionCount === 0)
      return comboFailure(observed, secret, 'list', settleMs);
    if (observed.targetDisabled)
      return comboFailure(observed, secret, 'disabled', settleMs);
    if (observed.missingCount > 0)
      return comboFailure(observed, secret, 'missing', settleMs);
    if (observed.disabled)
      return comboFailure(observed, secret, 'disabled', settleMs);
    if (observed.hidden)
      return comboFailure(observed, secret, 'hidden', settleMs);
    if (observed.already)
      return {
        inputMode: opened.inputMode,
        target: targetState(observed, secret),
        ...(settleMs === undefined ? {} : { settleMs }),
      };
  }

  const matchedIndex = observed.matches[0];
  if (matchedIndex === undefined)
    return observed.kind === 'combobox'
      ? comboFailure(observed, secret, 'missing', settleMs)
      : throwChoiceError(
          'option_not_found',
          optionMessage('aria', 'missing'),
          secret,
          optionsForError(observed, secret),
        );
  const clickTarget = await clickOption(options, matchedIndex);
  if (!clickTarget) {
    if (observed.kind === 'combobox' && !alreadyOpen) {
      const live = await look(true);
      return comboFailure(live, secret, 'stale', settleMs);
    }
    throwChoiceError(
      'target_not_found',
      'The requested option is no longer available.',
      secret,
      optionsForError(observed, secret),
    );
  }
  let clickMode = 'trusted' as const;
  try {
    const clicked = await options.click(clickTarget);
    clickMode = clicked.inputMode;
    if (!clicked.completed)
      return {
        inputMode: clicked.inputMode,
        completed: false,
        dialog: clicked.dialog,
        ...(observed.kind === 'combobox' && searchText !== undefined
          ? { settleMs: COMBO_SEARCH_SETTLE_MS }
          : {}),
      };
    await delay(NATIVE_VERIFY_SETTLE_MS);
    options.lane.signal.throwIfAborted();
    const verified = await look(true, matchedIndex);
    // An index means the option it chose before the click; the option now at
    // that index can be another one.
    if (
      verified.verified === true ||
      (verified.already && !Array.isArray(choice.indexes))
    )
      return {
        inputMode: clickMode,
        target: targetState(verified, secret),
        ...(settleMs === undefined ? {} : { settleMs }),
      };
    if (observed.kind === 'combobox')
      return comboFailure(verified, secret, 'unchanged', settleMs);
    return {
      inputMode: clickMode,
      readback: { code: 'state_unchanged' },
      warnings: ['The list did not keep the requested option selection.'],
      target: targetState(verified, secret, true),
    };
  } catch (error) {
    if (
      observed.kind !== 'combobox' ||
      alreadyOpen ||
      !(error instanceof FormActionError)
    )
      throw error;
    const live = await look(true);
    const issue =
      error.error.code === 'target_disabled'
        ? 'disabled'
        : error.error.code === 'target_not_visible'
          ? 'hidden'
          : error.error.code === 'target_not_found' ||
              error.error.code === 'target_stale'
            ? 'stale'
            : 'list';
    return comboFailure(live, secret, issue, settleMs);
  } finally {
    await releaseObject(options, clickTarget.objectId);
  }
}

/** Choose options from a native select or a rendered ARIA list. */
export async function runSelectOption(
  options: FormActionOptions & {
    choice: BrowserOptionChoice;
    searchText?: string;
  },
): Promise<FormActionResult> {
  const observed = await inspect(options, options.choice, false);
  if (observed.kind === 'native')
    return runNativeSelect(options, options.choice);
  return runAriaSelect(options, options.choice, options.searchText);
}
