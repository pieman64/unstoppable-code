// The client key agents on this device send to the proxy (CAN-4020). Each
// device adds its own key to the server's `access.api-keys`, so revoking one
// device on the server leaves the others working.
//
// The management API has no atomic append or compare-and-swap: PUT and PATCH
// both replace the whole list, and `DELETE ?value=` removes the entire list,
// which would open the server, so Canopy never sends DELETE. Canopy reads the
// list, writes it back with the new key, and reads it again to confirm. Another
// device that read the list before this write can still write over it, so the
// key is checked again a moment later and merged back into the current list.
// The write happens only when this device has no working key yet.

import { createHash, randomBytes } from 'node:crypto';
import type { AccountProxyConnection } from '@canopy/desktop-shared/types/account-proxy';
import {
  AccountProxyManagementError,
  requestAccountProxyManagement,
} from './management-client';

const CLIENT_KEYS_PATH = '/config/access/api-keys';

function readKeys(body: unknown): string[] {
  return Array.isArray(body)
    ? body.filter((value): value is string => typeof value === 'string')
    : [];
}

async function listClientKeys(
  connection: AccountProxyConnection,
  managementKey: string,
): Promise<string[]> {
  try {
    const response = await requestAccountProxyManagement({
      baseUrl: connection.url,
      managementKey,
      method: 'GET',
      path: CLIENT_KEYS_PATH,
    });
    return readKeys(response.body);
  } catch (error) {
    // A server with no client keys has no `access.api-keys` node yet.
    if (
      error instanceof AccountProxyManagementError &&
      error.code === 'management-disabled'
    ) {
      return [];
    }
    throw error;
  }
}

async function writeClientKeys(
  connection: AccountProxyConnection,
  managementKey: string,
  keys: readonly string[],
): Promise<void> {
  await requestAccountProxyManagement({
    baseUrl: connection.url,
    managementKey,
    method: 'PUT',
    path: CLIENT_KEYS_PATH,
    body: keys,
  });
}

/** Names a client key in logs and broker callbacks without revealing it. */
/** Sent upstream when the server has no client keys and accepts anything. */
export const ACCOUNT_PROXY_OPEN_SERVER_TOKEN = 'canopy-open-server';

export function accountProxyClientKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function generateAccountProxyClientKey(): string {
  return `canopy-${randomBytes(24).toString('hex')}`;
}

/**
 * Returns this device's client key, adding a new one to the server when the
 * stored key is missing or the server no longer lists it. Returns null for a
 * server with no client keys at all: it accepts every request, and adding a
 * key would switch on authentication for every other client.
 */
export async function ensureAccountProxyClientKey(
  connection: AccountProxyConnection,
  managementKey: string,
  storedKey: string | null,
  options: { readonly settleMs?: number } = {},
): Promise<string | null> {
  const keys = await listClientKeys(connection, managementKey);
  if (keys.length === 0) return null;
  if (storedKey && keys.includes(storedKey)) return storedKey;
  const key = generateAccountProxyClientKey();
  let current = keys;
  for (let attempt = 0; attempt < KEY_WRITE_ATTEMPTS; attempt += 1) {
    await writeClientKeys(connection, managementKey, [...current, key]);
    if (!(await listClientKeys(connection, managementKey)).includes(key)) {
      throw new AccountProxyManagementError('unexpected');
    }
    // A device that read the list before this write lands its own write a
    // moment later; check again and merge this key back in if it was dropped.
    await delay(options.settleMs ?? KEY_SETTLE_MS);
    current = await listClientKeys(connection, managementKey);
    if (current.includes(key)) return key;
    // The server was emptied in between: it is open, so the key is not added.
    if (current.length === 0) return null;
  }
  throw new AccountProxyManagementError('unexpected');
}

/** How many times a key dropped by another device's write is put back. */
const KEY_WRITE_ATTEMPTS = 3;
/** Long enough for another device's read-modify-write to land. */
const KEY_SETTLE_MS = 1_500;

function delay(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

/**
 * Removes this device's key from the server. Best effort on disconnect.
 * When it is the last key, it stays: an empty list would let anyone who can
 * reach the server use its accounts.
 */
export async function revokeAccountProxyClientKey(
  connection: AccountProxyConnection,
  managementKey: string,
  key: string,
): Promise<void> {
  const keys = await listClientKeys(connection, managementKey);
  if (!keys.includes(key)) return;
  const remaining = keys.filter((candidate) => candidate !== key);
  if (remaining.length === 0) return;
  await writeClientKeys(connection, managementKey, remaining);
}
