import { browserTypeTextLimit } from '@canopy/agent-actions/families/browser/typing-budget';

const ACTION_TIMEOUT_MAX_MS = 60_000;
const WAIT_TIMEOUT_MAX_MS = 120_000;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalStringError(
  value: RecordValue,
  key: string,
): string | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  return typeof value[key] === 'string'
    ? undefined
    : `${key} must be a string.`;
}

function optionalFiniteNonNegativeNumberError(
  value: RecordValue,
  key: string,
): string | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  const number = value[key];
  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? undefined
    : `${key} must be a finite non-negative number.`;
}

function timeoutError(value: RecordValue, maximum: number): string | undefined {
  if (!hasOwn(value, 'timeoutMs') || value.timeoutMs === undefined)
    return undefined;
  const timeoutMs = value.timeoutMs;
  return typeof timeoutMs === 'number' &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0 &&
    timeoutMs <= maximum
    ? undefined
    : `timeoutMs must be a finite number between 0 and ${maximum}.`;
}

function selectorFieldsError(value: RecordValue): string | undefined {
  return (
    optionalStringError(value, 'ref') ??
    optionalStringError(value, 'locator') ??
    optionalFiniteNonNegativeNumberError(value, 'x') ??
    optionalFiniteNonNegativeNumberError(value, 'y') ??
    (hasOwn(value, 'x') !== hasOwn(value, 'y')
      ? 'x and y must be provided together.'
      : undefined)
  );
}

function present(value: RecordValue, key: string): boolean {
  return hasOwn(value, key) && value[key] !== undefined;
}

/**
 * The optional `frame` (a frameRef or an iframe CSS selector) with the
 * shared schemas' rules: a non-blank string that scopes a locator only,
 * never a ref or coordinates. The renderer route is not trusted to have
 * applied them.
 */
function frameError(value: RecordValue, kind: string): string | undefined {
  if (!present(value, 'frame')) return undefined;
  const frame = value.frame;
  if (typeof frame !== 'string' || frame.trim().length === 0)
    return 'frame must be a non-empty string.';
  if (
    !present(value, 'locator') ||
    present(value, 'ref') ||
    present(value, 'x') ||
    present(value, 'y')
  )
    return `browser.${kind} frame applies only to locators; a ref already identifies its frame.`;
  return undefined;
}

function waitForFrameError(value: RecordValue): string | undefined {
  if (!hasOwn(value, 'frame')) return undefined;
  const frame = value.frame;
  if (typeof frame !== 'string' || frame.trim().length === 0)
    return 'frame must be a non-empty string.';
  if (
    (!present(value, 'locator') && !present(value, 'text')) ||
    present(value, 'url') ||
    present(value, 'loadState') ||
    present(value, 'download') ||
    present(value, 'upload')
  )
    return present(value, 'upload')
      ? 'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, download, or upload.'
      : 'browser.wait_for frame requires locator or text and cannot be combined with url, loadState, or download.';
  return undefined;
}

function dialogResponseError(value: RecordValue): string | undefined {
  if (!hasOwn(value, 'dialogResponse') || value.dialogResponse === undefined)
    return undefined;
  const dialogResponse = value.dialogResponse;
  if (!isRecord(dialogResponse)) return 'dialogResponse must be an object.';
  if (typeof dialogResponse.accept !== 'boolean')
    return 'dialogResponse.accept must be a boolean.';
  if (
    hasOwn(dialogResponse, 'promptText') &&
    dialogResponse.promptText !== undefined &&
    typeof dialogResponse.promptText !== 'string'
  )
    return 'dialogResponse.promptText must be a string.';
  return undefined;
}

function clickFieldsError(value: RecordValue): string | undefined {
  const timeout = timeoutError(value, ACTION_TIMEOUT_MAX_MS);
  if (timeout) return timeout;
  const actionIdError = optionalStringError(value, 'actionId');
  if (actionIdError) return actionIdError;
  const selectors = selectorFieldsError(value);
  if (selectors) return selectors;
  if (
    hasOwn(value, 'button') &&
    value.button !== undefined &&
    value.button !== 'left' &&
    value.button !== 'right' &&
    value.button !== 'middle'
  )
    return 'button must be left, right, or middle.';
  if (hasOwn(value, 'clickCount') && value.clickCount !== undefined) {
    const clickCount = value.clickCount;
    if (
      typeof clickCount !== 'number' ||
      !Number.isInteger(clickCount) ||
      clickCount < 1 ||
      clickCount > 3
    )
      return 'clickCount must be an integer between 1 and 3.';
  }
  if (hasOwn(value, 'modifiers') && value.modifiers !== undefined) {
    const modifiers = value.modifiers;
    if (
      !Array.isArray(modifiers) ||
      !modifiers.every(
        (modifier: unknown): boolean =>
          modifier === 'Alt' ||
          modifier === 'Control' ||
          modifier === 'Meta' ||
          modifier === 'Shift',
      )
    )
      return 'modifiers must contain only Alt, Control, Meta, and Shift.';
  }
  if (
    hasOwn(value, 'force') &&
    value.force !== undefined &&
    typeof value.force !== 'boolean'
  )
    return 'force must be a boolean.';
  if (hasOwn(value, 'position') && value.position !== undefined) {
    const position = value.position;
    if (!isRecord(position)) return 'position must be an object.';
    const x = position.x;
    const y = position.y;
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      x < 0 ||
      typeof y !== 'number' ||
      !Number.isFinite(y) ||
      y < 0
    )
      return 'position.x and position.y must be finite non-negative numbers.';
  }
  return dialogResponseError(value);
}

function actionFieldsError(value: RecordValue): string | undefined {
  const timeout = timeoutError(value, ACTION_TIMEOUT_MAX_MS);
  if (timeout) return timeout;
  const actionIdError = optionalStringError(value, 'actionId');
  if (actionIdError) return actionIdError;
  return selectorFieldsError(value);
}

function waitForFieldsError(value: RecordValue): string | undefined {
  const timeout = timeoutError(value, WAIT_TIMEOUT_MAX_MS);
  if (timeout) return timeout;
  const actionIdError = optionalStringError(value, 'actionId');
  if (actionIdError) return actionIdError;
  for (const field of ['locator', 'text', 'url']) {
    const error = optionalStringError(value, field);
    if (error) return error;
  }
  const selectors = [
    'locator',
    'text',
    'url',
    'loadState',
    'download',
    'upload',
  ].filter((field) => hasOwn(value, field) && value[field] !== undefined);
  if (selectors.length !== 1)
    return present(value, 'upload')
      ? 'wait_for requires exactly one of locator, text, url, loadState, download, or upload.'
      : 'wait_for requires exactly one of locator, text, url, loadState, or download.';
  if (present(value, 'upload')) {
    const upload = value.upload;
    if (!isRecord(upload)) return 'upload must be an object.';
    const error =
      strictKeys(upload, ['uploadId']) ??
      (present(upload, 'uploadId')
        ? nonBlank(upload, 'uploadId')
        : 'uploadId must be a non-empty string.');
    if (error) return error;
  }
  if (present(value, 'download')) {
    const download = value.download;
    if (!isRecord(download)) return 'download must be an object.';
    const error =
      strictKeys(download, ['downloadId']) ?? nonBlank(download, 'downloadId');
    if (error) return error;
  }
  if (hasOwn(value, 'state') && value.state !== undefined) {
    if (
      value.state !== 'visible' &&
      value.state !== 'hidden' &&
      value.state !== 'attached' &&
      value.state !== 'detached'
    )
      return 'state must be visible, hidden, attached, or detached.';
    if (
      value.url !== undefined ||
      value.loadState !== undefined ||
      value.download !== undefined
    )
      return 'state can only be used with locator or text.';
  }
  if (
    hasOwn(value, 'loadState') &&
    value.loadState !== undefined &&
    value.loadState !== 'load' &&
    value.loadState !== 'domcontentloaded' &&
    value.loadState !== 'network_idle'
  )
    return 'loadState must be load, domcontentloaded, or network_idle.';
  return undefined;
}

function strictKeys(value: RecordValue, keys: string[]): string | undefined {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  return unknown ? `${unknown} is not supported for this command.` : undefined;
}

function nonBlank(value: RecordValue, key: string): string | undefined {
  if (!present(value, key)) return undefined;
  return typeof value[key] === 'string' && value[key].trim().length > 0
    ? undefined
    : `${key} must be a non-empty string.`;
}

function elementTargetError(
  value: RecordValue,
  optional = false,
  kind = 'target',
): string | undefined {
  const count = ['ref', 'locator'].filter((key) => present(value, key)).length;
  if (count !== 1 && !(optional && count === 0))
    return 'Provide exactly one of ref or locator.';
  return (
    nonBlank(value, 'ref') ??
    nonBlank(value, 'locator') ??
    frameError(value, kind)
  );
}

/** A file input: a ref, a locator, or a pending chooser's id. */
function fileInputTargetError(
  value: RecordValue,
  kind: string,
): string | undefined {
  const count = ['ref', 'locator', 'chooserId'].filter((key) =>
    present(value, key),
  ).length;
  if (count !== 1) return 'Provide exactly one of ref, locator, or chooserId.';
  return (
    nonBlank(value, 'ref') ??
    nonBlank(value, 'locator') ??
    nonBlank(value, 'chooserId') ??
    frameError(value, kind)
  );
}

function formActionCommonError(value: RecordValue): string | undefined {
  if (present(value, 'timeoutMs')) {
    const timeoutMs = value.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > ACTION_TIMEOUT_MAX_MS
    )
      return 'timeoutMs must be an integer between 1 and 60000.';
  }
  if (present(value, 'actionId')) {
    const actionId = value.actionId;
    if (
      typeof actionId !== 'string' ||
      actionId.trim().length < 1 ||
      actionId.trim().length > 128
    )
      return 'actionId must be a non-empty string of at most 128 characters.';
  }
  return undefined;
}

function stringArrayError(
  value: RecordValue,
  key: 'values' | 'labels',
): string | undefined {
  if (!present(value, key)) return undefined;
  const entries = value[key];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50)
    return `${key} must contain between 1 and 50 entries.`;
  const minLength = key === 'labels' ? 1 : 0;
  const maxLength = 500;
  return entries.every(
    (entry: unknown): boolean =>
      typeof entry === 'string' &&
      entry.length >= minLength &&
      entry.length <= maxLength,
  )
    ? undefined
    : key === 'labels'
      ? 'labels entries must be strings of 1 to 500 characters.'
      : 'values entries must be strings of at most 500 characters.';
}

function indexesArrayError(value: RecordValue): string | undefined {
  if (!present(value, 'indexes')) return undefined;
  const indexes = value.indexes;
  if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > 50)
    return 'indexes must contain between 1 and 50 entries.';
  return indexes.every(
    (index: unknown): boolean =>
      typeof index === 'number' &&
      Number.isInteger(index) &&
      index >= 0 &&
      index <= 9_999,
  )
    ? undefined
    : 'indexes entries must be integers from 0 to 9999.';
}

function setCheckedFieldsError(value: RecordValue): string | undefined {
  const keys = strictKeys(value, [
    'kind',
    'actionId',
    'timeoutMs',
    'ref',
    'locator',
    'frame',
    'checked',
  ]);
  if (keys) return keys;
  return (
    formActionCommonError(value) ??
    elementTargetError(value, false, 'set_checked') ??
    (typeof value.checked === 'boolean'
      ? undefined
      : 'checked must be a boolean.')
  );
}

/** `upload_files` takes a file input or a chooser; `drop_files` takes a drop target. */
function uploadFilesFieldsError(
  value: RecordValue,
  kind: 'upload_files' | 'drop_files',
): string | undefined {
  const keys = strictKeys(value, [
    'kind',
    'actionId',
    'timeoutMs',
    'ref',
    'locator',
    'frame',
    ...(kind === 'upload_files' ? ['chooserId'] : []),
    'files',
  ]);
  if (keys) return keys;
  if (present(value, 'timeoutMs')) {
    const timeoutMs = value.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > WAIT_TIMEOUT_MAX_MS
    )
      return 'timeoutMs must be an integer between 1 and 120000.';
  }
  const target =
    formActionCommonError({ ...value, timeoutMs: undefined }) ??
    (kind === 'upload_files'
      ? fileInputTargetError(value, kind)
      : elementTargetError(value, false, kind));
  if (target) return target;
  const files = value.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 50)
    return 'files must be a list of 1 to 50 files.';
  for (const file of files)
    if (
      !isRecord(file) ||
      Object.keys(file).length !== 1 ||
      !['path', 'downloadId', 'attachmentId'].some((key) => {
        const handle = file[key];
        return typeof handle === 'string' && handle.trim().length > 0;
      })
    )
      return 'Each file needs exactly one of path, downloadId, or attachmentId.';
  return undefined;
}

function requestFilesFieldsError(value: RecordValue): string | undefined {
  const keys = strictKeys(value, [
    'kind',
    'actionId',
    'ref',
    'locator',
    'frame',
    'chooserId',
    'purpose',
  ]);
  if (keys) return keys;
  const target =
    formActionCommonError(value) ??
    fileInputTargetError(value, 'request_files');
  if (target) return target;
  if (!present(value, 'purpose')) return undefined;
  const purpose = value.purpose;
  return typeof purpose === 'string' &&
    purpose.trim().length > 0 &&
    purpose.length <= 500
    ? undefined
    : 'purpose must be 1 to 500 characters.';
}

function selectOptionFieldsError(value: RecordValue): string | undefined {
  const keys = strictKeys(value, [
    'kind',
    'actionId',
    'timeoutMs',
    'ref',
    'locator',
    'frame',
    'values',
    'labels',
    'indexes',
    'searchText',
  ]);
  if (keys) return keys;
  const common = formActionCommonError(value);
  if (common) return common;
  const target = elementTargetError(value, false, 'select_option');
  if (target) return target;
  const choiceCount = ['values', 'labels', 'indexes'].filter((key) =>
    present(value, key),
  ).length;
  if (choiceCount !== 1)
    return 'Provide exactly one of values, labels, or indexes.';
  return (
    stringArrayError(value, 'values') ??
    stringArrayError(value, 'labels') ??
    indexesArrayError(value) ??
    (present(value, 'searchText') &&
    (typeof value.searchText !== 'string' ||
      value.searchText.length < 1 ||
      value.searchText.length > 200)
      ? 'searchText must contain between 1 and 200 characters.'
      : undefined)
  );
}

function typeFieldsError(value: RecordValue): string | undefined {
  const keys = strictKeys(value, [
    'kind',
    'actionId',
    'timeoutMs',
    'ref',
    'locator',
    'frame',
    'text',
    'delayMs',
  ]);
  if (keys) return keys;
  const common = formActionCommonError(value);
  if (common) return common;
  const text = value.text;
  if (typeof text !== 'string' || text.length < 1 || text.length > 4_000)
    return 'text must contain between 1 and 4000 characters.';
  if (present(value, 'delayMs')) {
    const delayMs = value.delayMs;
    if (
      typeof delayMs !== 'number' ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 500
    )
      return 'delayMs must be an integer between 0 and 500.';
  }
  const targetCount = ['ref', 'locator'].filter((key) =>
    present(value, key),
  ).length;
  if (targetCount > 0) {
    const target = elementTargetError(value, false, 'type');
    if (target) return target;
  } else if (present(value, 'frame')) {
    return 'browser.type frame applies only to locators; a ref already identifies its frame.';
  }
  const delayMs = present(value, 'delayMs') ? value.delayMs : 0;
  const limit = typeof delayMs === 'number' ? browserTypeTextLimit(delayMs) : 0;
  if (typeof delayMs === 'number' && text.length > limit)
    return `text is too long for this delayMs: at most ${limit} characters. Shorten the text or the delay.`;
  return undefined;
}

function destinationError(
  value: unknown,
  elementOnly = false,
): string | undefined {
  if (!isRecord(value)) return 'The target must be an object.';
  const keys = strictKeys(
    value,
    elementOnly
      ? ['ref', 'locator', 'frame']
      : ['ref', 'locator', 'frame', 'x', 'y', 'dx', 'dy'],
  );
  if (keys) return keys;
  if (elementOnly || present(value, 'ref') || present(value, 'locator'))
    return (
      elementTargetError(value) ??
      (['x', 'y', 'dx', 'dy'].some((key) => present(value, key))
        ? 'Element targets cannot include coordinates.'
        : undefined)
    );
  if (present(value, 'frame'))
    return 'A coordinate target cannot include frame.';
  if (present(value, 'x') || present(value, 'y')) {
    if (['dx', 'dy'].some((key) => present(value, key)))
      return 'Use a point or an offset, not both.';
    if (!present(value, 'x') || !present(value, 'y'))
      return 'x and y must be provided together.';
    return (
      optionalFiniteNonNegativeNumberError(value, 'x') ??
      optionalFiniteNonNegativeNumberError(value, 'y')
    );
  }
  return typeof value.dx === 'number' &&
    Number.isFinite(value.dx) &&
    typeof value.dy === 'number' &&
    Number.isFinite(value.dy)
    ? undefined
    : 'dx and dy must be finite numbers provided together.';
}

function pointerViewportError(
  value: RecordValue,
  kind: 'hover' | 'scroll' | 'drag',
): string | undefined {
  const common = ['kind', 'actionId', 'timeoutMs'];
  const keys = strictKeys(value, [
    ...common,
    ...(kind === 'hover'
      ? ['ref', 'locator', 'frame', 'x', 'y']
      : kind === 'drag'
        ? ['from', 'to', 'steps', 'modifiers']
        : [
            'ref',
            'locator',
            'frame',
            'direction',
            'pages',
            'pixels',
            'intoView',
            'toText',
          ]),
  ]);
  if (keys) return keys;
  if (
    present(value, 'timeoutMs') &&
    (typeof value.timeoutMs !== 'number' ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > ACTION_TIMEOUT_MAX_MS)
  )
    return 'timeoutMs must be an integer between 1 and 60000.';
  if (
    present(value, 'actionId') &&
    (typeof value.actionId !== 'string' ||
      value.actionId.trim().length < 1 ||
      value.actionId.trim().length > 128)
  )
    return 'actionId must be a non-empty string of at most 128 characters.';
  if (kind === 'drag') {
    const target =
      destinationError(value.from, true) ?? destinationError(value.to);
    if (target) return target;
    if (
      present(value, 'steps') &&
      (typeof value.steps !== 'number' ||
        !Number.isInteger(value.steps) ||
        value.steps < 1 ||
        value.steps > 100)
    )
      return 'steps must be an integer between 1 and 100.';
    if (
      present(value, 'modifiers') &&
      (!Array.isArray(value.modifiers) ||
        value.modifiers.length > 4 ||
        new Set(value.modifiers).size !== value.modifiers.length ||
        !value.modifiers.every(
          (modifier: unknown) =>
            typeof modifier === 'string' &&
            ['Alt', 'Control', 'Meta', 'Shift'].includes(modifier),
        ))
    )
      return 'modifiers must contain unique Alt, Control, Meta, or Shift values.';
    return undefined;
  }
  if (kind === 'hover') {
    if (present(value, 'x') || present(value, 'y')) {
      if (['ref', 'locator', 'frame'].some((key) => present(value, key)))
        return 'Use an element or a point, not both.';
      if (!present(value, 'x') || !present(value, 'y'))
        return 'x and y must be provided together.';
      // Negative coordinates move the pointer off the page.
      return [value.x, value.y].every(
        (coordinate) =>
          typeof coordinate === 'number' && Number.isFinite(coordinate),
      )
        ? undefined
        : 'x and y must be finite numbers.';
    }
    return elementTargetError(value);
  }
  if (
    ['direction', 'intoView', 'toText'].filter((key) => present(value, key))
      .length !== 1
  )
    return 'browser.scroll requires exactly one mode: direction, intoView, or toText.';
  if (present(value, 'toText')) {
    if (
      ['ref', 'locator', 'pages', 'pixels'].some((key) => present(value, key))
    )
      return 'toText cannot be combined with an element or amount.';
    return nonBlank(value, 'toText') ?? nonBlank(value, 'frame');
  }
  const target = elementTargetError(value, present(value, 'direction'));
  if (target) return target;
  if (present(value, 'intoView'))
    return value.intoView === true &&
      !['pages', 'pixels'].some((key) => present(value, key))
      ? undefined
      : 'intoView must be true and cannot include an amount.';
  if (!['up', 'down', 'left', 'right'].includes(String(value.direction)))
    return 'direction must be up, down, left, or right.';
  if (present(value, 'pages') && present(value, 'pixels'))
    return 'Use pages or pixels, not both.';
  if (
    present(value, 'pages') &&
    (typeof value.pages !== 'number' ||
      !Number.isFinite(value.pages) ||
      value.pages < 0.1 ||
      value.pages > 10)
  )
    return 'pages must be between 0.1 and 10.';
  if (
    present(value, 'pixels') &&
    (typeof value.pixels !== 'number' ||
      !Number.isInteger(value.pixels) ||
      value.pixels < 1 ||
      value.pixels > 100000)
  )
    return 'pixels must be an integer between 1 and 100000.';
  return undefined;
}

/** Returns a validation message for an untrusted automation command. */
export function validateBrowserAutomationCommand(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return 'command must be an object.';
  switch (value.kind) {
    case 'hover':
    case 'scroll':
    case 'drag':
      return pointerViewportError(value, value.kind);
    case 'click':
      return clickFieldsError(value) ?? frameError(value, 'click');
    case 'fill': {
      const error = actionFieldsError(value) ?? frameError(value, 'fill');
      if (error) return error;
      return typeof value.text === 'string'
        ? undefined
        : 'text must be a string.';
    }
    case 'press': {
      const error = actionFieldsError(value) ?? frameError(value, 'press');
      if (error) return error;
      if (hasOwn(value, 'dialogResponse')) {
        const dialogError = dialogResponseError(value);
        if (dialogError) return dialogError;
      }
      return typeof value.key === 'string'
        ? undefined
        : 'key must be a string.';
    }
    case 'focus':
      return actionFieldsError(value) ?? frameError(value, 'focus');
    case 'set_checked':
      return setCheckedFieldsError(value);
    case 'select_option':
      return selectOptionFieldsError(value);
    case 'type':
      return typeFieldsError(value);
    case 'upload_files':
    case 'drop_files':
      return uploadFilesFieldsError(value, value.kind);
    case 'request_files':
      return requestFilesFieldsError(value);
    case 'wait_for':
      return waitForFieldsError(value) ?? waitForFrameError(value);
    case 'inspect':
      return selectorFieldsError(value) ?? frameError(value, 'inspect');
    default:
      return 'kind is not a supported browser automation command.';
  }
}

/**
 * The `frame` of an inspect or input-snapshot request. The renderer's IPC
 * handlers check only the browser id, so the service is the boundary: a
 * frame that is present must be a non-empty string.
 */
export function requestFrame(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(
      'Invalid browser request: frame must be a non-empty string.',
    );
  return value;
}
