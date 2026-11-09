'use client';

import { Component, type ReactNode } from 'react';

/**
 * Keeps a failure in the reporting UI from reaching the recovery UI it sits
 * beside: it renders nothing rather than rethrowing into the parent boundary.
 *
 * Its own module, so a panel importing it doesn't pull in the report form's
 * loader.
 */
export class ReportActionBoundary extends Component<
  { readonly children: ReactNode; readonly fallback?: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed
      ? (this.props.fallback ?? null)
      : this.props.children;
  }
}
