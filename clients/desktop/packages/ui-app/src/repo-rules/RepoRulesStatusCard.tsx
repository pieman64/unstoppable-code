'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import { useCanopyClient } from '@canopy/app-state';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import { CapabilityGate } from '../capability/CapabilityGate';

export interface RepoRulesStatusCardProps {
  readonly workspaceId: string;
  /** Opens the review for this workspace. */
  readonly onReview: () => void;
  /** Change it to reload the saved setting, e.g. after the review closes. */
  readonly refreshToken?: number;
}

type CardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: RepoRulesStatus }
  | { readonly kind: 'error' };

function statusSentence(status: RepoRulesStatus): string {
  if (
    status.diagnostic === 'invalid' ||
    status.diagnostic === 'unsupported-version'
  )
    return "Off. The saved setting couldn't be read. Review the rules to turn them on again.";
  if (!status.enabled)
    return "Off. Review this project's Cursor rules to use them in new chats.";
  const off = status.disabledRuleIds.length;
  const except =
    off === 0
      ? ''
      : off === 1
        ? ', except 1 turned off'
        : `, except ${off} turned off`;
  return `On. New chats use this project's Cursor rules${except}. Chats already running keep the instructions they started with.`;
}

/**
 * Saved Cursor rules setting for one workspace (CAN-2053), for Project
 * Settings. Reads the policy only and never scans the repository, so turning
 * rules off works even when the checkout is unavailable. Renders nothing on a
 * host without `repoRulesImport`.
 */
export function RepoRulesStatusCard(
  props: RepoRulesStatusCardProps,
): JSX.Element {
  return (
    <CapabilityGate
      when={(capabilities) => capabilities.repoRulesImport === true}
    >
      <RepoRulesStatusCardBody key={props.workspaceId} {...props} />
    </CapabilityGate>
  );
}

function RepoRulesStatusCardBody({
  workspaceId,
  onReview,
  refreshToken = 0,
}: RepoRulesStatusCardProps): JSX.Element {
  const client = useCanopyClient();
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [turningOff, setTurningOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    client
      .query('repoRules.status', { workspaceId })
      .then((status) => {
        if (generation.current === current) setState({ kind: 'ready', status });
      })
      .catch(() => {
        if (generation.current === current) setState({ kind: 'error' });
      });
  }, [client, workspaceId, refreshToken]);

  useEffect(() => {
    const responses = generation;
    return (): void => {
      responses.current += 1;
    };
  }, []);

  const turnOff = (): void => {
    if (turningOff) return;
    const current = generation.current;
    setTurningOff(true);
    setError(null);
    client
      .command('repoRules.apply', { workspaceId, enabled: false })
      .then((status) => {
        if (generation.current !== current) return;
        setTurningOff(false);
        setState({ kind: 'ready', status });
      })
      .catch((cause: unknown) => {
        if (generation.current !== current) return;
        setTurningOff(false);
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : "Couldn't turn off Cursor rules.",
        );
      });
  };

  const enabled = state.kind === 'ready' && state.status.enabled;
  return (
    <div
      className="rounded-lg border p-4"
      data-testid="project-settings-repo-rules"
    >
      <h3 className="text-s font-medium fg-primary">Cursor rules</h3>
      <p
        className="mt-1 text-xs fg-secondary"
        role="status"
        data-testid="project-settings-repo-rules-status"
      >
        {state.kind === 'loading'
          ? 'Checking the saved setting…'
          : state.kind === 'error'
            ? "Couldn't load the saved setting."
            : statusSentence(state.status)}
      </p>
      {error ? <ErrorBanner className="mt-3" error={error} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={onReview}
          data-testid="project-settings-repo-rules-review"
        >
          Review rules
        </Button>
        {enabled ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={turningOff}
            onClick={turnOff}
            data-testid="project-settings-repo-rules-turn-off"
          >
            Turn off
          </Button>
        ) : null}
      </div>
    </div>
  );
}
