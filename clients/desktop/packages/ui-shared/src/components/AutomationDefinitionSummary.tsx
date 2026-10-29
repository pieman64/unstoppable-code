import type { JSX } from 'react';
import {
  impliedTargetContexts,
  intersectTargetContexts,
  type SharedAutomationAction,
  type SharedAutomationDocument,
  type TargetContext,
} from '@canopy/protocol/automations';
import type { ShareablePluginRef } from '@canopy/protocol';
import type { PipelineDistributionMode } from '@canopy/protocol/pipelines';
import { CHAT_LABEL } from '@canopy/protocol';
import {
  AUTOMATION_PACKAGE_BUNDLED_NOTE,
  AUTOMATION_PACKAGE_DEPENDENCIES_EXCLUDED_NOTE,
  AUTOMATION_PACKAGE_DEPENDENCIES_INCLUDED_NOTE,
  AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE,
} from '../lib/pipeline-package-display';

export interface AutomationDefinitionSummaryProps {
  automation: SharedAutomationDocument;
  /**
   * Distribution mode of the surrounding share, when the host knows it.
   * Optional so the desktop preview (which renders a document with no share
   * behind it) stays unchanged. Deliberately NOT derived from
   * `automation.capabilityPackage`: only the share record knows whether the
   * package actually travelled.
   */
  distributionMode?: PipelineDistributionMode;
  /**
   * Effective target contexts when the host has resolved the pipeline's
   * scopes. Omitted for pipelines means compatibility is still unverified,
   * so only the declared/action constraint is shown.
   */
  resolvedTargetContexts?: readonly TargetContext[];
}

const TARGET_CONTEXT_LABELS: Record<TargetContext, string> = {
  cowork: `a ${CHAT_LABEL} project`,
  worktree: 'a code project',
  app_advisor: 'App Advisor',
};

/** Shared "Runs in" wording for automation target contexts (CAN-3734). */
export function formatAutomationTargetContexts(
  contexts: readonly TargetContext[],
): string {
  return contexts.map((context) => TARGET_CONTEXT_LABELS[context]).join(' or ');
}

export const AUTOMATION_TARGET_UNVERIFIED_NOTE =
  'The pipeline’s own requirements are checked when you install, and may narrow these choices.';
export const AUTOMATION_TARGET_NONE_LABEL =
  'This automation has no compatible place to run.';

export interface AutomationTargetRequirementDisplay {
  contexts: TargetContext[];
  /** False while a pipeline's scopes have not been verified by the host. */
  verified: boolean;
}

/**
 * The contexts an automation document may run in: the declaration and the
 * action-implied set, narrowed by host-resolved pipeline contexts when known.
 * An unresolved pipeline is never labeled as an effective set.
 */
export function describeAutomationTargetRequirement(
  automation: SharedAutomationDocument,
  resolvedTargetContexts?: readonly TargetContext[],
): AutomationTargetRequirementDisplay {
  const implied = impliedTargetContexts(automation.action.type);
  const declared = intersectTargetContexts(
    implied,
    automation.targetRequirement?.contexts ?? implied,
  );
  if (automation.action.type !== 'worktree_pipeline') {
    return { contexts: declared, verified: true };
  }
  return resolvedTargetContexts === undefined
    ? { contexts: declared, verified: false }
    : {
        contexts: intersectTargetContexts(declared, resolvedTargetContexts),
        verified: true,
      };
}

/** One "Runs in" line plus the unverified-pipeline note when applicable. */
export function AutomationTargetRequirementLine({
  automation,
  resolvedTargetContexts,
}: {
  automation: SharedAutomationDocument;
  resolvedTargetContexts?: readonly TargetContext[];
}): JSX.Element {
  const display = describeAutomationTargetRequirement(
    automation,
    resolvedTargetContexts,
  );
  return (
    <AutomationTargetContextsLine
      contexts={display.contexts}
      verified={display.verified}
    />
  );
}

export function AutomationTargetContextsLine({
  contexts,
  verified,
}: {
  contexts: readonly TargetContext[];
  verified: boolean;
}): JSX.Element {
  return (
    <div data-testid="automation-summary-runs-in">
      <p className="text-xs fg-secondary">
        {contexts.length === 0
          ? AUTOMATION_TARGET_NONE_LABEL
          : `Runs in ${formatAutomationTargetContexts(contexts)}`}
      </p>
      {!verified && (
        <p
          className="mt-1 text-xs fg-secondary"
          data-testid="automation-summary-runs-in-unverified"
        >
          {AUTOMATION_TARGET_UNVERIFIED_NOTE}
        </p>
      )}
    </div>
  );
}

function pluginLabel(ref: ShareablePluginRef): string {
  return ref.type === 'skill' ? ref.skill_name : ref.plugin_name;
}

function actionLabel(action: SharedAutomationAction): string {
  switch (action.type) {
    case 'app_advisor_prompt':
      return 'Sends a prompt to App Advisor';
    case 'standalone_prompt':
      return `Sends a prompt in a ${CHAT_LABEL} project the installer picks`;
    case 'worktree_prompt':
      return 'Sends a prompt in a project the installer picks';
    case 'worktree_pipeline':
      // An unresolved ref carries the author's pipeline name only as a hint —
      // the installer binds one of their own pipelines, so never render it as
      // though the named pipeline travels.
      if (action.pipeline.source === 'unresolved') {
        return action.pipeline.name
          ? `Runs a pipeline you choose (the author used "${action.pipeline.name}")`
          : 'Runs a pipeline you choose';
      }
      if (action.pipeline.name) {
        return `Runs the ${action.pipeline.name} pipeline`;
      }
      switch (action.pipeline.source) {
        case 'bundled':
          return 'Runs a pipeline';
        case 'curated':
          return 'Runs a curated pipeline';
        // An inline ref carries the definition itself, so an absent name must
        // never render as an empty pipeline name or as "a shared pipeline".
        case 'inline':
          return 'Runs the pipeline included in this share';
        default:
          return 'Runs a shared pipeline';
      }
  }
}

/**
 * Whether the pipeline an automation runs travels with the share. Bundled and
 * curated pipelines ship with every install, and an unresolved ref already
 * says the installer picks their own, so only inline and legacy shared refs
 * need the disclosure.
 */
function pipelineBundlingNote(action: SharedAutomationAction): string | null {
  if (action.type !== 'worktree_pipeline') return null;
  switch (action.pipeline.source) {
    case 'inline':
      return AUTOMATION_PACKAGE_BUNDLED_NOTE;
    case 'shared':
      return AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE;
    default:
      return null;
  }
}

/**
 * Pure, portable summary of a shared automation document for public web and
 * desktop preview surfaces. Renders only document fields: never owner ids,
 * workspace ids, input values, or run-condition commands.
 */
export function AutomationDefinitionSummary({
  automation,
  distributionMode,
  resolvedTargetContexts,
}: AutomationDefinitionSummaryProps): JSX.Element {
  // The trigger is deliberately not rendered: the installer picks their own
  // schedule at install time, so the author's cron expression is noise the
  // reader cannot act on.
  const { action } = automation;
  const plugins = action.type === 'worktree_pipeline' ? [] : action.plugins;
  const inputKeys = action.type === 'worktree_pipeline' ? action.inputKeys : [];
  const prompt = action.type === 'worktree_pipeline' ? null : action.prompt;
  const bundlingNote = pipelineBundlingNote(action);
  // Only real requirements open the block. A known distribution mode is not
  // one: on an automation that needs nothing, "dependencies are (not)
  // included in this share" describes an empty set, and on a definition-only
  // share it just restates the warning already sitting above the CTA.
  const hasNeeds =
    plugins.length > 0 || inputKeys.length > 0 || automation.hasRunCondition;

  return (
    <div className="space-y-6" data-testid="automation-definition-summary">
      <section data-testid="automation-summary-action">
        <h2 className="text-sm font-semibold">What it does</h2>
        <div className="mt-2 rounded-xl border bg-card p-4 text-sm">
          <p className="font-medium">{actionLabel(action)}</p>
          <div className="mt-1">
            <AutomationTargetRequirementLine
              automation={automation}
              {...(resolvedTargetContexts !== undefined
                ? { resolvedTargetContexts }
                : {})}
            />
          </div>
          {action.type === 'worktree_prompt' && action.planMode && (
            <p className="mt-1 text-xs fg-secondary">Starts in plan mode.</p>
          )}
          {bundlingNote !== null && (
            <p
              className="mt-1 text-xs fg-secondary"
              data-testid="automation-summary-pipeline-bundling"
            >
              {bundlingNote}
            </p>
          )}
          {prompt !== null && (
            <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm">
              {prompt || 'No prompt text.'}
            </pre>
          )}
        </div>
      </section>

      {hasNeeds && (
        <section data-testid="automation-summary-needs">
          <h2 className="text-sm font-semibold">What it needs</h2>
          <div className="mt-2 space-y-3 rounded-xl border bg-card p-4 text-sm">
            {plugins.length > 0 && (
              <div>
                <p className="text-xs font-medium fg-secondary">Plugins</p>
                <ul className="mt-1 space-y-1">
                  {plugins.map(
                    (ref): JSX.Element => (
                      <li key={JSON.stringify(ref)}>{pluginLabel(ref)}</li>
                    ),
                  )}
                </ul>
              </div>
            )}
            {inputKeys.length > 0 && (
              <div>
                <p className="text-xs font-medium fg-secondary">
                  Inputs you provide at install
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {inputKeys.map(
                    (key): JSX.Element => (
                      <span
                        key={key}
                        className="rounded-full border px-2 py-0.5 text-xs"
                      >
                        {key}
                      </span>
                    ),
                  )}
                </div>
              </div>
            )}
            {automation.hasRunCondition && (
              <p
                className="text-xs fg-secondary"
                data-testid="automation-summary-run-condition"
              >
                {automation.runCondition
                  ? 'The author gated this with a run condition you can review when installing.'
                  : 'The author gated this with a run condition; the command stays on their machine.'}
              </p>
            )}
            {distributionMode !== undefined && (
              <p
                className="text-xs fg-secondary"
                data-testid="automation-summary-distribution"
              >
                {distributionMode === 'package'
                  ? AUTOMATION_PACKAGE_DEPENDENCIES_INCLUDED_NOTE
                  : AUTOMATION_PACKAGE_DEPENDENCIES_EXCLUDED_NOTE}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
