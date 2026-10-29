import type {
  SharedAutomationAction,
  SharedAutomationInstallSource,
  SharedAutomationModelConfig,
  SharedAutomationTrigger,
} from '@canopy/protocol/automations';
import {
  projectKindToTargetContext,
  validateSharedAutomationDocument,
} from '@canopy/protocol/automations';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
} from '@canopy/pipeline-interop/automation-target';
import {
  automationTargetBindingChanged,
  type AutomationSessionTargetKind,
} from './automation-target';
import {
  buildSharedPipelineId,
  type PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import { CANOPY_CLOUD_SERVER_ID } from '../constants/canopy-cloud';
import type {
  AgentModelConfig,
  AutomationAction,
  AutomationCreateRequest,
  AutomationTrigger,
  AutomationUpdateRequest,
  ChatTabPluginSelections,
  ScheduledActivity,
} from '../types';

/**
 * Pure rebind mappers for the CAN-1581 shared-Automation install wizard.
 *
 * The portable document deliberately strips every machine binding, so an
 * install is a rebind: the recipient supplies a target workspace (for
 * worktree-scoped actions), input values for the documented `inputKeys`, and
 * locally resolved plugin selections. The mappers turn the document plus
 * those bindings into the automations-service request shapes:
 *
 *  - installs are ALWAYS created disabled with `installedFrom` provenance;
 *    the install review turns the copy on only after everything it needs
 *    (bundled pipeline, capability package) is in place;
 *  - applying a remote update preserves the recipient's bindings, keeps the
 *    enabled state only when the trigger is unchanged, and refreshes the
 *    recorded source contentHash while retaining the analytics dedupe stamps.
 *
 * Pure and timestamp-injected so the wizard, tests, and any future headless
 * caller share identical behavior.
 */

export interface InstallSharedAutomationBindings {
  /** Advisory facts; main independently resolves the selected IDs. */
  targetKind?: AutomationSessionTargetKind;
  pipelineResolution?: AutomationPipelineResolution;
  /** Target workspace id for worktree-scoped actions. */
  workspaceId?: string;
  /** Stable repository IDs available under the selected workspace. */
  repoIds?: string[];
  /** Target Cowork workspace id for portable standalone prompts. */
  coworkWorkspaceId?: string;
  /** Recipient-selected local pipeline for curated or unresolved refs. */
  pipelineId?: string;
  pipelineSource?: 'user' | 'project' | 'curated' | 'shared';
  projectPipelineFilename?: string;
  /** Pin returned by the shared-pipeline verification service. */
  verifiedSharedPipelineInstallPin?: PipelineShareInstallPin;
  /** Local pipeline created from an inline pipeline definition. */
  bundledPipelineLocalId?: string;
  /**
   * Recipient-confirmed branch for `worktree_prompt` actions. The document's
   * `existingBranch` is only a suggestion — the wizard prefills it, and only
   * the value the recipient confirms (or clears) is persisted.
   */
  existingBranch?: string;
  /** Values for the document's `inputKeys` (worktree_pipeline only). */
  inputs?: Record<string, string>;
  /** Locally resolved plugin selections (prompt actions only). */
  pluginSelections?: ChatTabPluginSelections;
  /**
   * The run-condition command the recipient saw and left on, possibly edited.
   * Undefined means declined or absent. This is the only source of a stored
   * `ifCommand`: the builders never read the document's `runCondition`, so a
   * caller that omits it installs or updates with no gate change.
   */
  approvedRunCondition?: string;
}

export type BuildInstallAutomationRequestResult =
  | { ok: true; request: AutomationCreateRequest }
  | { ok: false; error: string };

export type BuildApplyUpdateRequestResult =
  | { ok: true; request: AutomationUpdateRequest; keptEnabled: boolean }
  | { ok: false; error: string };

function approvedIfCommand(
  bindings: InstallSharedAutomationBindings,
): { ifCommand: string } | Record<string, never> {
  const command = bindings.approvedRunCondition?.trim();
  return command ? { ifCommand: command } : {};
}

/**
 * The installed copy's gate when it is still the shared command the recipient
 * approved, or null when there is no gate or the recipient has since changed
 * it locally. Only a share-approved gate follows the author's later revisions.
 */
export function shareApprovedRunCondition(
  existing: Pick<ScheduledActivity, 'ifCommand' | 'installedFrom'>,
): string | null {
  const gate = existing.ifCommand?.trim() ?? '';
  const approved = existing.installedFrom?.approvedRunCondition?.trim() ?? '';
  return gate !== '' && gate === approved ? gate : null;
}

function mapTrigger(trigger: SharedAutomationTrigger): AutomationTrigger {
  return trigger.kind === 'cron'
    ? { kind: 'cron', expression: trigger.expression, timezone: 'local' }
    : { kind: 'one_time', runAt: trigger.runAt, timezone: 'local' };
}

/**
 * Split the portable model config back into the local action fields: `model`
 * lives beside the action, while thinking level and fast mode form the local
 * {@link AgentModelConfig}.
 */
function splitModelConfig(config: SharedAutomationModelConfig | undefined): {
  model?: string;
  modelConfig?: AgentModelConfig;
} {
  if (!config) return {};
  const modelConfig: AgentModelConfig = {
    ...(config.thinkingLevel !== undefined
      ? { thinkingLevel: config.thinkingLevel }
      : {}),
    // The validated document already pairs `speed` with its derived boolean.
    ...(config.speed !== undefined
      ? { speed: config.speed, fastMode: config.speed === 'fast' }
      : config.fastMode !== undefined
        ? { fastMode: config.fastMode }
        : {}),
  };
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(Object.keys(modelConfig).length > 0 ? { modelConfig } : {}),
  };
}

function validateInputs(
  inputs: Record<string, string> | undefined,
  inputKeys: readonly string[],
): string | null {
  if (!inputs) return null;
  for (const key of Object.keys(inputs)) {
    if (!inputKeys.includes(key)) {
      return `Input "${key}" is not part of this shared automation.`;
    }
  }
  return null;
}

function installPinsEqual(
  expected: PipelineShareInstallPin | undefined,
  verified: PipelineShareInstallPin | undefined,
): boolean {
  return (
    expected !== undefined &&
    verified !== undefined &&
    expected.pipelineContentHash === verified.pipelineContentHash &&
    expected.distributionMode === verified.distributionMode &&
    expected.packageDigest === verified.packageDigest
  );
}

function pipelineVerificationError(name: string | undefined): string {
  return `The pinned version of "${name ?? 'this pipeline'}" could not be verified. Refresh and try again.`;
}

function mapAction(
  action: SharedAutomationAction,
  bindings: InstallSharedAutomationBindings,
): { ok: true; action: AutomationAction } | { ok: false; error: string } {
  if (
    'promptReferences' in action &&
    action.promptReferences?.some(
      (ref) =>
        ref.kind === 'file' &&
        ref.root.kind === 'repo' &&
        !bindings.repoIds?.includes(ref.root.repoId),
    )
  ) {
    return {
      ok: false,
      error:
        'A referenced repository is unavailable in the selected project. Choose a project with the same repository IDs.',
    };
  }
  if (action.type === 'app_advisor_prompt') {
    return {
      ok: true,
      action: {
        type: 'app_advisor_prompt',
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...splitModelConfig(action.modelConfig),
        ...(bindings.pluginSelections
          ? { pluginSelections: bindings.pluginSelections }
          : {}),
      },
    };
  }

  if (action.type === 'standalone_prompt') {
    if (!bindings.coworkWorkspaceId) {
      return {
        ok: false,
        error: 'Choose a Cowork project for this automation before installing.',
      };
    }
    return {
      ok: true,
      action: {
        type: 'standalone_prompt',
        chatProjectId: bindings.coworkWorkspaceId,
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...splitModelConfig(action.modelConfig),
        ...(bindings.pluginSelections
          ? { pluginSelections: bindings.pluginSelections }
          : {}),
      },
    };
  }

  if (!bindings.workspaceId) {
    return {
      ok: false,
      error: 'Choose a project for this automation before installing.',
    };
  }

  if (action.type === 'worktree_prompt') {
    return {
      ok: true,
      action: {
        type: 'worktree_prompt',
        workspaceId: bindings.workspaceId,
        ...(bindings.existingBranch !== undefined
          ? { existingBranch: bindings.existingBranch }
          : {}),
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...splitModelConfig(action.modelConfig),
        ...(action.planMode !== undefined ? { planMode: action.planMode } : {}),
        ...(action.interfaceMode !== undefined
          ? { interfaceMode: action.interfaceMode }
          : {}),
        ...(bindings.pluginSelections
          ? { pluginSelections: bindings.pluginSelections }
          : {}),
      },
    };
  }

  const inputsError = validateInputs(bindings.inputs, action.inputKeys);
  if (inputsError) {
    return { ok: false, error: inputsError };
  }
  const inputs =
    bindings.inputs && Object.keys(bindings.inputs).length > 0
      ? bindings.inputs
      : undefined;

  if (action.pipeline.source === 'bundled') {
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        workspaceId: bindings.workspaceId,
        pipelineId: action.pipeline.pipelineId,
        pipelineSource: 'bundled',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (action.pipeline.source === 'inline') {
    if (!bindings.bundledPipelineLocalId) {
      return {
        ok: false,
        error:
          'Install the bundled pipeline definition before installing this automation.',
      };
    }
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        workspaceId: bindings.workspaceId,
        pipelineId: bindings.bundledPipelineLocalId,
        pipelineSource: 'user',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (action.pipeline.source === 'shared') {
    if (
      action.pipeline.installPin === undefined ||
      !installPinsEqual(
        action.pipeline.installPin,
        bindings.verifiedSharedPipelineInstallPin,
      )
    ) {
      return {
        ok: false,
        error: pipelineVerificationError(action.pipeline.name),
      };
    }
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        workspaceId: bindings.workspaceId,
        pipelineId: buildSharedPipelineId(
          CANOPY_CLOUD_SERVER_ID,
          action.pipeline.remoteId,
        ),
        pipelineSource: 'shared',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        sharedPipeline: {
          serverId: CANOPY_CLOUD_SERVER_ID,
          remoteId: action.pipeline.remoteId,
          installPin: action.pipeline.installPin,
        },
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (!bindings.pipelineId) {
    const subject = action.pipeline.name ?? action.pipeline.source;
    return {
      ok: false,
      error:
        action.pipeline.source === 'curated'
          ? `Import or choose the "${subject}" pipeline before installing.`
          : 'Choose a pipeline for this automation before installing.',
    };
  }

  const pipelineSource =
    action.pipeline.source === 'curated' ? 'curated' : bindings.pipelineSource;
  if (
    pipelineSource !== 'user' &&
    pipelineSource !== 'project' &&
    pipelineSource !== 'curated'
  ) {
    return {
      ok: false,
      error: 'Choose a pipeline for this automation before installing.',
    };
  }
  return {
    ok: true,
    action: {
      type: 'worktree_pipeline',
      workspaceId: bindings.workspaceId,
      pipelineId: bindings.pipelineId,
      pipelineSource,
      ...(pipelineSource === 'project' && bindings.projectPipelineFilename
        ? { projectPipelineFilename: bindings.projectPipelineFilename }
        : {}),
      ...(action.pipeline.name !== undefined
        ? { pipelineName: action.pipeline.name }
        : {}),
      ...(inputs ? { inputs } : {}),
    },
  };
}

/**
 * Build the disabled create request for installing a shared Automation.
 * `installedAt` is injected so callers control the provenance timestamp.
 */
export function buildInstallAutomationRequest(
  detail: SharedAutomationInstallSource,
  bindings: InstallSharedAutomationBindings,
  installedAt: string,
  origin?: { sourceKind: 'public' | 'curated' },
): BuildInstallAutomationRequestResult {
  const mapped = mapAction(detail.automation.action, bindings);
  if (!mapped.ok) return mapped;
  const compatibilityError = validateInstallCompatibility(detail, bindings);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  const approved = approvedIfCommand(bindings).ifCommand;
  return {
    ok: true,
    request: {
      name: detail.automation.name,
      schedule: mapTrigger(detail.automation.trigger),
      action: mapped.action,
      ...(detail.automation.targetRequirement
        ? { targetRequirement: detail.automation.targetRequirement }
        : {}),
      ...(approved !== undefined ? { ifCommand: approved } : {}),
      enabled: false,
      installedFrom: {
        remoteId: detail.id,
        contentHash: detail.contentHash,
        installedAt,
        ...(origin !== undefined ? { sourceKind: origin.sourceKind } : {}),
        ...(approved !== undefined ? { approvedRunCondition: approved } : {}),
        ...(detail.automation.action.type === 'worktree_pipeline' &&
        detail.automation.action.pipeline.source === 'inline' &&
        bindings.bundledPipelineLocalId !== undefined
          ? {
              bundledPipelineLocalId: bindings.bundledPipelineLocalId,
              bundledPipelineContentHash:
                detail.automation.action.pipeline.pipelineContentHash,
            }
          : {}),
        ...(detail.automation.capabilityPackage
          ? { capabilityPackage: detail.automation.capabilityPackage }
          : {}),
      },
    },
  };
}

function validateInstallCompatibility(
  detail: SharedAutomationInstallSource,
  bindings: InstallSharedAutomationBindings,
): string | null {
  const validated = validateSharedAutomationDocument(detail.automation);
  if (!validated.ok) return validated.error;
  const action = detail.automation.action;
  const requirement = detail.automation.targetRequirement;
  const resolved = resolveAutomationTargetRequirement(
    action.type,
    requirement,
    bindings.pipelineResolution,
  );
  if (resolved.status === 'error') return resolved.error;
  if (resolved.status !== 'resolved')
    return 'Verify the selected pipeline before installing this automation.';
  const context =
    action.type === 'app_advisor_prompt'
      ? 'app_advisor'
      : projectKindToTargetContext(bindings.targetKind);
  if (!context || !resolved.contexts.includes(context))
    return 'Choose a compatible target before installing this automation.';

  return null;
}

function triggersEqual(
  local: ScheduledActivity['schedule'],
  shared: SharedAutomationTrigger,
): boolean {
  if (local.kind === 'cron' && shared.kind === 'cron') {
    return local.expression === shared.expression;
  }
  if (local.kind === 'one_time' && shared.kind === 'one_time') {
    return local.runAt === shared.runAt;
  }
  return false;
}

/**
 * Re-apply the recipient's machine-local action customizations after mapping
 * an updated document. The portable document never carries `baseWorktreeId`
 * or `repoId` (they are machine bindings the wizard does not collect), so a
 * hand-edited value must survive an update whenever it stays type-compatible:
 * same action type and an unchanged workspace binding. An explicit rebind to
 * a different workspace clears them, as does an action-type change. For
 * Prompt actions may also keep `sidebarGroupName` only when their target stays
 * the same; it remains a recipient-local setting. For `worktree_prompt` the
 * preserved `baseWorktreeId` yields to a recipient-confirmed branch or
 * existing-worktree target (these choices are mutually exclusive).
 */
function preserveLocalCustomizations(
  mapped: AutomationAction,
  existing: AutomationAction,
): AutomationAction {
  if (
    mapped.type === 'worktree_prompt' &&
    existing.type === 'worktree_prompt' &&
    mapped.workspaceId === existing.workspaceId &&
    mapped.existingWorktreeId === existing.existingWorktreeId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
      ...(mapped.existingBranch === undefined &&
      mapped.baseBranch === undefined &&
      mapped.existingWorktreeId === undefined &&
      existing.baseWorktreeId !== undefined
        ? { baseWorktreeId: existing.baseWorktreeId }
        : {}),
    };
  }
  if (
    mapped.type === 'app_advisor_prompt' &&
    existing.type === 'app_advisor_prompt' &&
    mapped.workEntryId === existing.workEntryId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
    };
  }
  if (
    mapped.type === 'standalone_prompt' &&
    existing.type === 'standalone_prompt' &&
    mapped.chatProjectId === existing.chatProjectId &&
    mapped.workEntryId === existing.workEntryId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
    };
  }
  if (
    mapped.type === 'worktree_pipeline' &&
    existing.type === 'worktree_pipeline' &&
    mapped.workspaceId === existing.workspaceId
  ) {
    return {
      ...mapped,
      ...(existing.baseWorktreeId !== undefined
        ? { baseWorktreeId: existing.baseWorktreeId }
        : {}),
      ...(existing.repoId !== undefined ? { repoId: existing.repoId } : {}),
      ...(existing.modelAliasPreferences !== undefined
        ? { modelAliasPreferences: existing.modelAliasPreferences }
        : {}),
      ...(existing.pluginCollectionPreferences !== undefined
        ? { pluginCollectionPreferences: existing.pluginCollectionPreferences }
        : {}),
      ...(existing.modelConfig !== undefined
        ? { modelConfig: existing.modelConfig }
        : {}),
    };
  }
  return mapped;
}

/**
 * Build the update request that re-applies a remote change to an installed
 * copy. The caller prefills `bindings` from the existing activity (dropping
 * input values whose keys no longer exist in the new document); the enabled
 * state survives only when the trigger is unchanged, otherwise the copy
 * drops to disabled pending re-confirmation. Machine-local customizations
 * the document cannot express (`baseWorktreeId`, pipeline `repoId`) are
 * preserved from the existing action when type-compatible — see
 * {@link preserveLocalCustomizations}.
 */
export function buildApplyUpdateRequest(
  detail: SharedAutomationInstallSource,
  existing: ScheduledActivity,
  bindings: InstallSharedAutomationBindings,
  appliedAt: string,
  origin?: { sourceKind: 'public' | 'curated' },
): BuildApplyUpdateRequestResult {
  const effectiveBindings =
    detail.automation.action.type === 'worktree_pipeline' &&
    detail.automation.action.pipeline.source === 'inline' &&
    bindings.bundledPipelineLocalId === undefined &&
    existing.installedFrom?.bundledPipelineLocalId !== undefined
      ? {
          ...bindings,
          bundledPipelineLocalId: existing.installedFrom.bundledPipelineLocalId,
        }
      : bindings;
  const mapped = mapAction(detail.automation.action, effectiveBindings);
  if (!mapped.ok) {
    return mapped;
  }
  const compatibilityError = validateInstallCompatibility(detail, bindings);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  const appliedAction = preserveLocalCustomizations(
    mapped.action,
    existing.action,
  );
  // A newly approved command that differs from the current gate is a new
  // author command on this machine, so the copy lands disabled for review.
  // When the author removes the gate (`hasRunCondition: false`), a gate that
  // is still the one shared earlier is cleared to match. A gated revision that
  // keeps its command private, and a gate the recipient changed, both stay.
  const approved = approvedIfCommand(bindings).ifCommand;
  const currentGate = existing.ifCommand?.trim() ?? '';
  const sharedGate = shareApprovedRunCondition(existing);
  const clearsSharedGate =
    approved === undefined &&
    sharedGate !== null &&
    !detail.automation.hasRunCondition;
  const keptEnabled =
    triggersEqual(existing.schedule, detail.automation.trigger) &&
    !automationTargetBindingChanged(existing.action, appliedAction) &&
    (approved === undefined || approved === currentGate) &&
    existing.enabled;
  // Pipeline provenance describes only the currently installed inline ref.
  // Remove the previous pair before preserving the rest of the metadata so an
  // update to another action/ref shape cannot retain a stale local pipeline.
  const preservedInstalledFrom = { ...existing.installedFrom };
  delete preservedInstalledFrom.bundledPipelineLocalId;
  delete preservedInstalledFrom.bundledPipelineContentHash;
  delete preservedInstalledFrom.approvedRunCondition;
  const approvedRunCondition =
    approved ?? (clearsSharedGate ? undefined : (sharedGate ?? undefined));
  return {
    ok: true,
    keptEnabled,
    request: {
      id: existing.id,
      name: detail.automation.name,
      schedule: mapTrigger(detail.automation.trigger),
      action: appliedAction,
      targetRequirement: detail.automation.targetRequirement ?? null,
      // Omitted when declined, so the recipient's current local gate stays,
      // unless it is a shared gate the author has since dropped.
      ...(approved !== undefined
        ? { ifCommand: approved }
        : clearsSharedGate
          ? { ifCommand: '' }
          : {}),
      enabled: keptEnabled,
      installedFrom: {
        ...preservedInstalledFrom,
        remoteId: detail.id,
        contentHash: detail.contentHash,
        installedAt: existing.installedFrom?.installedAt ?? appliedAt,
        ...(origin !== undefined ? { sourceKind: origin.sourceKind } : {}),
        ...(approvedRunCondition !== undefined ? { approvedRunCondition } : {}),
        ...(detail.automation.action.type === 'worktree_pipeline' &&
        detail.automation.action.pipeline.source === 'inline' &&
        effectiveBindings.bundledPipelineLocalId !== undefined
          ? {
              bundledPipelineLocalId: effectiveBindings.bundledPipelineLocalId,
              bundledPipelineContentHash:
                detail.automation.action.pipeline.pipelineContentHash,
            }
          : {}),
        capabilityPackage: detail.automation.capabilityPackage,
      },
    },
  };
}
