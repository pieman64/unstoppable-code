'use client';

import type { JSX, ReactNode } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { useCapabilities } from '@canopy/app-state';

export interface CapabilityGateProps {
  /**
   * Predicate over the host's capability flags. Children render only when it
   * returns true — e.g. `(c) => c.terminalPty` to show an interactive terminal
   * only where the host supports one.
   */
  readonly when: (capabilities: CanopyCapabilities) => boolean;
  readonly children: ReactNode;
  /** Rendered instead of `children` when the capability is absent. */
  readonly fallback?: ReactNode;
}

/**
 * Capability-gated rendering — the canonical way shared feature components
 * branch on what the host can do, instead of `if (isWeb)`. The first shared
 * primitive in `@canopy/ui-app`; feature panels (chat, file viewer, activity,
 * overview) land in later tickets and use this to gate desktop-only / remote
 * affordances.
 */
export function CapabilityGate({
  when,
  children,
  fallback = null,
}: CapabilityGateProps): JSX.Element {
  const capabilities = useCapabilities();
  return <>{when(capabilities) ? children : fallback}</>;
}
