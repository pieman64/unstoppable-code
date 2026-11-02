import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SelectOption } from '@canopy/ui-shared/components';
import {
  parseWorkspaceContext,
  PERSONAL_WORKSPACE_CONTEXT,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { workspaceContextLabel } from '@/lib/automationContextScope';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const PERSONAL_OWNER = serializeWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT);

/**
 * Who can own a run with no project (CAN-4542): Personal and the account's
 * organizations, from the main-owned workspace context. An account read that
 * has not finished, or failed, is never taken as Personal.
 */
export type PipelineRunOwnerChoices =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | {
      readonly status: 'ready';
      /** Organization projects are off or the account has none. */
      readonly personalOnly: boolean;
      readonly options: readonly SelectOption[];
      /** The selected navigation context, when it is a choice. */
      readonly navigationOwner: string | null;
      readonly labelFor: (owner: string) => string;
    };

export function usePipelineRunOwnerChoices(): PipelineRunOwnerChoices {
  const enabled = useCanopyOrgProjectsEnabled();
  const hydrated = useWorkspaceContextStore((store) => store.hydrated);
  const context = useWorkspaceContextStore((store) => store.state.context);
  const organizations = useWorkspaceContextStore(
    (store) => store.state.organizations,
  );
  const hydrate = useWorkspaceContextStore((store) => store.hydrate);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The store swallows a failed read and stays unhydrated; ask once more and
  // treat a read that still leaves it unhydrated as a failure.
  useEffect(() => {
    if (!enabled || hydrated) return;
    let cancelled = false;
    void hydrate().then(() => {
      if (cancelled) return;
      if (!useWorkspaceContextStore.getState().hydrated) setFailed(true);
    });
    return (): void => {
      cancelled = true;
    };
  }, [attempt, enabled, hydrate, hydrated]);

  const retry = useCallback((): void => {
    setFailed(false);
    setAttempt((current) => current + 1);
  }, []);

  return useMemo((): PipelineRunOwnerChoices => {
    const labelFor = (owner: string): string => {
      const parsed = parseWorkspaceContext(owner);
      return parsed
        ? workspaceContextLabel(parsed, organizations)
        : workspaceContextLabel(PERSONAL_WORKSPACE_CONTEXT, organizations);
    };
    if (!enabled) {
      return {
        status: 'ready',
        personalOnly: true,
        options: [{ value: PERSONAL_OWNER, label: labelFor(PERSONAL_OWNER) }],
        navigationOwner: PERSONAL_OWNER,
        labelFor,
      };
    }
    if (!hydrated) {
      return failed ? { status: 'error', retry } : { status: 'loading' };
    }
    const options: SelectOption[] = [
      { value: PERSONAL_OWNER, label: labelFor(PERSONAL_OWNER) },
      ...organizations.map((organization) => ({
        value: serializeWorkspaceContext({
          kind: 'organization',
          organizationId: organization.id,
        }),
        label: organization.name,
      })),
    ];
    const selected = serializeWorkspaceContext(context);
    return {
      status: 'ready',
      personalOnly: organizations.length === 0,
      options,
      navigationOwner: options.some((option) => option.value === selected)
        ? selected
        : null,
      labelFor,
    };
  }, [context, enabled, failed, hydrated, organizations, retry]);
}

/**
 * The owner a person picked for this dialog. The first valid default is kept,
 * so a later navigation switch never replaces it; a choice that stops being
 * available is cleared and reported, never silently switched.
 */
export function usePipelineRunOwnerSelection(
  choices: PipelineRunOwnerChoices,
): {
  value: string | null;
  stale: boolean;
  choose: (owner: string) => void;
} {
  const [picked, setPicked] = useState<string | null>(null);
  const [initial, setInitial] = useState<string | null | undefined>(undefined);
  if (initial === undefined && choices.status === 'ready') {
    setInitial(choices.navigationOwner);
  }
  const wanted = picked ?? initial ?? null;
  const available =
    choices.status === 'ready' &&
    wanted !== null &&
    choices.options.some((option) => option.value === wanted);
  return {
    value: available ? wanted : null,
    stale: choices.status === 'ready' && wanted !== null && !available,
    choose: setPicked,
  };
}
