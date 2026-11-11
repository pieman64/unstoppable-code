import {
  MODEL_ROUTING_MAX_CANDIDATES,
  type AutoModelRoutingCandidate,
  type ModelExecutionLane,
  type ModelRoutingHarness,
} from '@canopy/protocol/model-routing';

export interface DesktopCandidateModel {
  /** Local Canopy picker/dispatch id, e.g. `opus[1m]`. */
  id: string;
  /**
   * Identity the SERVER validates against: the exact `gatewayId` the package
   * config declares for this model, or the local id for a native-only model
   * that has none. The AI Gateway catalog the resolver checks is keyed by
   * catalog id and `gatewayId`; it never carries Canopy's local picker id, so
   * a request built from `id` alone is rejected as a stale snapshot.
   */
  wireModelId: string;
  label: string;
  description?: string;
  harness: ModelRoutingHarness;
  native: boolean;
  gateway: boolean;
  supportsThinking: boolean;
  blocked: boolean;
}

export interface DesktopRoutingCandidateSet {
  candidates: AutoModelRoutingCandidate[];
  /** Wire identity, matching `candidates[].modelId`. */
  fallbackModelId: string | null;
  /** Wire identity back to the local id the desktop actually dispatches. */
  localModelIdByWireId: ReadonlyMap<string, string>;
}

/**
 * Trim an over-long candidate list down to the wire contract's maximum.
 *
 * The desktop catalog routinely carries more eligible models than
 * `MODEL_ROUTING_MAX_CANDIDATES`, and the server rejects an oversized request
 * outright — so an uncapped set does not degrade gracefully, it fails the
 * whole decision. `pinned` entries (the deterministic fallback and each
 * harness's benchmark default) are kept first because the response and the
 * savings attribution are both resolved against this exact list; the rest fill
 * round-robin across harnesses so the cap can never erase one harness the user
 * is still allowed to reach.
 */
function capCandidates(
  candidates: readonly AutoModelRoutingCandidate[],
  pinned: readonly (string | undefined)[],
): AutoModelRoutingCandidate[] {
  if (candidates.length <= MODEL_ROUTING_MAX_CANDIDATES) {
    return [...candidates];
  }
  const byId = new Map(
    candidates.map((candidate) => [candidate.modelId, candidate]),
  );
  const kept = new Set<string>();
  for (const id of pinned) {
    const candidate = id === undefined ? undefined : byId.get(id);
    if (candidate && kept.size < MODEL_ROUTING_MAX_CANDIDATES) {
      kept.add(candidate.modelId);
    }
  }
  const queues = new Map<ModelRoutingHarness, AutoModelRoutingCandidate[]>();
  for (const candidate of candidates) {
    if (kept.has(candidate.modelId)) continue;
    const queue = queues.get(candidate.harness) ?? [];
    queue.push(candidate);
    queues.set(candidate.harness, queue);
  }
  const rounds: AutoModelRoutingCandidate[][] = Array.from(queues.values());
  let cursor = 0;
  let progressed = true;
  while (kept.size < MODEL_ROUTING_MAX_CANDIDATES && progressed) {
    progressed = false;
    for (const queue of rounds) {
      const next = queue[cursor];
      if (next === undefined) continue;
      progressed = true;
      kept.add(next.modelId);
      if (kept.size >= MODEL_ROUTING_MAX_CANDIDATES) break;
    }
    cursor += 1;
  }
  // Catalog order is preserved so the request body stays stable and readable.
  return candidates.filter((candidate) => kept.has(candidate.modelId));
}

export function buildDesktopRoutingCandidateSet(input: {
  models: readonly DesktopCandidateModel[];
  lane: ModelExecutionLane;
  capturedHarness?: ModelRoutingHarness;
  authenticatedHarnesses: ReadonlySet<ModelRoutingHarness>;
  defaultModelByHarness: Readonly<Partial<Record<ModelRoutingHarness, string>>>;
  currentModelId?: string;
}): DesktopRoutingCandidateSet {
  const eligible = input.models.filter(
    (model) =>
      !model.blocked &&
      model.supportsThinking &&
      Boolean(model.description?.trim()) &&
      (input.capturedHarness === undefined ||
        model.harness === input.capturedHarness) &&
      (input.lane === 'ai_credits'
        ? model.gateway
        : model.native && input.authenticatedHarnesses.has(model.harness)),
  );
  const wireByLocalId = new Map(
    input.models.map((model) => [model.id, model.wireModelId]),
  );
  const candidates = capCandidates(
    eligible.map(
      (model): AutoModelRoutingCandidate => ({
        modelId: model.wireModelId,
        label: model.label,
        description: model.description?.trim() ?? '',
        harness: model.harness,
        executionLane: input.lane,
        ...(input.defaultModelByHarness[model.harness] === model.id
          ? { isDefault: true }
          : {}),
      }),
    ),
    [
      input.currentModelId === undefined
        ? undefined
        : wireByLocalId.get(input.currentModelId),
      input.defaultModelByHarness.claude === undefined
        ? undefined
        : wireByLocalId.get(input.defaultModelByHarness.claude),
      input.defaultModelByHarness.codex === undefined
        ? undefined
        : wireByLocalId.get(input.defaultModelByHarness.codex),
      input.defaultModelByHarness.opencode === undefined
        ? undefined
        : wireByLocalId.get(input.defaultModelByHarness.opencode),
    ],
  );
  const ids = new Set(candidates.map((candidate) => candidate.modelId));
  const wireIfCandidate = (localId: string | undefined): string | undefined => {
    const wire = localId === undefined ? undefined : wireByLocalId.get(localId);
    return wire !== undefined && ids.has(wire) ? wire : undefined;
  };
  const fallbackModelId =
    wireIfCandidate(input.currentModelId) ??
    wireIfCandidate(
      input.capturedHarness
        ? input.defaultModelByHarness[input.capturedHarness]
        : undefined,
    ) ??
    candidates[0]?.modelId ??
    null;
  return {
    candidates,
    fallbackModelId,
    localModelIdByWireId: new Map(
      eligible
        .filter((model) => ids.has(model.wireModelId))
        .map((model) => [model.wireModelId, model.id]),
    ),
  };
}
