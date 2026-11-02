/**
 * A host-supplied action a shared component renders: available with the
 * function to run, or disabled with the reason the host cannot run it. Shared
 * components gate on this instead of branching on which host mounted them.
 */
export type HostAction<F> =
  | { readonly available: true; readonly run: F }
  | { readonly available: false; readonly reason: string };
