import { loadPreparedNativeArtifact } from './authorization';
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

  let loaded: CredentialNative | undefined;
  return createWindowsSecretProtection(
    () => {
      loaded = undefined;
      if (!policy.enabled) return undefined;
      try {
        const value = loadPreparedNativeArtifact(options.preparedNative);
        if (isCredentialNative(value)) loaded = value;
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

  let loaded: SecretServiceNative | undefined;
  return createLinuxSecretProtection(
    () => {
      loaded = undefined;
      if (!policy.enabled) return undefined;
      try {
        const value = loadPreparedNativeArtifact(options.preparedNative);
        if (isSecretServiceNative(value)) loaded = value;
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

  const policy = resolveSecretProtectionPolicy(options);
  let loaded: KeychainNative | undefined;
  const load = (): KeychainNative | undefined => {
    loaded = undefined;
    if (!policy.enabled) return undefined;
    try {
      const value = loadPreparedNativeArtifact(options.preparedNative);
      if (isKeychainNative(value)) loaded = value;
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
