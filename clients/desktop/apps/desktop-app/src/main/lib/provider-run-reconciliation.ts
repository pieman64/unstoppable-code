import { isRecord } from './type-guards';

interface ProviderRunScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Identity only: validity and ownership are held privately, never in payloads. */
export interface ProviderRunGeneration {
  readonly scope: ProviderRunScope;
}
export interface ProviderRunHandle {
  readonly generation: ProviderRunGeneration;
  readonly threadId: string;
  readonly turnId: string;
  readonly executionUserMessageId: string;
  readonly origin: 'dispatched' | 'provider_owned';
}
export interface ProviderRunDescriptor extends ProviderRunHandle {
  readonly provider: 'codex';
  readonly phase: 'running' | 'late';
  readonly item?: { readonly id: string; readonly type: string };
}
export type ProviderRunClassification =
  | { kind: 'ordinary'; reason: string; run?: ProviderRunDescriptor }
  | { kind: 'transcript_only'; reason: string; run: ProviderRunDescriptor }
  | { kind: 'reject'; reason: string };

interface RunState {
  settled: boolean;
  pinned: boolean;
  items: Map<string, string>;
}
interface GenerationState {
  valid: boolean;
  runs: Map<ProviderRunHandle, RunState>;
}
const generations = new WeakMap<ProviderRunGeneration, GenerationState>();
const provenance = new WeakMap<object, ProviderRunDescriptor>();
const descriptorRuns = new WeakMap<ProviderRunDescriptor, ProviderRunHandle>();
const MAX_SETTLED_RUNS = 64;
const MAX_SETTLED_ITEMS = 4096;

function pruneSettledRuns(generation: GenerationState): void {
  let count = 0;
  let items = 0;
  for (const value of Array.from(generation.runs.values())) {
    if (value.settled && !value.pinned) {
      count += 1;
      items += value.items.size;
    }
  }
  for (const [handle, value] of Array.from(generation.runs)) {
    if (count <= MAX_SETTLED_RUNS && items <= MAX_SETTLED_ITEMS) break;
    if (!value.settled || value.pinned) continue;
    generation.runs.delete(handle);
    count -= 1;
    items -= value.items.size;
  }
}

export function createProviderRunGeneration(
  scope: ProviderRunScope,
): ProviderRunGeneration {
  const generation: ProviderRunGeneration = Object.freeze({
    scope: Object.freeze({ ...scope }),
  });
  generations.set(generation, { valid: true, runs: new Map() });
  return generation;
}
export function retireProviderRunGeneration(
  generation: ProviderRunGeneration,
): void {
  const state = generations.get(generation);
  if (state) {
    state.valid = false;
    state.runs.clear();
  }
}
export function registerProviderRun(
  generation: ProviderRunGeneration,
  identity: Omit<ProviderRunHandle, 'generation'>,
): ProviderRunHandle {
  const run: ProviderRunHandle = Object.freeze({ ...identity, generation });
  const state = generations.get(generation);
  if (state?.valid)
    state.runs.set(run, { settled: false, pinned: false, items: new Map() });
  return run;
}
export function pinProviderRun(run: ProviderRunHandle): void {
  const state = generations.get(run.generation)?.runs.get(run);
  if (state) state.pinned = true;
}
export function unpinProviderRun(run: ProviderRunHandle): void {
  const generation = generations.get(run.generation);
  const state = generation?.runs.get(run);
  if (!generation || !state) return;
  state.pinned = false;
  pruneSettledRuns(generation);
}
export function observeProviderRunItem(
  run: ProviderRunHandle,
  itemId: string,
  itemType: string,
): void {
  const state = generations.get(run.generation)?.runs.get(run);
  if (state && !state.settled && itemId && itemType)
    state.items.set(itemId, itemType);
}
export function settleProviderRun(run: ProviderRunHandle): void {
  const generation = generations.get(run.generation);
  const state = generation?.runs.get(run);
  if (!generation || !state) return;
  state.settled = true;
  pruneSettledRuns(generation);
}
export function attachProviderRunEvent<T extends object>(
  data: T,
  run: ProviderRunHandle,
  phase: 'running' | 'late',
): T {
  const event = isRecord(data) && isRecord(data.event) ? data.event : undefined;
  const item = event && isRecord(event.item) ? event.item : undefined;
  const descriptor: ProviderRunDescriptor = Object.freeze({
    ...run,
    provider: 'codex',
    phase,
    ...(item && typeof item.id === 'string' && typeof item.type === 'string'
      ? { item: Object.freeze({ id: item.id, type: item.type }) }
      : {}),
  });
  descriptorRuns.set(descriptor, run);
  provenance.set(data, descriptor);
  return data;
}
export function copyProviderRunProvenance<T extends object>(
  source: unknown,
  target: T,
): T {
  const descriptor = getProviderRunDescriptor(source);
  if (descriptor) provenance.set(target, descriptor);
  return target;
}
export function getProviderRunDescriptor(
  data: unknown,
): ProviderRunDescriptor | undefined {
  return typeof data === 'object' && data !== null
    ? provenance.get(data)
    : undefined;
}
export function classifyProviderRunEvent(
  data: unknown,
  scope?: ProviderRunScope,
): ProviderRunClassification {
  const run = getProviderRunDescriptor(data);
  if (!run) return { kind: 'ordinary', reason: 'no_run_provenance' };
  // Running frames have already entered today's ordered ingestion path. A
  // later transport retirement cannot retroactively revoke their content or
  // terminal; only newly requested late reconciliation fails closed.
  const refuse = (reason: string): ProviderRunClassification =>
    run.phase === 'running'
      ? { kind: 'ordinary', reason }
      : { kind: 'reject', reason };
  const generation = generations.get(run.generation);
  if (!generation?.valid) return refuse('retired_generation');
  if (
    scope &&
    (scope.projectId !== run.generation.scope.projectId ||
      scope.worktreeId !== run.generation.scope.worktreeId ||
      scope.chatId !== run.generation.scope.chatId)
  ) {
    return refuse('run_scope_mismatch');
  }
  if (
    isRecord(data) &&
    typeof data.canopy_turn_user_message_id === 'string' &&
    data.canopy_turn_user_message_id !== run.executionUserMessageId
  ) {
    return refuse('run_stamp_mismatch');
  }
  const handle = descriptorRuns.get(run);
  const state = handle ? generation.runs.get(handle) : undefined;
  if (!state) return refuse('unknown_run');
  const event =
    isRecord(data) && data.type === 'codex' && isRecord(data.event)
      ? data.event
      : undefined;
  if (
    !event ||
    event.thread_id !== run.threadId ||
    event.turn_id !== run.turnId
  )
    return refuse('native_run_mismatch');
  if (run.phase === 'running')
    return { kind: 'ordinary', reason: 'running_run', run };
  if (isRecord(data) && data.canopy_turn_revival === true) {
    return refuse('late_revival_metadata');
  }
  if (
    !state.settled ||
    event.type !== 'item.completed' ||
    run.item?.type !== 'command_execution'
  )
    return refuse('unsupported_late_event');
  const item = isRecord(event.item) ? event.item : undefined;
  if (
    !item ||
    item.id !== run.item.id ||
    item.type !== run.item.type ||
    typeof item.aggregated_output !== 'string' ||
    state.items.get(run.item.id) !== run.item.type
  )
    return refuse('unowned_late_item');
  return { kind: 'transcript_only', reason: 'owned_late_command_result', run };
}
