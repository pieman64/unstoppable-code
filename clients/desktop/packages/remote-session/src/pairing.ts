import {
  PAIR_PROOF_LABEL,
  PairRequestResultSchema,
  REMOTE_METHODS,
  UnknownRemoteMethodError,
  type PairRequestParams,
} from '@canopy/protocol/remote-control';
import type { DevicePlatform } from '@canopy/protocol/device-relay';
import { concatBytes, encodeBase64Url, utf8, type Bytes } from './bytes';
import { helloHost, type ControllerProfile } from './controller-connection';
import { RemoteSessionError } from './errors';
import { RpcPeer } from './rpc-peer';
import { defaultScheduler, type SchedulerPort } from './scheduler';
import type { RemoteSessionManager } from './session-manager';
import { hmacSha256 } from './web-crypto';

/** Pairing link secrets are 32 bytes (`#device=…&secret=…`). */
export const PAIR_PROOF_SECRET_BYTES = 32;
/** How long the desktop waits for its user to answer a pairing request. */
export const PAIRING_DECISION_TIMEOUT_MS = 3 * 60_000;

/**
 * The pairing proof a link holder sends in `pair.request`:
 * HMAC-SHA256(secret, UTF-8 `canopy-pair-proof-v1` || transcriptHash),
 * canonical unpadded base64url. Binding the handshake transcript means a
 * proof is useless on any other session.
 */
export async function computePairProof(
  secret: Uint8Array,
  transcriptHash: Uint8Array,
): Promise<string> {
  if (secret.byteLength !== PAIR_PROOF_SECRET_BYTES) {
    throw new Error('Pairing secrets are 32 bytes.');
  }
  return encodeBase64Url(
    await hmacSha256(
      secret,
      concatBytes([utf8(PAIR_PROOF_LABEL), transcriptHash]),
    ),
  );
}

export interface PairWithHostOptions {
  sessions: RemoteSessionManager;
  hostDeviceId: string;
  controller: ControllerProfile;
  /** Shown on the host. `kind` is taken from `controller.kind`. */
  request: { name: string; platform: DevicePlatform };
  /**
   * The 32-byte secret from a pairing link. With it, the host approves on
   * the proof alone and requires `features.pairingProof`; without it, the
   * host asks its user to compare the short authentication string.
   */
  proofSecret?: Uint8Array;
  /** Called with the six-digit code once the handshake finishes. */
  onShortAuthenticationString?: (code: string) => void;
  signal?: AbortSignal;
  /** Defaults to the desktop decision timeout plus 10 s. */
  timeoutMs?: number;
  scheduler?: SchedulerPort;
}

export interface PairingResult {
  approved: boolean;
  hostDeviceId: string;
  /** Pin this key for later control sessions (only when approved). */
  hostPublicKey: string;
  hostName: string;
  hostPlatform: DevicePlatform;
  shortAuthenticationString: string;
  transcriptHash: Bytes;
  method: 'proof' | 'sas';
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Pairs with a host over a `pair` session: handshake (no pin; the host key
 * must hash to its device ID), `session.hello` to confirm the host supports
 * this controller (and proof pairing when a secret is given), then
 * `pair.request` with an optional transcript-bound proof. Nothing is retried;
 * the caller persists the pin only when `approved` is true.
 *
 * Legacy desktop controllers (`kind: 'desktop'`) skip `session.hello`, as the
 * desktop's own pairing does.
 */
export async function pairWithHost(
  options: PairWithHostOptions,
): Promise<PairingResult> {
  if (isAborted(options.signal)) {
    throw new RemoteSessionError('cancelled', 'Pairing was cancelled.');
  }
  const session = await options.sessions.connect({
    peerDeviceId: options.hostDeviceId,
    purpose: 'pair',
    pinnedPeerPublicKey: null,
  });
  if (isAborted(options.signal)) {
    session.close('closed');
    throw new RemoteSessionError('cancelled', 'Pairing was cancelled.');
  }
  const rpc = new RpcPeer(session, {
    scheduler: options.scheduler ?? defaultScheduler,
    onEvent: (): void => undefined,
    onRequest: (method): Promise<unknown> =>
      Promise.reject(new UnknownRemoteMethodError(method)),
  });
  const abort = (): void => rpc.close('closed');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const restricted = options.controller.kind !== 'desktop';
    const usesProof = options.proofSecret !== undefined;
    if (restricted) {
      await helloHost(rpc, options.controller, { pairingProof: usesProof });
    }
    const code = session.handshake.shortAuthenticationString;
    options.onShortAuthenticationString?.(code);
    const params: PairRequestParams = {
      kind: options.controller.kind,
      name: options.request.name,
      platform: options.request.platform,
    };
    if (options.proofSecret !== undefined) {
      params.proof = await computePairProof(
        options.proofSecret,
        session.handshake.transcriptHash,
      );
    }
    const result = PairRequestResultSchema.parse(
      await rpc.request(REMOTE_METHODS.pairRequest, params, {
        timeoutMs: options.timeoutMs ?? PAIRING_DECISION_TIMEOUT_MS + 10_000,
      }),
    );
    return {
      approved: result.approved,
      hostDeviceId: session.peerDeviceId,
      hostPublicKey: session.handshake.peerPublicKey,
      hostName: result.name,
      hostPlatform: result.platform,
      shortAuthenticationString: code,
      transcriptHash: session.handshake.transcriptHash,
      method: usesProof ? 'proof' : 'sas',
    };
  } catch (error) {
    if (isAborted(options.signal)) {
      throw new RemoteSessionError('cancelled', 'Pairing was cancelled.');
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    rpc.close('closed');
  }
}
