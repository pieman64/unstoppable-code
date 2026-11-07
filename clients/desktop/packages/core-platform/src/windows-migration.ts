import { randomBytes } from 'node:crypto';
import {
  createWindowsMigrationVerifier,
  MIGRATION_HOST_FIELDS,
  MIGRATION_LAUNCHER_TRANSPORT,
  type MigrationAdmissionPort,
  type MigrationChannelFacts,
  type MigrationHostFacts,
  type MigrationWindowsDestinationEvidence,
  type PreparedWindowsMigrationTrust,
  type WindowsMigrationCapture,
  type WindowsVerificationResult,
} from '@canopy/core-runtime/node/vault';
import {
  createHostTrustGeneration,
  type HostLocalCapability,
} from './prepared-trust';

/** These cannot be bypassed by a checker report or a runtime image match. */
export const WINDOWS_MIGRATION_PRODUCTION_BLOCKERS = Object.freeze([
  'CAN-5762:electron-main-role-proof',
  'CAN-5865:handle-custody',
  'CAN-5885:genuine-signed-package-qualification',
]);

/** The reporting checker's actual result field is migrationRole, not exit code. */
export interface WindowsMigrationPackageReport {
  readonly migrationRole: 'eligible' | 'disabled';
  readonly disabledReasons: readonly string[];
  readonly violations: readonly string[];
}

export interface WindowsMigrationPreparation {
  /** Authenticated bootstrap only: all image/code/native pins precede launch. */
  readonly policy: PreparedWindowsMigrationTrust;
  /**
   * Trusted bootstrap must run the checker over the SAME pinned package as
   * policy, including its update observation. Report fields do not authenticate
   * a package: this adapter cannot detect a host supplying another package's
   * report. No production Windows package authenticator is supplied here.
   * Re-read on every lookup; a non-positive read permanently retires trust.
   */
  readonly checkPackage: () => WindowsMigrationPackageReport | null;
}

type Prepared = HostLocalCapability<'package-admission'>;
const preparations = new WeakMap<object, PreparedWindowsMigrationTrust>();

function eligible(report: WindowsMigrationPackageReport | null): boolean {
  return (
    report?.migrationRole === 'eligible' &&
    Array.isArray(report.disabledReasons) &&
    report.disabledReasons.length === 0 &&
    Array.isArray(report.violations) &&
    report.violations.length === 0
  );
}

/**
 * Disabled host composition of authenticated bootstrap observations, not a
 * package authenticator. CAN-5855 native load capabilities cannot mint this.
 */
export function prepareWindowsMigrationTrust(
  options: WindowsMigrationPreparation,
): { readonly capability: Prepared; readonly invalidate: () => void } | null {
  const generation = createHostTrustGeneration('package-admission');
  const callbacks = new Set<() => void>();
  let retired = false;
  let unsubscribe = (): void => undefined;
  function invalidate(): void {
    if (retired) return;
    retired = true;
    generation.invalidate();
    for (const callback of [...callbacks]) {
      try {
        callback();
      } catch {
        /* One consumer must not prevent other channels/sessions retiring. */
      }
    }
    callbacks.clear();
    try {
      unsubscribe();
    } catch {
      /* Already retired. */
    }
  }
  try {
    if (!eligible(options.checkPackage()) || !options.policy.current())
      return null;
    const expectations = Object.freeze({
      ...options.policy.expectations,
      package: Object.freeze({ ...options.policy.expectations.package }),
    });
    const launcher = Object.freeze({ ...options.policy.image('launcher') });
    const daemon = Object.freeze({ ...options.policy.image('daemon') });
    const snapshot = JSON.stringify([expectations, launcher, daemon]);
    unsubscribe = options.policy.onInvalidate(invalidate);
    if (retired) {
      unsubscribe();
      return null;
    }
    const capability = generation.issue();
    const trust: PreparedWindowsMigrationTrust = Object.freeze({
      expectations,
      image: (role: 'launcher' | 'daemon') =>
        role === 'launcher' ? launcher : daemon,
      current(): boolean {
        try {
          if (
            !retired &&
            generation.accepts(capability) &&
            eligible(options.checkPackage()) &&
            options.policy.current() &&
            JSON.stringify([
              options.policy.expectations,
              options.policy.image('launcher'),
              options.policy.image('daemon'),
            ]) === snapshot &&
            !retired
          )
            return true;
        } catch {
          /* Unreadable observations permanently withdraw the generation. */
        }
        invalidate();
        return false;
      },
      onInvalidate(callback: () => void): () => void {
        if (retired) callback();
        else callbacks.add(callback);
        return (): void => {
          callbacks.delete(callback);
        };
      },
    });
    if (!trust.current()) return null;
    preparations.set(capability, trust);
    return Object.freeze({ capability, invalidate });
  } catch {
    invalidate();
    return null;
  }
}

export type WindowsMigrationAdmissionResult =
  | { readonly admitted: true; readonly caller: MigrationChannelFacts }
  | { readonly admitted: false; readonly reason: string };

interface WindowsMigrationCompositionOptions {
  readonly prepared: unknown;
  readonly capture: (channel: object) => WindowsMigrationCapture | null;
  readonly host: () => MigrationHostFacts;
  /** Must revoke issued sessions and fence releases already in flight. */
  readonly retireSessions: () => void;
}

interface WindowsMigrationComposition {
  readonly admit: (channel: object) => WindowsMigrationAdmissionResult;
  readonly verifyDestination: (channel: object) => WindowsVerificationResult;
  readonly destination: (
    receipt: object,
    channel: object,
  ) => MigrationWindowsDestinationEvidence | null;
  readonly port: MigrationAdmissionPort;
  readonly close: () => void;
}

/** Production stays disabled until role proof, custody and package qualification land. */
export function createWindowsMigrationComposition(
  options: WindowsMigrationCompositionOptions,
): WindowsMigrationComposition {
  return compose(options, false);
}

/** Test-only W3 seam, not an enablement switch or a package authenticator. */
export function qualifyWindowsMigrationComposition(
  options: WindowsMigrationCompositionOptions,
): WindowsMigrationComposition {
  return compose(options, process.env.NODE_ENV === 'test');
}

function compose(
  options: WindowsMigrationCompositionOptions,
  qualification: boolean,
): WindowsMigrationComposition {
  const trust =
    qualification &&
    typeof options.prepared === 'object' &&
    options.prepared !== null
      ? preparations.get(options.prepared)
      : undefined;
  const verifier = trust
    ? createWindowsMigrationVerifier({ trust, capture: options.capture })
    : null;
  let closed = false;
  let judged = false;
  let epoch = 0;
  let live: {
    channel: object;
    receipt: object;
    caller: MigrationChannelFacts;
  } | null = null;
  let unsubscribe = (): void => undefined;
  function close(): void {
    if (closed) return;
    closed = true;
    epoch++;
    live = null;
    verifier?.close();
    try {
      options.retireSessions();
    } catch {
      /* The closed admission port also blocks issue/consume after host failure. */
    } finally {
      unsubscribe();
    }
  }
  function current(): boolean {
    if (closed || !qualification || !trust || !verifier) return false;
    if (!trust.current() || closed) {
      close();
      return false;
    }
    return true;
  }
  function facts(): MigrationHostFacts {
    return Object.freeze({ ...options.host() });
  }
  function channel(candidate: object): MigrationChannelFacts | null {
    if (!current() || !live || live.channel !== candidate) return null;
    const entry = live;
    const start = epoch;
    try {
      const host = facts();
      if (
        verifier?.lookup(entry.receipt, candidate) &&
        current() &&
        epoch === start &&
        live === entry &&
        !MIGRATION_HOST_FIELDS.some(
          (key) => host[key] !== entry.caller.admittedHost[key],
        )
      )
        return entry.caller;
    } catch {
      /* A host read cannot preserve stale admission. */
    }
    close();
    return null;
  }
  if (trust) unsubscribe = trust.onInvalidate(close);
  return Object.freeze({
    admit(candidate: object): WindowsMigrationAdmissionResult {
      if (!qualification)
        return {
          admitted: false,
          reason: WINDOWS_MIGRATION_PRODUCTION_BLOCKERS.join(','),
        };
      if (!current() || !verifier || !trust)
        return { admitted: false, reason: 'trust-unavailable' };
      if (judged) {
        close();
        return { admitted: false, reason: 'replay' };
      }
      judged = true;
      const start = epoch;
      const result = verifier.verifyLauncher(candidate);
      if (!result.verified) {
        close();
        return { admitted: false, reason: result.reason };
      }
      const peer = result.evidence.peer;
      try {
        const host = facts();
        const expected = trust.expectations;
        if (
          peer.kind !== 'captured' ||
          host.coreDigest !== expected.daemonDigest ||
          host.buildId !== expected.package.buildId ||
          host.packageDigest !== expected.package.packageDigest ||
          host.updateEpoch !== expected.package.updateEpoch ||
          !verifier.lookup(result.handle, candidate) ||
          !current() ||
          epoch !== start
        ) {
          close();
          return { admitted: false, reason: 'host-changed' };
        }
        const caller: MigrationChannelFacts = Object.freeze({
          transport: MIGRATION_LAUNCHER_TRANSPORT,
          channelId: randomBytes(16).toString('hex'),
          launcher: peer.identity,
          launcherDigest: peer.artifact.executableDigest,
          source: Object.freeze({
            flavorId: expected.package.flavorId,
            secureMode: expected.package.secureMode,
          }),
          admittedHost: host,
        });
        live = { channel: candidate, receipt: result.handle, caller };
        return { admitted: true, caller };
      } catch {
        close();
        return { admitted: false, reason: 'host-unavailable' };
      }
    },
    verifyDestination(candidate: object): WindowsVerificationResult {
      if (!current() || !verifier)
        return { verified: false, reason: 'trust-unavailable' };
      if (judged) {
        close();
        return { verified: false, reason: 'replay' };
      }
      judged = true;
      const result = verifier.verifyDestination(candidate);
      if (!result.verified) close();
      return result;
    },
    destination(
      receipt: object,
      candidate: object,
    ): MigrationWindowsDestinationEvidence | null {
      if (!current() || !verifier) return null;
      const evidence = verifier.lookup(receipt, candidate);
      if (evidence && 'spawned' in evidence) return evidence;
      close();
      return null;
    },
    port: Object.freeze({
      channel,
      host(): MigrationHostFacts {
        const candidate = live?.channel;
        if (!candidate || !channel(candidate))
          throw new Error('No admitted Windows migration channel.');
        const entry = live;
        if (!entry) throw new Error('Windows migration channel retired.');
        return entry.caller.admittedHost;
      },
    }),
    close,
  });
}
