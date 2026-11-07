#!/usr/bin/env node

/**
 * Builds the peer-identity addon (packages/core-platform/native/peer-identity)
 * the same way as the owned-child addon. Building does not sign or enable
 * migration. Linux CLI staging reuses the owned-child payload: L1/L2 peer
 * custody lives there, not in the Darwin verifier.
 *
 * Usage: node scripts/build-peer-identity.mjs [--out <file>]
 * Default output: .cache/native-peer-identity/<platform>-<arch>/
 * core-peer-identity.node on Darwin; core-owned-child.node on Linux.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOwnedChild,
  OWNED_CHILD_FILE,
  buildDarwinAddon,
} from './build-owned-child.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEER_IDENTITY_SOURCE = join(
  root,
  'packages',
  'core-platform',
  'native',
  'peer-identity',
  'src',
  'peer_identity_darwin.c',
);
export const PEER_IDENTITY_FILE = 'core-peer-identity.node';
export const PEER_IDENTITY_DEFAULT_OUTPUT = join(
  root,
  '.cache',
  'native-peer-identity',
  `${process.platform}-${process.arch}`,
  process.platform === 'linux' ? OWNED_CHILD_FILE : PEER_IDENTITY_FILE,
);

/** Returns the peer payload path, or null off Darwin/Linux. */
export function buildPeerIdentity({ out } = {}) {
  if (process.platform === 'linux')
    return buildOwnedChild({ out: out ?? PEER_IDENTITY_DEFAULT_OUTPUT });
  return buildDarwinAddon({
    source: PEER_IDENTITY_SOURCE,
    out: out ?? PEER_IDENTITY_DEFAULT_OUTPUT,
    libraries: [
      '-lbsm',
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
    ],
  });
}

function parseOut(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error('--out requires a file path.');
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const built = buildPeerIdentity({ out: parseOut(process.argv.slice(2)) });
    console.log(
      built
        ? `Done! Addon: ${built}`
        : `Peer identity addon requires Darwin or Linux; nothing built on ${process.platform}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
