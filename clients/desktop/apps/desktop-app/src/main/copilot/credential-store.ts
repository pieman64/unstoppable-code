import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from '../lib/atomic-file';
import { isE2eBuild } from '../lib/e2e-gate';
import { getCopilotCredentialFilePath } from '../lib/paths';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from '../lib/secure-storage-policy';

/** The whole GitHub App grant; the refresh token is the long-lived secret. */
export interface CopilotCredential {
  version: 1;
  clientId: string;
  host: string;
  login: string;
  id: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export type CopilotCredentialRead =
  | { status: 'present'; credential: CopilotCredential }
  | { status: 'absent' }
  | { status: 'unreadable'; secureStorageFailure?: SecureStorageFailure };

const STORAGE_UNAVAILABLE =
  "Couldn't store the Copilot sign-in on this device.";

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseCredential(value: unknown): CopilotCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = { ...value };
  const text = (key: string): string | null => {
    const field = record[key];
    return typeof field === 'string' && field ? field : null;
  };
  const clientId = text('clientId');
  const host = text('host');
  const login = text('login');
  const id = text('id');
  const accessToken = text('accessToken');
  const refreshToken = text('refreshToken');
  if (
    record.version !== 1 ||
    !clientId ||
    !host ||
    !login ||
    !id ||
    !accessToken ||
    !refreshToken ||
    !isIsoDate(record.accessTokenExpiresAt) ||
    !isIsoDate(record.refreshTokenExpiresAt)
  )
    return null;
  return {
    version: 1,
    clientId,
    host,
    login,
    id,
    accessToken,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
  };
}

export function isCopilotCredentialStorageAvailable(): boolean {
  return getSecretStoragePolicy().isWriteAvailable();
}

async function readFromDisk(): Promise<CopilotCredentialRead> {
  const safeStorage = getSecretStoragePolicy();
  let raw: Buffer;
  try {
    raw = await readFile(getCopilotCredentialFilePath());
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return { status: 'absent' };
    return { status: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(safeStorage.decrypt(raw));
    const credential = parseCredential(parsed);
    return credential
      ? { status: 'present', credential }
      : { status: 'unreadable' };
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    return {
      status: 'unreadable',
      ...(secureStorageFailure ? { secureStorageFailure } : {}),
    };
  }
}

let e2eSeedApplied = false;

/**
 * E2E builds may seed a connected state; production folds this branch away.
 * The seed applies once per process so a later sign-out stays signed out.
 */
async function seedFromE2eEnvironment(): Promise<boolean> {
  if (!isE2eBuild() || e2eSeedApplied) return false;
  e2eSeedApplied = true;
  const raw = process.env.CANOPY_E2E_COPILOT_CREDENTIAL?.trim();
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const credential = parseCredential(parsed);
  if (!credential) return false;
  await saveCopilotCredential(credential);
  return true;
}

export async function readCopilotCredential(): Promise<CopilotCredentialRead> {
  const first = await readFromDisk();
  if (first.status !== 'absent') return first;
  if (await seedFromE2eEnvironment()) return readFromDisk();
  return first;
}

export async function saveCopilotCredential(
  credential: CopilotCredential,
): Promise<void> {
  const safeStorage = getSecretStoragePolicy();
  const filePath = getCopilotCredentialFilePath();
  try {
    safeStorage.assertCanWrite();
    const encrypted = safeStorage.encrypt(JSON.stringify(credential));
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    safeStorage.assertCanWrite();
    await writeFileAtomically(filePath, encrypted, { mode: 0o600 });
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (secureStorageFailure)
      throw Object.assign(new Error(STORAGE_UNAVAILABLE), {
        secureStorageFailure,
      });
    throw error;
  }
}

export async function clearCopilotCredential(): Promise<void> {
  await rm(getCopilotCredentialFilePath(), { force: true });
}
