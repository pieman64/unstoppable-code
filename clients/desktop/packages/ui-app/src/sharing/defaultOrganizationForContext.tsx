'use client';

import { useEffect, useRef, type JSX } from 'react';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { Notice } from '@canopy/ui-shared';
import { buildOrganizationOptions } from '../code/shell/SidebarContextRow';

/**
 * CAN-3460: the organization a share or invite form should start on.
 *
 * The navigation context supplies a default, never authorization, and the
 * caller always lets the user pick another eligible organization.
 *
 * - Organization context: that organization when it is eligible, else none.
 * - Personal context: none.
 * - No scoping context (flag off or not hydrated): the only eligible
 *   organization when there is exactly one, else none. Choosing the only
 *   option is not a guess; `[0]` of several is.
 */
export function defaultOrganizationForContext(
  context: WorkspaceContext | undefined,
  eligible: readonly { readonly id: string }[],
): string | null {
  if (context === undefined) {
    return eligible.length === 1 ? (eligible[0]?.id ?? null) : null;
  }
  if (context.kind === 'personal') {
    return null;
  }
  const organizationId = context.organizationId.toLowerCase();
  return (
    eligible.find(
      (organization) => organization.id.toLowerCase() === organizationId,
    )?.id ?? null
  );
}

/**
 * Fires `onRebind(next, previous)` when a *defined* context changes to a
 * different one while the caller is mounted. Hydration from `undefined`, and
 * a context that goes back to `undefined`, never fire.
 */
export function useContextRebind(
  context: WorkspaceContext | undefined,
  onRebind: (next: WorkspaceContext, previous: WorkspaceContext) => void,
  paused = false,
): void {
  const previousRef = useRef<WorkspaceContext | undefined>(context);
  const onRebindRef = useRef(onRebind);
  onRebindRef.current = onRebind;
  const key = context === undefined ? null : serializeWorkspaceContext(context);

  useEffect(() => {
    const previous = previousRef.current;
    if (context === undefined) {
      previousRef.current = undefined;
      return;
    }
    // Keep the last applied context while a mutation owns the form. Including
    // `paused` in the effect dependencies replays the latest defined context
    // as soon as the mutation settles instead of consuming the change.
    if (paused) return;
    previousRef.current = context;
    if (
      previous !== undefined &&
      serializeWorkspaceContext(previous) !== serializeWorkspaceContext(context)
    ) {
      onRebindRef.current(context, previous);
    }
    // `key` carries the context identity; the object itself may be recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, paused]);
}

/** The label a context-changed notice names: the org's name, or Personal. */
export function contextLabel(
  context: WorkspaceContext,
  organizations: readonly { readonly id: string; readonly name: string }[],
): string {
  if (context.kind === 'personal') {
    return 'Personal';
  }
  const organizationId = context.organizationId.toLowerCase();
  const option = buildOrganizationOptions(organizations).find(
    ({ organization }) => organization.id.toLowerCase() === organizationId,
  );
  if (!option) return 'the selected organization';
  return option.secondary
    ? `${option.organization.name} (${option.secondary})`
    : option.organization.name;
}

export interface ContextChangedNoticeProps {
  /** Organization name, or `Personal`. */
  label: string;
  'data-testid'?: string;
}

/** Inline notice shown when the selected context changed under a dialog. */
export function ContextChangedNotice({
  label,
  'data-testid': testId,
}: ContextChangedNoticeProps): JSX.Element {
  return <Notice data-testid={testId}>{`Switched to ${label}.`}</Notice>;
}
