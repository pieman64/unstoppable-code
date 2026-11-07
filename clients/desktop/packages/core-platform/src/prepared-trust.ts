/** Host-local evidence only; no serializable object is an authorization token. */
export type PreparedTrustScope = 'native-preparation' | 'package-admission';
declare const capabilityType: unique symbol;
export interface HostLocalCapability<Scope extends PreparedTrustScope> {
  readonly scope: Scope;
  readonly [capabilityType]: true;
}

export interface HostTrustGeneration<Scope extends PreparedTrustScope> {
  readonly issue: () => HostLocalCapability<Scope>;
  readonly accepts: (
    candidate: unknown,
  ) => candidate is HostLocalCapability<Scope>;
  readonly invalidate: () => void;
}

/** A verifier owns its generation. Invalidation is permanent, not a refresh. */
export function createHostTrustGeneration<Scope extends PreparedTrustScope>(
  scope: Scope,
): HostTrustGeneration<Scope> {
  const members = new WeakSet<object>();
  let live = true;
  function accepts(
    candidate: unknown,
  ): candidate is HostLocalCapability<Scope> {
    return (
      live &&
      typeof candidate === 'object' &&
      candidate !== null &&
      members.has(candidate)
    );
  }
  function issue(): HostLocalCapability<Scope> {
    if (!live) throw new Error('Trust generation retired.');
    const token = Object.freeze({ scope });
    members.add(token);
    // Registry membership supplies the opaque type, not a caller-controlled field.
    if (!accepts(token)) throw new Error('Trust capability unavailable.');
    return token;
  }
  return {
    issue,
    accepts,
    invalidate: (): void => {
      live = false;
    },
  };
}
