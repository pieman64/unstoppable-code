// Host-injected stand-ins for the C5 descriptor and C2c supervision seams;
// replace with their contracts once those land.

export interface CanopyRuntimeDescriptor {
  /** Format version; any other value fails closed as malformed. */
  readonly version: 1;
  readonly pid: number;
  /** Opaque process start identity, compared by equality to detect PID reuse. */
  readonly startIdentity: string;
  readonly endpoint: {
    readonly kind: 'socket' | 'pipe';
    readonly path: string;
  };
  /** Inclusive protocol major range. */
  readonly protocolRange: { readonly min: number; readonly max: number };
  readonly buildVersion: string;
  readonly tokenRef: string;
}

/** Read-only descriptor access; never deletes or rewrites the descriptor. */
export interface CanopyRuntimeDescriptorSource {
  /** Resolves the raw descriptor value, or exactly `null` when none exists. */
  read(signal: AbortSignal): Promise<unknown>;
  readToken(tokenRef: string, signal: AbortSignal): Promise<string>;
}

export interface CanopyDaemonProcessInspector {
  /** Resolves `null` when no process has this PID. */
  inspectProcess(
    pid: number,
    signal: AbortSignal,
  ): Promise<{ readonly startIdentity: string } | null>;
}
