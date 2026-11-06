import { isAbsolute } from 'node:path';
import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import { createDarwinSecretProtection, type KeychainNative } from './darwin';
import { createWindowsSecretProtection, type CredentialNative } from './win32';
import { createLinuxSecretProtection, type SecretServiceNative } from './linux';
import {
  resolveSecretProtectionPolicy,
  resolveWindowsSecretProtectionPolicy,
  type SecretProtectionOptions,
} from './policy';
export type { SecretProtectionOptions } from './policy';

export const SECRET_PROTECTION_FILE = 'core-secret-protection.node';

// One binding per immutable host-selected addon, including its shared unlock queue.
const darwinBindings = new Map<string, KeychainNative>();
const linuxBindings = new Map<string, SecretServiceNative>();

function isKeychainNative(value: unknown): value is KeychainNative {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Object.getOwnPropertyDescriptor(value, 'run')?.value ===
      'function' &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === false
  );
}

function isCredentialNative(value: unknown): value is CredentialNative {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Object.getOwnPropertyDescriptor(value, 'run')?.value ===
      'function' &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === false &&
    Object.getOwnPropertyDescriptor(value, 'abi')?.value ===
      'windows-credential-v1'
  );
}

function createWindowsServices(
  options: SecretProtectionOptions,
): PlatformSecretProtectionServices {
  const policy = resolveWindowsSecretProtectionPolicy(options);
  const { nativePath } = options;
  let attempted = false;
  let loaded: CredentialNative | undefined;
  return createWindowsSecretProtection(
    () => {
      if (attempted) return loaded;
      attempted = true;
      if (!policy.enabled || !isAbsolute(nativePath)) return undefined;
      try {
        const module = { exports: {} };
        process.dlopen(module, nativePath);
        if (isCredentialNative(module.exports)) loaded = module.exports;
      } catch {
        // No fallback and no native diagnostic disclosure.
      }
      return loaded;
    },
    policy.namespace,
    policy.unavailable,
  );
}

function isSecretServiceNative(value: unknown): value is SecretServiceNative {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Object.getOwnPropertyDescriptor(value, 'run')?.value ===
      'function' &&
    Object.getOwnPropertyDescriptor(value, 'fixture')?.value === false &&
    Object.getOwnPropertyDescriptor(value, 'abi')?.value ===
      'linux-secret-service-v1'
  );
}

function createLinuxServices(
  options: SecretProtectionOptions,
): PlatformSecretProtectionServices {
  const policy = resolveSecretProtectionPolicy(options);
  const { nativePath } = options;
  let attempted = false;
  let loaded: SecretServiceNative | undefined;
  return createLinuxSecretProtection(
    () => {
      if (attempted) return loaded;
      attempted = true;
      if (!policy.enabled || !isAbsolute(nativePath)) return undefined;
      const existing = linuxBindings.get(nativePath);
      if (existing) return (loaded = existing);
      try {
        const module = { exports: {} };
        process.dlopen(module, nativePath);
        if (isSecretServiceNative(module.exports)) {
          loaded = module.exports;
          linuxBindings.set(nativePath, loaded);
        }
      } catch {
        // No fallback and no native diagnostic disclosure.
      }
      return loaded;
    },
    policy.namespace,
    policy.unavailable,
  );
}

/**
 * Inert until a trusted host composes it. On macOS the addon owns the interaction
 * switch: only its serialized unlock-only phase may enable UI. Linux owns its
 * unlock prompts; abort never dismisses them. Windows has no prompt.
 */
export function createSecretProtectionServices(
  options: SecretProtectionOptions,
): PlatformSecretProtectionServices {
  if (options.os === 'win32') return createWindowsServices(options);
  if (options.os === 'linux') return createLinuxServices(options);
  const { nativePath } = options;
  const policy = resolveSecretProtectionPolicy(options);
  let loaded: KeychainNative | undefined;
  let attempted = false;
  const load = (): KeychainNative | undefined => {
    if (attempted) return loaded;
    attempted = true;
    if (!policy.enabled || !isAbsolute(nativePath)) return undefined;
    const existing = darwinBindings.get(nativePath);
    if (existing) return (loaded = existing);
    try {
      const module = { exports: {} };
      process.dlopen(module, nativePath);
      if (isKeychainNative(module.exports)) {
        loaded = module.exports;
        darwinBindings.set(nativePath, loaded);
      }
    } catch {
      // An unavailable native backend is never a reason to fall back.
    }
    return loaded;
  };
  return createDarwinSecretProtection(
    load,
    policy.namespace,
    policy.unavailable,
  );
}
