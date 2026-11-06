import type {
  PlatformKeySlotBlockReason,
  PlatformKeySlotDeleteResult,
  PlatformKeySlotReadResult,
  PlatformKeySlotWriteResult,
  PlatformSecretProtectionState,
} from '@canopy/core-runtime';

/** Native replies are never trusted as DTOs, including replies from a stale addon. */
export function nativeCode(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unknown';
  const code: unknown = Object.getOwnPropertyDescriptor(value, 'code')?.value;
  return typeof code === 'string' ? code : 'unknown';
}

function blockReason(code: string): PlatformKeySlotBlockReason {
  switch (code) {
    case 'locked':
    case 'denied':
    case 'interaction_required':
      return code;
    default:
      return 'unavailable';
  }
}

export function statusResult(value: unknown): PlatformSecretProtectionState {
  switch (nativeCode(value)) {
    case 'ok':
      return { state: 'available' };
    case 'locked':
      return { state: 'locked', evidence: 'reported' };
    case 'denied':
      return { state: 'denied' };
    case 'interaction_required':
      return { state: 'unknown' };
    case 'unsupported_session':
      return { state: 'unavailable', reason: 'unsupported_session' };
    default:
      return { state: 'unavailable', reason: 'backend_failed' };
  }
}

export function readResult(value: unknown): PlatformKeySlotReadResult {
  const code = nativeCode(value);
  if (typeof value === 'object' && value !== null) {
    const bytes: unknown = Object.getOwnPropertyDescriptor(
      value,
      'material',
    )?.value;
    if (bytes instanceof Uint8Array) {
      try {
        if (code === 'ok') {
          if (bytes.byteLength < 1 || bytes.byteLength > 1024)
            return { kind: 'corrupt' };
          return { kind: 'present', material: new Uint8Array(bytes) };
        }
      } finally {
        bytes.fill(0);
      }
    }
  }
  if (code === 'ok' || code === 'corrupt') return { kind: 'corrupt' };
  if (code === 'absent') return { kind: 'absent' };
  return { kind: 'blocked', reason: blockReason(code) };
}

export function writeResult(value: unknown): PlatformKeySlotWriteResult {
  const code = nativeCode(value);
  switch (code) {
    case 'ok':
      return { kind: 'written' };
    case 'conflict':
      return { kind: 'conflict' };
    case 'failed':
      return { kind: 'failed' };
    case 'locked':
    case 'denied':
    case 'interaction_required':
    case 'unavailable':
    case 'unsupported_session':
      return { kind: 'blocked', reason: blockReason(code) };
    default:
      // The native operation has finished, but an unknown reply proves no outcome.
      return { kind: 'uncertain' };
  }
}

export function deleteResult(value: unknown): PlatformKeySlotDeleteResult {
  const code = nativeCode(value);
  switch (code) {
    case 'ok':
      return { kind: 'deleted' };
    case 'absent':
      return { kind: 'absent' };
    case 'locked':
    case 'denied':
    case 'interaction_required':
    case 'unavailable':
    case 'unsupported_session':
      return { kind: 'blocked', reason: blockReason(code) };
    default:
      return { kind: 'uncertain' };
  }
}
