import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  CardStateDraftSchema,
  STREAM_CARD_CAPS,
  type CardStateDraft,
} from '@canopy/protocol/canopy-core';

export { overlayStreamBackedDelegationCard } from './delegation-transcript';
export {
  STREAM_CARD_KEY_CLASSES,
  persistedDelegationSnapshot,
} from './delegation-card-snapshot';

export interface CardStateDraftOptions {
  /** Only an amended queued prompt; never an unconditional task copy. */
  readonly prompt?: string;
  /** Detail omission after settle must not change execution outputTruncated. */
  readonly settled?: boolean;
}

/** Reference-free stream display, independent of the legacy durable projection. */
export function cardStateDraftFromSnapshot(
  snapshot: AgentDelegationSnapshot,
  options?: CardStateDraftOptions,
): CardStateDraft {
  const control = snapshot.control;
  return fitCardStateDraft(
    {
      version: 2,
      status: snapshot.status === 'pending' ? 'pending' : 'running',
      outputTruncated: snapshot.outputTruncated,
      ...(options?.prompt === undefined ? {} : { prompt: options.prompt }),
      ...(snapshot.routeSnapshot === undefined
        ? {}
        : {
            routeSnapshot: {
              ...snapshot.routeSnapshot,
              capabilities: [...snapshot.routeSnapshot.capabilities],
              supportedThinkingLevels: [
                ...snapshot.routeSnapshot.supportedThinkingLevels,
              ],
            },
          }),
      ...(snapshot.requestedModelId === undefined
        ? {}
        : { requestedModelId: snapshot.requestedModelId }),
      ...(snapshot.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: snapshot.nativeSessionId }),
      ...(snapshot.nestedDelegation === undefined
        ? {}
        : { nestedDelegation: snapshot.nestedDelegation }),
      ...(snapshot.childDelegationIds === undefined
        ? {}
        : { childDelegationIds: [...snapshot.childDelegationIds] }),
      ...(snapshot.capabilities === undefined
        ? {}
        : {
            capabilities: {
              ...snapshot.capabilities,
              items: [...snapshot.capabilities.items],
              skipped: [...snapshot.capabilities.skipped],
            },
          }),
      ...(snapshot.isolatedWorkspace === undefined
        ? {}
        : { isolatedWorkspace: { ...snapshot.isolatedWorkspace } }),
      ...(snapshot.workspaceDiscarded === undefined
        ? {}
        : { workspaceDiscarded: snapshot.workspaceDiscarded }),
      ...(control === undefined || control.status === 'accepted'
        ? {}
        : {
            control: {
              ...control,
              status: control.status,
              applyFailure:
                control.applyFailure === undefined
                  ? undefined
                  : {
                      ...control.applyFailure,
                      issues: [...control.applyFailure.issues],
                    },
            },
          }),
      ...(snapshot.cancelledByUser === undefined
        ? {}
        : { cancelledByUser: snapshot.cancelledByUser }),
      ...(snapshot.stoppedBy === undefined
        ? {}
        : { stoppedBy: { ...snapshot.stoppedBy } }),
    },
    options,
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Longest UTF-16 prefix fitting a JSON value budget (including quotes). */
function fitString(value: string, cap: number): string {
  if (encodedBytes(value) <= cap) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedBytes(value.slice(0, middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function prefix<T>(values: readonly T[], count: number, cap: number): T[] {
  const retained = values.slice(0, count);
  while (encodedBytes(retained) > cap) retained.pop();
  return retained;
}

function addOmitted(previous: number | undefined, count: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (previous ?? 0) + count);
}

type ApplyFailure = NonNullable<
  NonNullable<CardStateDraft['control']>['applyFailure']
>;

function dropDiffs(failure: ApplyFailure): void {
  for (const issue of failure.issues) {
    if (issue.parentDiff !== undefined) {
      delete issue.parentDiff;
      issue.parentDiffTruncated = true;
    }
  }
}

function dropIssue(failure: ApplyFailure): void {
  failure.issues.pop();
  failure.omittedIssues = addOmitted(failure.omittedIssues, 1);
}

function fitApply(failure: ApplyFailure): void {
  failure.guidance = fitString(failure.guidance, STREAM_CARD_CAPS.message);
  const originalCount = failure.issues.length;
  const firstInvalid = failure.issues.findIndex(
    (issue) => encodedBytes(issue.path) > STREAM_CARD_CAPS.id,
  );
  failure.issues = failure.issues.slice(
    0,
    Math.min(64, firstInvalid < 0 ? originalCount : firstInvalid),
  );
  if (failure.issues.length < originalCount)
    failure.omittedIssues = addOmitted(
      failure.omittedIssues,
      originalCount - failure.issues.length,
    );
  for (const issue of failure.issues) {
    if (issue.parentDiff !== undefined) {
      const fitted = fitString(issue.parentDiff, STREAM_CARD_CAPS.message);
      if (fitted !== issue.parentDiff) issue.parentDiffTruncated = true;
      issue.parentDiff = fitted;
    }
  }
  if (encodedBytes(failure) > STREAM_CARD_CAPS.applyFailure) dropDiffs(failure);
  while (
    encodedBytes(failure) > STREAM_CARD_CAPS.applyFailure &&
    failure.issues.length > 0
  )
    dropIssue(failure);
}

function fitRoute(route: NonNullable<CardStateDraft['routeSnapshot']>): void {
  const strings = [
    'selectedModelId',
    'selectedModelLabel',
    'runtimeModelLabel',
    'runtimeModelId',
    'harnessId',
    'runtimeKind',
    'runnerRegistrationId',
    'runtimeVersion',
    'adapterVersion',
    'modelSource',
    'providerType',
    'assignmentRevision',
    'routeId',
    'billingAuthority',
    'capabilitySnapshotHash',
    'policyRevision',
  ] as const;
  for (const key of strings) {
    const value = route[key];
    if (value !== undefined) route[key] = fitString(value, STREAM_CARD_CAPS.id);
  }
  if (route.agentOverlay !== undefined) {
    for (const key of [
      'agentDefinitionId',
      'agentDefinitionRevision',
      'agentDefinitionHash',
      'pluginProjectionHash',
    ] as const)
      route.agentOverlay[key] = fitString(
        route.agentOverlay[key],
        STREAM_CARD_CAPS.id,
      );
  }
  route.capabilities = route.capabilities
    .slice(0, 64)
    .map((name) => fitString(name, STREAM_CARD_CAPS.label));
  route.supportedThinkingLevels = route.supportedThinkingLevels.slice(0, 16);
  while (
    encodedBytes(route) > STREAM_CARD_CAPS.route &&
    route.capabilities.length > 0
  )
    route.capabilities.pop();
  if (encodedBytes(route) > STREAM_CARD_CAPS.route) {
    delete route.selectedModelLabel;
    delete route.runtimeModelLabel;
    delete route.agentOverlay;
    delete route.routeId;
  }
  // Required route strings can jointly exceed the subtree budget. Never drop
  // the route or any alias source; fit non-alias metadata in stable order.
  for (const key of [...strings].reverse()) {
    if (encodedBytes(route) <= STREAM_CARD_CAPS.route) break;
    if (
      key === 'selectedModelId' ||
      key === 'runtimeModelId' ||
      key === 'harnessId'
    )
      continue;
    const value = route[key];
    if (value !== undefined)
      route[key] = fitString(
        value,
        Math.max(
          2,
          encodedBytes(value) - (encodedBytes(route) - STREAM_CARD_CAPS.route),
        ),
      );
  }
}

function dropCapability(
  capabilities: NonNullable<CardStateDraft['capabilities']>,
  skipped: boolean,
): void {
  if (skipped) {
    capabilities.skipped.pop();
    capabilities.omittedSkipped = addOmitted(capabilities.omittedSkipped, 1);
  } else {
    capabilities.items.pop();
    capabilities.omittedItems = addOmitted(capabilities.omittedItems, 1);
  }
}

function draftBytes(draft: CardStateDraft): number {
  const { prompt: _prompt, ...bounded } = draft;
  void _prompt;
  return encodedBytes(bounded);
}

/** Stream-only fitting; never changes execution outcomes or accepted references. */
export function fitCardStateDraft(
  draft: CardStateDraft,
  options?: Pick<CardStateDraftOptions, 'settled'>,
): CardStateDraft {
  // Prompt is admission-bounded, never a display field to truncate silently.
  if (
    draft.prompt !== undefined &&
    draft.prompt.length > STREAM_CARD_CAPS.promptCodeUnits
  )
    throw new Error('The amended prompt exceeds the admission bound.');
  const fitted = structuredClone(draft);
  if (fitted.requestedModelId !== undefined)
    fitted.requestedModelId = fitString(
      fitted.requestedModelId,
      STREAM_CARD_CAPS.id,
    );
  if (
    fitted.nativeSessionId !== undefined &&
    encodedBytes(fitted.nativeSessionId) > STREAM_CARD_CAPS.id
  )
    delete fitted.nativeSessionId;
  if (
    fitted.isolatedWorkspace !== undefined &&
    encodedBytes(fitted.isolatedWorkspace.revision) > STREAM_CARD_CAPS.id
  )
    delete fitted.isolatedWorkspace;
  if (fitted.routeSnapshot !== undefined) fitRoute(fitted.routeSnapshot);
  if (fitted.childDelegationIds !== undefined) {
    const invalid = fitted.childDelegationIds.findIndex(
      (id) => encodedBytes(id) > STREAM_CARD_CAPS.id,
    );
    fitted.childDelegationIds = prefix(
      fitted.childDelegationIds,
      Math.min(64, invalid < 0 ? fitted.childDelegationIds.length : invalid),
      STREAM_CARD_CAPS.childDelegationIds,
    );
  }
  const capabilities = fitted.capabilities;
  if (capabilities !== undefined) {
    const items = capabilities.items.length;
    const skipped = capabilities.skipped.length;
    const retainedItems = capabilities.items.slice(0, 128);
    capabilities.items = retainedItems.map((item) => ({
      ...item,
      name: fitString(item.name, STREAM_CARD_CAPS.label),
    }));
    const retainedSkipped = capabilities.skipped.slice(0, 64);
    capabilities.skipped = retainedSkipped.map((item) => ({
      ...item,
      name: fitString(item.name, STREAM_CARD_CAPS.label),
    }));
    if (items > capabilities.items.length)
      capabilities.omittedItems = addOmitted(
        capabilities.omittedItems,
        items - capabilities.items.length,
      );
    if (skipped > capabilities.skipped.length)
      capabilities.omittedSkipped = addOmitted(
        capabilities.omittedSkipped,
        skipped - capabilities.skipped.length,
      );
    while (
      encodedBytes(capabilities) > STREAM_CARD_CAPS.capabilities &&
      capabilities.skipped.length > 0
    )
      dropCapability(capabilities, true);
    while (
      encodedBytes(capabilities) > STREAM_CARD_CAPS.capabilities &&
      capabilities.items.length > 0
    )
      dropCapability(capabilities, false);
  }
  const control = fitted.control;
  if (control !== undefined) {
    if (encodedBytes(control.operationId) > STREAM_CARD_CAPS.id)
      delete fitted.control;
    else {
      if (control.error !== undefined)
        control.error = fitString(control.error, STREAM_CARD_CAPS.message);
      if (control.steeringDelivery !== undefined) {
        if (
          encodedBytes(control.steeringDelivery.attemptId) > STREAM_CARD_CAPS.id
        )
          delete control.steeringDelivery;
        else if (control.steeringDelivery.kind === 'accepted') {
          if (
            control.steeringDelivery.providerTurnId !== undefined &&
            encodedBytes(control.steeringDelivery.providerTurnId) >
              STREAM_CARD_CAPS.id
          )
            delete control.steeringDelivery.providerTurnId;
        } else
          control.steeringDelivery.reason = fitString(
            control.steeringDelivery.reason,
            STREAM_CARD_CAPS.message,
          );
      }
      if (control.applyFailure !== undefined) fitApply(control.applyFailure);
      if (
        encodedBytes(control) > STREAM_CARD_CAPS.control &&
        control.applyFailure !== undefined
      )
        dropDiffs(control.applyFailure);
      while (
        encodedBytes(control) > STREAM_CARD_CAPS.control &&
        control.applyFailure !== undefined &&
        control.applyFailure.issues.length > 0
      )
        dropIssue(control.applyFailure);
      if (encodedBytes(control) > STREAM_CARD_CAPS.control) {
        delete control.error;
        delete control.steeringDelivery;
      }
    }
  }
  const stoppedBy = fitted.stoppedBy;
  if (stoppedBy?.kind === 'agent') {
    if (
      stoppedBy.delegationId !== undefined &&
      encodedBytes(stoppedBy.delegationId) > STREAM_CARD_CAPS.id
    )
      delete stoppedBy.delegationId;
    if (stoppedBy.description !== undefined)
      stoppedBy.description = fitString(
        stoppedBy.description,
        STREAM_CARD_CAPS.label,
      );
    if (encodedBytes(stoppedBy) > STREAM_CARD_CAPS.stoppedBy)
      delete stoppedBy.description;
  }
  // Reserve the omission flag before enforcing the enclosing draft budget.
  if (options?.settled) fitted.detailOmitted = true;
  else fitted.outputTruncated = true;
  if (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    fitted.control?.applyFailure !== undefined
  )
    dropDiffs(fitted.control.applyFailure);
  while (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    fitted.control?.applyFailure !== undefined &&
    fitted.control.applyFailure.issues.length > 0
  )
    dropIssue(fitted.control.applyFailure);
  while (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    capabilities !== undefined &&
    capabilities.skipped.length > 0
  )
    dropCapability(capabilities, true);
  while (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    capabilities !== undefined &&
    capabilities.items.length > 0
  )
    dropCapability(capabilities, false);
  while (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    fitted.childDelegationIds !== undefined &&
    fitted.childDelegationIds.length > 0
  )
    fitted.childDelegationIds.pop();
  if (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    fitted.routeSnapshot !== undefined
  ) {
    delete fitted.routeSnapshot.selectedModelLabel;
    delete fitted.routeSnapshot.runtimeModelLabel;
    delete fitted.routeSnapshot.agentOverlay;
    delete fitted.routeSnapshot.routeId;
    fitted.routeSnapshot.capabilities = [];
  }
  if (
    draftBytes(fitted) > STREAM_CARD_CAPS.draft &&
    fitted.control !== undefined
  ) {
    delete fitted.control.error;
    delete fitted.control.steeringDelivery;
  }
  // Amendment 3 forbids omitting routeSnapshot, requestedModelId or prompt.
  if (draftBytes(fitted) > STREAM_CARD_CAPS.draft) delete fitted.control;
  if (draftBytes(fitted) > STREAM_CARD_CAPS.draft) delete fitted.capabilities;
  // An unchanged fit must not invent an omission flag.
  if (options?.settled) {
    if (draft.detailOmitted === undefined) delete fitted.detailOmitted;
    else fitted.detailOmitted = draft.detailOmitted;
  } else fitted.outputTruncated = draft.outputTruncated;
  const omitted = JSON.stringify(fitted) !== JSON.stringify(draft);
  if (omitted) {
    if (options?.settled) fitted.detailOmitted = true;
    else fitted.outputTruncated = true;
  }
  return CardStateDraftSchema.parse(fitted);
}
