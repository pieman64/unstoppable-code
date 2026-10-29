import { useEffect, useState, type JSX } from 'react';
import { CHAT_LABEL } from '@canopy/protocol';
import type {
  SharedAutomationTargetRequirement,
  TargetContext,
} from '@canopy/protocol/automations';
import type { AutomationAction } from '@canopy/desktop-shared/types';
import { resolveLocalAutomationTargetRequirement } from '@canopy/desktop-shared/lib/automation-target';
import type { AutomationPipelineResolution } from '@canopy/pipeline-interop/automation-target';
import { Button, Notice } from '@canopy/ui-shared';
import { AutomationTargetContextsLine } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import { ShareCheckbox } from '@canopy/ui-app/sharing';
import {
  resolveAutomationPipelineScopes,
  resolveSessionTargetKind,
} from '@/lib/automationTargets';

export function AutomationAuthorTargetRequirement({
  action,
  requirement,
  installed,
  onChange,
}: {
  action?: AutomationAction;
  requirement?: SharedAutomationTargetRequirement;
  installed: boolean;
  onChange: (contexts: TargetContext[] | undefined) => void;
}): JSX.Element | null {
  const key = JSON.stringify(action);
  const [facts, setFacts] = useState<{
    key: string;
    kind?: unknown;
    pipeline?: AutomationPipelineResolution;
  }>();
  useEffect(() => {
    if (!action) return;
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      const kind =
        action.type === 'worktree_session_prompt'
          ? await resolveSessionTargetKind(action)
          : undefined;
      const pipeline =
        action.type === 'worktree_pipeline'
          ? await resolveAutomationPipelineScopes(action)
          : undefined;
      if (!cancelled) setFacts({ key, kind, pipeline });
    };
    void resolve();
    return (): void => {
      cancelled = true;
    };
    // The complete serialized action invalidates host facts without rereading on each form render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!action || action.type === 'pipeline_execution_resume') return null;
  const current = facts?.key === key ? facts : undefined;
  if (action.type === 'worktree_session_prompt' && !current)
    return (
      <p className="text-s fg-secondary">Checking where this chat runs…</p>
    );
  const resolved = resolveLocalAutomationTargetRequirement(
    action,
    current?.kind,
    requirement,
    current?.pipeline,
  );
  const supported = resolveLocalAutomationTargetRequirement(
    action,
    current?.kind,
    undefined,
    current?.pipeline,
  );
  return (
    <div
      className="space-y-2"
      data-testid="automations-form-target-requirement"
    >
      {resolved.status === 'error' ? (
        <Notice intent="attention">{resolved.error}</Notice>
      ) : (
        <AutomationTargetContextsLine
          contexts={resolved.contexts}
          verified={resolved.status === 'resolved'}
        />
      )}
      {!installed &&
        requirement &&
        supported.status === 'resolved' &&
        resolved.status === 'error' && (
          <Button
            variant="secondary"
            data-testid="automations-form-target-reset"
            onClick={(): void => onChange(undefined)}
          >
            Use this action’s targets
          </Button>
        )}
      {action.type === 'worktree_pipeline' &&
        !installed &&
        supported.status === 'resolved' &&
        supported.contexts.length > 1 && (
          <fieldset className="space-y-1 text-s">
            <legend className="fg-secondary">Allow runs in</legend>
            {supported.contexts.map((context) => {
              const selected = requirement?.contexts ?? supported.contexts;
              return (
                <ShareCheckbox
                  key={context}
                  checked={selected.includes(context)}
                  disabled={selected.includes(context) && selected.length === 1}
                  inputTestId={`automations-form-target-${context}`}
                  onChange={(checked): void =>
                    onChange(
                      supported.contexts.filter((candidate) =>
                        candidate === context
                          ? checked
                          : selected.includes(candidate),
                      ),
                    )
                  }
                >
                  {context === 'cowork'
                    ? `${CHAT_LABEL} projects`
                    : 'Code projects'}
                </ShareCheckbox>
              );
            })}
          </fieldset>
        )}
    </div>
  );
}
