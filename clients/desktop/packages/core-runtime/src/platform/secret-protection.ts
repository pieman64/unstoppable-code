// Native key-slot port for the daemon vault (`vault.protectedKeySlots`).
// Type-only, like platform-services.ts. Not a `PlatformServices` member: V6
// composes it, supplying brand, local authority identity and any adapter data
// root (DPAPI blobs). The native adapters are V2–V4; the test kit is
// `@canopy/core-runtime/platform/testing`.
//
// Precondition (V2/V6 qualification, not a V0 test): key-slot protection
// assumes an injection-closed, team-signed daemon. Any code that runs inside
// the daemon can read every slot it can.

/**
 * Native backends. There is deliberately no plaintext, passphrase or file
 * backend: a host without one of these reports `unavailable` instead.
 */
export type PlatformSecretProtectionBackend =
  | 'macos_keychain'
  | 'windows_credential_manager'
  | 'windows_dpapi'
  | 'linux_secret_service';

/**
 * `authority_unavailable`: no local authority identity to bind slots to (for
 * example `principal_unavailable` on win32); composition reports it without
 * reaching the backend.
 */
export type PlatformSecretProtectionUnavailableReason =
  | 'no_backend'
  | 'unsupported_session'
  | 'backend_failed'
  | 'authority_unavailable';

/**
 * Backend-wide protection, observed without prompting. `unknown`: the backend
 * cannot tell without user interaction. Slot presence is not part of it: the
 * vault derives `key_missing` from an `absent` read of its key slot.
 */
export type PlatformSecretProtectionState =
  | { readonly state: 'available' }
  | { readonly state: 'unknown' }
  | {
      readonly state: 'locked';
      /** `inferred`: the backend gave no lock signal; a failure implied one. */
      readonly evidence: 'reported' | 'inferred';
    }
  | { readonly state: 'denied' }
  | {
      readonly state: 'unavailable';
      readonly reason: PlatformSecretProtectionUnavailableReason;
    };

/** One vault-level slot. `name` matches `^[a-z0-9][a-z0-9-]{0,63}$`; never a path. */
export interface PlatformKeySlot {
  readonly name: string;
}

/**
 * `signal` is required. Aborted before the call: reject with `signal.reason`
 * and change nothing. Aborted while pending: settle without waiting for the
 * user; reject with `signal.reason` only if nothing changed, otherwise resolve
 * the true outcome (`uncertain` when unknown). Status and reads may still
 * resolve a result the backend returned; a caller that aborted zeroes any
 * material it receives. Start no backend call after the signal aborts. Once
 * settled, a call has no further effect: a later abort changes nothing.
 */
export interface PlatformSecretProtectionCallOptions {
  readonly signal: AbortSignal;
}

/**
 * `never`: fail with `blocked` rather than show a Keychain, Secret Service or
 * consent prompt; a headless daemon must not hang on one. An abort dismisses
 * any prompt the call is showing; the call then settles by the abort rules.
 */
export interface PlatformKeySlotCallOptions extends PlatformSecretProtectionCallOptions {
  readonly interaction: 'never' | 'allowed';
}

/**
 * `create` succeeds only when the slot is absent, `replace` only when it is
 * present (including `corrupt`); any other state is a `conflict`.
 */
export interface PlatformKeySlotWriteOptions extends PlatformKeySlotCallOptions {
  readonly mode: 'create' | 'replace';
}

/**
 * `locked`: unlocking needs the user. `interaction_required`: access needs a
 * prompt that `interaction: 'never'` forbids. `unavailable`: see `status`.
 */
export type PlatformKeySlotBlockReason =
  | 'locked'
  | 'interaction_required'
  | 'denied'
  | 'unavailable';

export interface PlatformKeySlotBlocked {
  readonly kind: 'blocked';
  readonly reason: PlatformKeySlotBlockReason;
}

export type PlatformKeySlotReadResult =
  /** A fresh copy the caller owns and should zero after use. */
  | { readonly kind: 'present'; readonly material: Uint8Array }
  | { readonly kind: 'absent' }
  /** The slot exists but its material cannot be recovered intact. */
  | { readonly kind: 'corrupt' }
  | PlatformKeySlotBlocked;

export type PlatformKeySlotWriteResult =
  | { readonly kind: 'written' }
  /** The slot state did not match `mode`; nothing changed. */
  | { readonly kind: 'conflict' }
  /** It may or may not have landed, but can no longer land: a read now is authoritative. */
  | { readonly kind: 'uncertain' }
  /** The backend refused the write; nothing changed. */
  | { readonly kind: 'failed' }
  | PlatformKeySlotBlocked;

export type PlatformKeySlotDeleteResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'absent' }
  /** It may or may not have landed, but can no longer land: a read now is authoritative. */
  | { readonly kind: 'uncertain' }
  | PlatformKeySlotBlocked;

/**
 * Invalid slot names and material outside 1–1024 bytes reject with a
 * `TypeError` before the backend is reached; backend outcomes always resolve.
 */
export interface PlatformSecretProtectionServices {
  readonly backend: PlatformSecretProtectionBackend;
  /** Never interactive. */
  status(
    options: PlatformSecretProtectionCallOptions,
  ): Promise<PlatformSecretProtectionState>;
  readKeySlot(
    slot: PlatformKeySlot,
    options: PlatformKeySlotCallOptions,
  ): Promise<PlatformKeySlotReadResult>;
  /** Must not retain `material` after the returned promise settles. */
  writeKeySlot(
    slot: PlatformKeySlot,
    material: Uint8Array,
    options: PlatformKeySlotWriteOptions,
  ): Promise<PlatformKeySlotWriteResult>;
  deleteKeySlot(
    slot: PlatformKeySlot,
    options: PlatformKeySlotCallOptions,
  ): Promise<PlatformKeySlotDeleteResult>;
}
