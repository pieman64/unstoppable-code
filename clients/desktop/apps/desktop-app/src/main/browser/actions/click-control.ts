import type { BrowserInputOption } from '@canopy/execution-engine/types/browser';
import { isCDPRecord } from '../frames/cdp-decode';
import { remoteValue } from '../frames/host-cdp';
import type { ResolvedActionTarget } from '../frames/action-targets';
import type { BrowserCdpSend } from './actionability';
import { FormActionError } from './form-action';

/** A read in the host world; even a forced click cannot open these pickers. */
export const CLICK_CONTROL_FUNCTION = `function(secret) {
  if (this.tagName === 'SELECT') {
    const result = { kind: 'select' };
    if (!secret) result.options = Array.from(this.options).slice(0, 50).map(option => ({
      value: option.value,
      label: (option.getAttribute('label') ?? option.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      selected: option.selected,
      disabled: option.disabled || !!option.closest('optgroup:disabled'),
    }));
    return result;
  }
  return { kind: this.tagName === 'INPUT' && this.type === 'file' ? 'file' : 'other' };
}`;

function decodeOptions(value: unknown): BrowserInputOption[] {
  if (!Array.isArray(value)) return [];
  const options: BrowserInputOption[] = [];
  for (const option of value.slice(0, 50)) {
    if (
      !isCDPRecord(option) ||
      typeof option.value !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.selected !== 'boolean' ||
      typeof option.disabled !== 'boolean'
    )
      continue;
    options.push({
      value: option.value,
      label: option.label,
      selected: option.selected,
      disabled: option.disabled,
    });
  }
  return options;
}

/** Refusals precede click actionability, input, and its synthetic fallback. */
export async function refuseClickControl(options: {
  send: BrowserCdpSend;
  target: ResolvedActionTarget;
  secret: boolean;
}): Promise<void> {
  const value = remoteValue(
    await options.send(
      'Runtime.callFunctionOn',
      {
        objectId: options.target.objectId,
        functionDeclaration: CLICK_CONTROL_FUNCTION,
        arguments: [{ value: options.secret }],
        returnByValue: true,
      },
      options.target.identity.sessionId,
    ),
  );
  if (!isCDPRecord(value))
    throw new FormActionError({
      code: 'target_stale',
      message: 'The target could not be read.',
      retryable: false,
    });
  if (value.kind === 'select')
    throw new FormActionError({
      code: 'unsupported_control',
      message: 'Use browser.select_option to choose an option.',
      retryable: false,
      next: 'browser.select_option',
      ...(options.secret
        ? { candidatesRedacted: true }
        : { options: decodeOptions(value.options) }),
    });
  if (value.kind === 'file')
    throw new FormActionError({
      code: 'unsupported_control',
      message:
        'Use browser.upload_files to attach files, or browser.request_files to ask the user to choose them.',
      retryable: false,
      next: 'browser.upload_files',
    });
}
