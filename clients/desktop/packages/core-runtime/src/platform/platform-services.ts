// ADR 25 host-adapter port. Type-only: no Node, Electron, net, or transport
// imports. Local paths stay at this boundary, outside portable operation DTOs;
// no Node handles cross it. `@canopy/core-platform`
// selects one implementation per host at composition. Endpoint families land
// first (C2a scaffold, CAN-3763; behavior in CAN-3766); secure files and paths
// are C2b/C2b2 members; child supervision is C2c.

export type PlatformOperatingSystem = 'darwin' | 'win32' | 'linux';

export type PlatformSupportTier = 'primary';

/**
 * `filesystem-socket`: a Unix socket path that can outlive its process, so a
 * stale path needs probe, identity re-check, and unlink under the startup claim.
 * `first-instance-pipe`: a Windows named pipe bound with first-instance
 * semantics; it has no filesystem node and nothing to unlink.
 */
export type PlatformEndpointSemantics =
  | 'filesystem-socket'
  | 'first-instance-pipe';

export interface PlatformUnixSocketAddress {
  readonly kind: 'unix-socket';
  readonly path: string;
}

export interface PlatformNamedPipeAddress {
  readonly kind: 'named-pipe';
  readonly path: string;
}

export interface PlatformEndpointAddressRequest {
  /** Trusted host input; never serialized as an operation DTO (D3). */
  readonly dataRoot: string;
  readonly endpointName: string;
}

/**
 * Filesystem identity of a socket path, captured when a probe was refused.
 * It proves only that the path is the node that refused, never which daemon
 * owns a live endpoint: daemon identity (D3 token + nonce and the hashed
 * data-root echo) is established by the transport handshake, not this port.
 */
export interface PlatformEndpointPathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

/**
 * Held by the caller across probe, unlink, bind, and descriptor publication.
 * Acquiring it is the caller's job (C5); this port only demands it for the
 * destructive step. This is host-adapter state, not a portable operation DTO.
 */
export interface PlatformStartupClaim {
  readonly dataRoot: string;
  readonly claimId: string;
}

/** A raw, pull-based byte stream. Backpressure: `write` resolves once a bounded buffer accepts the bytes. */
export interface PlatformByteStream {
  /** Aborts when the stream closes from either side. */
  readonly signal: AbortSignal;
  /** Resolves `null` once the peer has closed and buffered bytes are drained. */
  read(options?: { readonly signal?: AbortSignal }): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface PlatformEndpointListener<TAddress> {
  readonly address: TAddress;
  /** At most 32 live streams; excess connections are closed. Ends after `close`. */
  connections(): AsyncIterable<PlatformByteStream>;
  /**
   * Stops accepting and releases the endpoint. Resolves only once the
   * endpoint is closed; descriptor cleanup must wait for it (D3).
   */
  close(): Promise<void>;
}

/** `in-use`: another instance owns the endpoint. The bound endpoint is the lifetime lock. */
export type PlatformEndpointBindResult<TAddress> =
  | {
      readonly kind: 'bound';
      readonly listener: PlatformEndpointListener<TAddress>;
    }
  | { readonly kind: 'in-use' };

export type PlatformSocketBindResult =
  | {
      readonly kind: 'bound';
      readonly listener: PlatformEndpointListener<PlatformUnixSocketAddress>;
      /** Receipt for the node published at the path; descriptors record it as `socketIdentity`. */
      readonly identity: PlatformEndpointPathIdentity;
    }
  | { readonly kind: 'in-use' };

/** `ambiguous` fails closed: never unlink or bind on it. */
export type PlatformSocketProbeResult =
  | { readonly state: 'live' }
  | { readonly state: 'absent' }
  | {
      readonly state: 'refused';
      readonly identity: PlatformEndpointPathIdentity;
    }
  | { readonly state: 'ambiguous'; readonly reason: string };

export type PlatformPipeProbeResult =
  | { readonly state: 'live' }
  | { readonly state: 'absent' }
  | { readonly state: 'ambiguous'; readonly reason: string };

export type PlatformEndpointIdentityCheck = 'match' | 'changed' | 'absent';

export interface PlatformUnlinkStaleRequest {
  readonly address: PlatformUnixSocketAddress;
  readonly expected: PlatformEndpointPathIdentity;
  readonly claim: PlatformStartupClaim;
}

/**
 * `changed` fails closed. The startup claim serializes cooperating launchers;
 * re-checking identity before unlink narrows, but does not eliminate, the
 * window in which a non-cooperating process replaces the path.
 */
export type PlatformUnlinkStaleResult = 'unlinked' | 'changed' | 'absent';

export interface PlatformSocketEndpointServices {
  readonly semantics: 'filesystem-socket';
  address(request: PlatformEndpointAddressRequest): PlatformUnixSocketAddress;
  bind(address: PlatformUnixSocketAddress): Promise<PlatformSocketBindResult>;
  probe(address: PlatformUnixSocketAddress): Promise<PlatformSocketProbeResult>;
  verifyIdentity(
    address: PlatformUnixSocketAddress,
    expected: PlatformEndpointPathIdentity,
  ): Promise<PlatformEndpointIdentityCheck>;
  /**
   * Caller must first prove the path is the descriptor's recorded socket and
   * its owner exited, or hold a claim recovered from a departed holder that
   * marked its bind; refusal alone is insufficient.
   */
  unlinkStale(
    request: PlatformUnlinkStaleRequest,
  ): Promise<PlatformUnlinkStaleResult>;
}

export interface PlatformPipeEndpointServices {
  readonly semantics: 'first-instance-pipe';
  address(request: PlatformEndpointAddressRequest): PlatformNamedPipeAddress;
  bind(
    address: PlatformNamedPipeAddress,
  ): Promise<PlatformEndpointBindResult<PlatformNamedPipeAddress>>;
  probe(address: PlatformNamedPipeAddress): Promise<PlatformPipeProbeResult>;
}

/** Callers branch on `semantics`, not on the OS name. */
export type PlatformEndpointServices =
  | PlatformSocketEndpointServices
  | PlatformPipeEndpointServices;

export type PlatformPermissionResult =
  | { readonly state: 'private' }
  | { readonly state: 'insecure' | 'unverifiable'; readonly reason: string };

export interface PlatformPermissionRequest {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly mode: 'owner-only' | 'owner-executable';
  readonly action: 'verify' | 'restrict';
}

export interface PlatformRenameRequest {
  readonly from: string;
  readonly to: string;
  readonly mode: 'replace' | 'no-replace';
}

export type PlatformRenameResult =
  | { readonly kind: 'exists' }
  | {
      readonly kind: 'renamed';
      /** Observation at completion, never permission to blindly unlink the path later. */
      readonly sourceState:
        | 'removed'
        | 'retained'
        | 'changed-or-absent'
        | 'unknown';
    };

/** Host paths only. Callers supply already-private parent directories. */
export interface PlatformSecureFileServices {
  readonly permissionModel: 'posix-mode' | 'windows-dacl';
  /** POSIX uses 0600/0700 and removes Darwin ACLs. Windows verifies without repair. */
  permissions(
    request: PlatformPermissionRequest,
  ): Promise<PlatformPermissionResult>;
  /** Singly-linked regular sources only; atomic no-replace fails closed without hard links. */
  rename(request: PlatformRenameRequest): Promise<PlatformRenameResult>;
  /** Windows is a no-op and returns `unsupported`, never a durability claim. */
  syncDirectory(path: string): Promise<'flushed' | 'unsupported'>;
}

export interface PlatformAppDirectoryRequest {
  readonly appName: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface PlatformAppDirectories {
  readonly data: string;
  readonly config: string;
  readonly logs: string;
  readonly runtime: string | null;
}

export interface PlatformPathServices {
  appDataDir(request: PlatformAppDirectoryRequest): PlatformAppDirectories;
  /** Derives discovery storage from the explicit canonical data root; never relocates it to XDG. */
  runtimeDirectory(request: { readonly dataRoot: string }): string;
}

export interface PlatformChildProcessRequest {
  readonly lifetime: 'owned' | 'independent';
}

export interface PlatformChildProcessOptions {
  readonly detached: boolean;
  readonly windowsHide: boolean;
}

export interface PlatformChildEnvironmentRequest {
  /** Trusted host inputs, selected through an allowlist; never operation DTOs. */
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly pathEntries?: readonly string[];
}

export type PlatformStopMode = 'graceful' | 'force';

export interface PlatformKillTreeRequest {
  /** Owned, unreaped child PID; POSIX children must lead their process group. */
  readonly pid: number;
  readonly mode: PlatformStopMode;
  readonly signal?: AbortSignal;
}

export type PlatformKillTreeResult =
  | { readonly kind: 'signaled'; readonly mode: PlatformStopMode }
  | { readonly kind: 'absent' };

export interface PlatformProcessInspectionRequest {
  readonly pid: number;
  readonly signal?: AbortSignal;
}

export type PlatformProcessInspection =
  | { readonly state: 'running'; readonly startIdentity: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unverifiable'; readonly reason: string };

export interface PlatformSupervisionServices {
  childProcessOptions(
    request: PlatformChildProcessRequest,
  ): PlatformChildProcessOptions;
  childEnvironment(
    request: PlatformChildEnvironmentRequest,
  ): Readonly<Record<string, string>>;
  /** Signal delivery is not confirmation of exit; Windows always reports force. */
  killProcessTree(
    request: PlatformKillTreeRequest,
  ): Promise<PlatformKillTreeResult>;
  /** Identity observation is not daemon authentication or authority to kill. */
  inspectProcess(
    request: PlatformProcessInspectionRequest,
  ): Promise<PlatformProcessInspection>;
}

/**
 * Host-only: a spawned root whose process group stays owned until committed
 * or terminated. Not part of PlatformServices or any portable DTO.
 */
export interface PlatformOwnedChild {
  /** The actual root PID, for correlation only; never authority to signal. */
  readonly pid: number;
  /** Resolves when root exit is observed; termination may still be pending. */
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
  /**
   * Synchronously gives up stop authority; the root is reaped once it exits.
   * Throws once the root has exited: its group is left for `terminate`.
   */
  commit(signal?: AbortSignal): void;
  /**
   * Stops the owned group and reaps the root once no member remains.
   * Idempotent after cleanup; rejects once committed or when cleanup is unconfirmed.
   */
  terminate(signal?: AbortSignal): Promise<void>;
}

export interface PlatformOwnedChildServices {
  /** Rejects only when no child was created; otherwise returns the owning handle. */
  spawn(request: {
    readonly executable: string;
    readonly args: readonly string[];
    /** The complete child environment; nothing is inherited. */
    readonly environment: Readonly<Record<string, string>>;
    /** Private bounded handoff, written then closed; never argv or environment. */
    readonly stdin?: string;
  }): Promise<PlatformOwnedChild>;
}

export interface PlatformServices {
  readonly os: PlatformOperatingSystem;
  readonly tier: PlatformSupportTier;
  readonly endpoints: PlatformEndpointServices;
  readonly secureFiles: PlatformSecureFileServices;
  readonly paths: PlatformPathServices;
  readonly supervision: PlatformSupervisionServices;
}
