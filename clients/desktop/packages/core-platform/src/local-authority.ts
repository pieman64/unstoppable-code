import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export class LocalAuthorityIdentityError extends Error {
  override readonly name = 'LocalAuthorityIdentityError';
  constructor(
    readonly code: 'invalid_brand' | 'invalid_root' | 'principal_unavailable',
  ) {
    super(`Local authority identity unavailable: ${code}.`);
  }
}

/** Trusted host observation only; never accept these inputs from a renderer. */
export interface LocalAuthorityObservation {
  readonly platform: string;
  readonly getuid: () => number | undefined;
}

export interface LocalAuthorityIdentity {
  readonly authorityId: string;
  readonly canonicalDataRoot: string;
}

/**
 * SHA-256 of the UTF-8 JSON tuple
 * ["canopy.local-authority", 1, brandId, canonicalDataRoot, ["posix-uid", uid]].
 * JSON boundaries and the version tag prevent ambiguous concatenation. This
 * authority digest is separate from the transport's existing root-only hash.
 */
export async function deriveLocalAuthorityIdentity(
  input: { readonly brandId: string; readonly dataRoot: string },
  observation: LocalAuthorityObservation = {
    platform: process.platform,
    getuid: () => process.getuid?.(),
  },
): Promise<LocalAuthorityIdentity> {
  if (
    typeof input.brandId !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(input.brandId)
  )
    throw new LocalAuthorityIdentityError('invalid_brand');
  let uid: number | undefined;
  try {
    if (observation.platform !== 'darwin' && observation.platform !== 'linux')
      throw new LocalAuthorityIdentityError('principal_unavailable');
    uid = observation.getuid();
  } catch {
    throw new LocalAuthorityIdentityError('principal_unavailable');
  }
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new LocalAuthorityIdentityError('principal_unavailable');

  let canonicalDataRoot: string;
  try {
    if (
      typeof input.dataRoot !== 'string' ||
      !isAbsolute(input.dataRoot) ||
      input.dataRoot.includes('\0')
    )
      throw new LocalAuthorityIdentityError('invalid_root');
    canonicalDataRoot = await realpath(input.dataRoot);
    if (!(await stat(canonicalDataRoot)).isDirectory())
      throw new LocalAuthorityIdentityError('invalid_root');
  } catch {
    throw new LocalAuthorityIdentityError('invalid_root');
  }
  const authorityId = createHash('sha256')
    .update(
      JSON.stringify([
        'canopy.local-authority',
        1,
        input.brandId,
        canonicalDataRoot,
        ['posix-uid', uid],
      ]),
    )
    .digest('hex');
  return { authorityId, canonicalDataRoot };
}
