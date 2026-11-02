import { isDeepStrictEqual } from 'node:util';
import {
  chatTurnTimerId,
  initialChatTurnState,
  reduceChatTurn,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnState,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatSendMessageRequest,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  InvariantContext,
  InvariantId,
  InvariantViolation,
  DormantInvariantOptions,
  DormantInvariantResult,
  PipelineChatTarget,
  PipelineTraceEvent,
  ProviderTraceEvent,
  RevisionChatView,
  RevisionTraceEvent,
} from './contracts';
import { INVARIANT_STAGING, INVARIANT_TEXT } from './invariant-staging';

const IDS: readonly InvariantId[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
];
interface SelectedView {
  key: string;
  target: PipelineChatTarget;
  event: RevisionTraceEvent;
  view: RevisionChatView;
}
interface Evaluation {
  violations: InvariantViolation[];
  activation: Partial<Record<InvariantId, number>>;
}
interface Rule {
  hit(event: PipelineTraceEvent): void;
  fail(message: string, ...events: PipelineTraceEvent[]): void;
}

function key(target: PipelineChatTarget): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

function eventKey(event: PipelineTraceEvent): string | undefined {
  if (event.kind === 'revision') return undefined;
  if (event.kind === 'queue') return key(event.event);
  return event.target ? key(event.target) : undefined;
}

function selectedViews(trace: readonly PipelineTraceEvent[]): SelectedView[] {
  return trace.flatMap((event) =>
    event.kind === 'revision'
      ? Object.entries(event.chats).map(([chatId, view]) => {
          const target = {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId,
          };
          return { key: key(target), target, event, view };
        })
      : [],
  );
}

function rowText(row: PersistedChatMessage): string {
  return row.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function generatedRequest(request: ChatSendMessageRequest): boolean {
  return (
    request.watcherFired !== undefined ||
    request.internalRow !== undefined ||
    request.managedDelegationDeliveryId !== undefined ||
    request.asyncQuestionId !== undefined ||
    (request.initiationSource === 'automation' &&
      Boolean(request.automationName?.trim()))
  );
}

function carries(frame: ProviderTraceEvent, text: string): boolean {
  return (
    text.length > 0 && frame.text !== undefined && frame.text.includes(text)
  );
}

function ordinary(frame: ProviderTraceEvent): boolean {
  return (
    frame.direction === 'to-provider' &&
    ((frame.provider === 'claude' && frame.type === 'prompt') ||
      (frame.provider === 'codex' && frame.type === 'client:turn/start'))
  );
}

function delivery(frame: ProviderTraceEvent): boolean {
  return (
    ordinary(frame) ||
    (frame.direction === 'to-provider' &&
      (frame.type === 'steer' || frame.type === 'client:turn/steer'))
  );
}

function terminal(frame: ProviderTraceEvent): boolean {
  return (
    frame.direction === 'to-canopy' &&
    !frame.ids?.toolUseId &&
    (frame.type === 'sdk:result' ||
      frame.type.startsWith('sdk:result:') ||
      frame.type === 'notification:turn/completed')
  );
}

/** Compare the complete settled row, not just completedAt; off-page absence is not a mutation. */
function timers(views: readonly SelectedView[], rule: Rule): void {
  const settled = new Map<
    string,
    { row: PersistedChatMessage; event: PipelineTraceEvent }
  >();
  for (const { key: chat, event, view } of views) {
    for (const row of view.rows ?? []) {
      const id = JSON.stringify([chat, row.id]);
      const before = settled.get(id);
      if (before) {
        rule.hit(event);
        if (JSON.stringify(before.row) !== JSON.stringify(row))
          rule.fail(
            `Settled timer row ${row.id} changed.`,
            before.event,
            event,
          );
      } else if (
        row.blocks.some(
          (block) => block.type === 'turn_timer' && block.completedAt !== null,
        )
      ) {
        rule.hit(event);
        settled.set(id, { row, event });
      }
    }
  }
}

/** Native task membership is scoped to the full target, and explicit user intent is task-local. */
function taskSafety(
  trace: readonly PipelineTraceEvent[],
  wake: Rule,
  session: Rule,
): void {
  const tasks = new Map<string, Map<string, PipelineTraceEvent>>();
  const consent = new Map<string, number>();
  const holders = new Map<string, string>();
  for (const event of trace) {
    if (event.kind !== 'revision' && event.kind !== 'queue' && event.target) {
      const target = event.target;
      holders.set(
        `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
        key(target),
      );
      if (event.kind === 'effect' && event.effect.name === 'wake-lock-acquire')
        holders.set(event.effect.holder, key(target));
    }
    const chat =
      eventKey(event) ??
      (event.kind === 'effect' && event.effect.name === 'wake-lock-release'
        ? holders.get(event.effect.holder)
        : undefined);
    if (!chat) continue;
    if (event.kind === 'checkpoint' && event.userInitiated)
      consent.set(chat, event.seq);
    if (event.kind !== 'effect') continue;
    const live = tasks.get(chat) ?? new Map<string, PipelineTraceEvent>();
    tasks.set(chat, live);
    if (event.effect.name === 'native-task-live') {
      if (!live.has(event.effect.taskId)) live.set(event.effect.taskId, event);
      wake.hit(event);
      session.hit(event);
    } else if (event.effect.name === 'native-task-ended')
      live.delete(event.effect.taskId);
    else if (event.effect.name === 'wake-lock-release') {
      wake.hit(event);
      if (live.size)
        wake.fail(
          'Chat wake-lock holder released with a live native task.',
          ...Array.from(live.values()),
          event,
        );
    } else if (event.effect.name === 'session-destroyed') {
      session.hit(event);
      const unconsented = Array.from(live.values()).filter(
        (task) => task.seq >= (consent.get(chat) ?? -1),
      );
      if (unconsented.length)
        session.fail(
          'Session destroyed without user intent after native work began.',
          ...unconsented,
          event,
        );
    }
  }
}

function childResults(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  rule: Rule,
): void {
  const live = new Map<string, Map<string, string | undefined>>();
  const roots = new Map<string, ProviderTraceEvent>();
  const children = new Map<string, Map<string, string>>();
  const previous = new Map<
    string,
    { results: Set<string>; event: PipelineTraceEvent }
  >();
  const ownResults = new Map<string, Set<string>>();
  for (const event of trace) {
    const chat = eventKey(event);
    if (event.kind === 'effect' && chat) {
      const tasks = live.get(chat) ?? new Map<string, string | undefined>();
      live.set(chat, tasks);
      if (event.effect.name === 'native-task-live')
        tasks.set(event.effect.taskId, event.effect.toolUseId);
      if (event.effect.name === 'native-task-ended')
        tasks.delete(event.effect.taskId);
    }
    if (event.kind === 'provider' && chat) {
      if (terminal(event)) {
        roots.set(chat, event);
        ownResults.set(chat, new Set());
      } else if (
        event.direction === 'to-canopy' &&
        (event.type.startsWith('sdk:user') ||
          event.type === 'notification:item/completed')
      ) {
        const id = event.ids?.toolUseId ?? event.ids?.callId;
        if (id) ownResults.get(chat)?.add(id);
      }
    }
    if (event.kind !== 'revision') continue;
    for (const entry of views.filter(
      (view) => view.event === event && view.view.rows !== undefined,
    )) {
      const before = previous.get(entry.key);
      const root = roots.get(entry.key);
      const known = children.get(entry.key) ?? new Map<string, string>();
      children.set(entry.key, known);
      const results = new Set(before?.results);
      const added: string[] = [];
      for (const row of entry.view.rows ?? []) {
        const parent = row.parentToolUseId ?? row.parentBlockId;
        for (const block of row.blocks) {
          if (block.type === 'tool_use' && parent)
            known.set(block.toolUseId, parent);
          if (block.type === 'tool_result' && !results.has(block.toolUseId)) {
            if (parent) known.set(block.toolUseId, parent);
            added.push(block.toolUseId);
            results.add(block.toolUseId);
          }
        }
      }
      if (root && before) {
        const correlations = new Set(live.get(entry.key)?.values());
        for (const [callId, parent] of Array.from(known.entries())) {
          if (!correlations.has(parent) && !correlations.has(callId)) continue;
          rule.hit(event);
          if (added.includes(callId) && !ownResults.get(entry.key)?.has(callId))
            rule.fail(
              `Root terminal wrote a result for live child call ${callId}.`,
              before.event,
              root,
              event,
            );
        }
      }
      previous.set(entry.key, { results, event });
    }
  }
}

function prompts(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  context: InvariantContext,
  rule: Rule,
): void {
  const seen = new Set<string>();
  const used = new Set<number>();
  const samples: {
    ms: number;
    commit: PipelineTraceEvent;
    frame: PipelineTraceEvent;
  }[] = [];
  const frames = trace.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' && ordinary(event),
  );
  for (const { key: chat, event, view } of views) {
    for (const row of view.rows ?? []) {
      const identity = JSON.stringify([chat, row.id]);
      if (
        row.role !== 'user' ||
        row.parentToolUseId ||
        row.parentBlockId ||
        seen.has(identity)
      )
        continue;
      seen.add(identity);
      if (
        row.blocks.some(
          (b) => b.type === 'text' && b.steering?.startsTurn === false,
        )
      )
        continue;
      const text = rowText(row);
      if (!text) continue;
      rule.hit(event);
      // A steered row that owns its turn reached the provider as the steer,
      // possibly before its committed copy; no handoff timing applies.
      if (row.blocks.some((b) => b.type === 'text' && b.steering)) {
        const steer = trace.find(
          (candidate) =>
            candidate.kind === 'provider' &&
            eventKey(candidate) === chat &&
            delivery(candidate) &&
            carries(candidate, text),
        );
        if (!steer)
          rule.fail(
            `Steered prompt ${row.id} never reached the provider.`,
            event,
          );
        continue;
      }
      const frame = frames.find(
        (candidate) =>
          eventKey(candidate) === chat &&
          candidate.seq > event.seq &&
          !used.has(candidate.seq) &&
          carries(candidate, text),
      );
      // A commit whose revision did not select this chat's rows (Cowork's
      // `upsertStandaloneMessages`) can hold the prompt before it first shows;
      // a frame after that revision still counts, without a timing sample.
      const hiddenCommit = frame
        ? undefined
        : views.find(
            (candidate) =>
              candidate.key === chat &&
              candidate.event.seq < event.seq &&
              candidate.view.rows === undefined,
          );
      const earlier = hiddenCommit
        ? frames.find(
            (candidate) =>
              eventKey(candidate) === chat &&
              candidate.seq > hiddenCommit.event.seq &&
              candidate.seq < event.seq &&
              !used.has(candidate.seq) &&
              carries(candidate, text),
          )
        : undefined;
      if (frame) {
        used.add(frame.seq);
        samples.push({ ms: frame.at - event.at, commit: event, frame });
      } else if (earlier) used.add(earlier.seq);
      else
        rule.fail(
          `Committed prompt ${row.id} never reached the provider.`,
          event,
        );
    }
  }
  if (context.absoluteTiming && samples.length) {
    const sorted = [...samples].sort((a, b) => a.ms - b.ms);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    if (p95 && p95.ms >= 2000)
      rule.fail(
        `Prompt handoff p95 ${p95.ms} ms is not below 2000 ms.`,
        p95.commit,
        p95.frame,
      );
  }
}

/** Collect identities from main-owned metadata, not from tool-name or message-text heuristics. */
function generatedTexts(
  views: readonly SelectedView[],
): Map<string, Map<string, string>> {
  const generated = new Map<string, Map<string, string>>();
  for (const entry of views) {
    const rows = generated.get(entry.key) ?? new Map<string, string>();
    generated.set(entry.key, rows);
    for (const row of entry.view.rows ?? [])
      if (row.watcherFired || row.userMessageSource === 'watcher' || row.hidden)
        rows.set(row.id, rowText(row));
    for (const row of entry.view.inputDelivery?.rows ?? [])
      if (generatedRequest(row.payload)) rows.set(row.id, row.text);
    for (const queued of entry.view.runtime?.queuedMessages ?? [])
      if (generatedRequest(queued.request))
        rows.set(queued.id, queued.request.text);
  }
  return generated;
}

function generatedQueue(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  context: InvariantContext,
  rule: Rule,
): void {
  const generated = generatedTexts(views);
  const latest = new Map<
    string,
    Extract<PipelineTraceEvent, { kind: 'queue' }>
  >();
  const obligations = new Map<
    string,
    {
      chat: string;
      text: string;
      event: PipelineTraceEvent;
      checkpoint: PipelineTraceEvent;
    }
  >();
  const horizon = trace[trace.length - 1];
  for (const event of trace) {
    if (event.kind === 'queue') {
      const chat = key(event.event);
      latest.set(chat, event);
      for (const row of event.event.queue) {
        if (!row.watcherFired && !generated.get(chat)?.has(row.id)) continue;
        if (event.turnActive === true) {
          rule.hit(event);
          const steered = trace.some(
            (frame) =>
              frame.kind === 'provider' &&
              eventKey(frame) === chat &&
              frame.seq >= event.seq &&
              delivery(frame) &&
              !ordinary(frame) &&
              carries(frame, row.text),
          );
          if (!row.waitingReason && !steered)
            rule.fail(
              `Foreground generated row ${row.id} is neither steered nor queued with a waiting reason.`,
              event,
            );
        }
      }
    }
    if (
      event.kind !== 'checkpoint' ||
      event.label !== 'delivery-eligible' ||
      !event.target
    )
      continue;
    const chat = key(event.target);
    const queue = latest.get(chat);
    for (const row of queue?.event.queue ?? []) {
      if (!row.watcherFired && !generated.get(chat)?.has(row.id)) continue;
      const identity = JSON.stringify([chat, row.id]);
      if (!obligations.has(identity) && queue)
        obligations.set(identity, {
          chat,
          text: row.text,
          event: queue,
          checkpoint: event,
        });
    }
  }
  // A generated message steered straight through input delivery never enters
  // the queue; its steer frame satisfies the rule. An input-delivery row is
  // itself a steer attempt, so its settlement belongs to invariant 21.
  const directSeen = new Set<string>();
  for (const entry of views) {
    for (const row of entry.view.inputDelivery?.rows ?? []) {
      if (!generatedRequest(row.payload)) continue;
      const identity = JSON.stringify([entry.key, row.id]);
      if (directSeen.has(identity)) continue;
      directSeen.add(identity);
      const steer = trace.find(
        (frame) =>
          frame.kind === 'provider' &&
          eventKey(frame) === entry.key &&
          delivery(frame) &&
          !ordinary(frame) &&
          carries(frame, row.text),
      );
      if (steer) rule.hit(steer);
    }
  }
  for (const { chat, text, event, checkpoint } of Array.from(
    obligations.values(),
  )) {
    rule.hit(checkpoint);
    const consumed = trace.find(
      (frame) =>
        frame.kind === 'provider' &&
        frame.seq > checkpoint.seq &&
        eventKey(frame) === chat &&
        delivery(frame) &&
        carries(frame, text),
    );
    const deadline = checkpoint.logicalAt + context.deliveryBoundMs;
    if (
      consumed
        ? consumed.logicalAt > deadline
        : horizon && horizon.logicalAt >= deadline
    ) {
      rule.fail(
        `Queued generated input was not delivered within ${context.deliveryBoundMs} logical ms of eligibility.`,
        event,
        checkpoint,
        ...(consumed ? [consumed] : horizon ? [horizon] : []),
      );
    }
  }
}

function privacy(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  context: InvariantContext,
  rule: Rule,
): void {
  const generated = generatedTexts(views);
  for (const event of trace) {
    if (event.kind === 'queue') {
      const known =
        generated.get(key(event.event)) ?? new Map<string, string>();
      for (const row of event.event.queue)
        if (row.watcherFired) known.set(row.id, row.text);
      generated.set(key(event.event), known);
    }
  }
  for (const event of trace) {
    if (
      event.kind !== 'queue' &&
      !(event.kind === 'provider' && event.direction === 'to-provider')
    )
      continue;
    rule.hit(event);
    const serialized = JSON.stringify(event);
    const leaked = context.secrets.filter(
      (secret) => secret.length > 0 && serialized.includes(secret),
    );
    if (!leaked.length) continue;
    const ownDelivery =
      event.kind === 'provider' &&
      delivery(event) &&
      Array.from(generated.get(key(event.target))?.values() ?? []).some(
        (text) => carries(event, text),
      ) &&
      leaked.every((secret) => event.text?.includes(secret));
    if (!ownDelivery)
      rule.fail(
        'Internal payload text leaked outside its own generated delivery.',
        event,
      );
  }
}

function gates(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
  rule: Rule,
): void {
  const horizon = trace[trace.length - 1];
  for (const event of trace) {
    if (
      event.kind !== 'checkpoint' ||
      event.label !== 'drained' ||
      event.liveness?.foreground !== false ||
      !event.target
    )
      continue;
    rule.hit(event);
    if (event.queueTurnActive === false) continue;
    const deadline = event.logicalAt + context.gateBoundMs;
    const cleared = trace.find(
      (candidate) =>
        candidate.kind === 'checkpoint' &&
        candidate.seq > event.seq &&
        eventKey(candidate) === eventKey(event) &&
        candidate.queueTurnActive === false &&
        candidate.logicalAt <= deadline,
    );
    if (!cleared && horizon && horizon.logicalAt >= deadline)
      rule.fail(
        `Queue gate did not clear within ${context.gateBoundMs} logical ms after drain.`,
        event,
        horizon,
      );
  }
}

function steers(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
  rule: Rule,
): void {
  const used = new Set<number>();
  for (const sent of trace) {
    if (
      sent.kind !== 'provider' ||
      sent.provider !== 'claude' ||
      sent.direction !== 'to-provider' ||
      sent.type !== 'steer'
    )
      continue;
    const held = [...trace]
      .reverse()
      .find(
        (event) =>
          event.seq < sent.seq &&
          event.kind === 'effect' &&
          (event.effect.name === 'commits-held' ||
            event.effect.name === 'commits-released') &&
          (!event.target || eventKey(event) === eventKey(sent)),
      );
    const answer = trace.find(
      (event) =>
        event.seq > sent.seq &&
        !used.has(event.seq) &&
        event.kind === 'effect' &&
        event.effect.name === 'steer-settled' &&
        event.effect.text === sent.text &&
        eventKey(event) === eventKey(sent),
    );
    if (answer) {
      used.add(answer.seq);
      rule.hit(answer);
    }
    const holding =
      held?.kind === 'effect' && held.effect.name === 'commits-held';
    if (holding) {
      rule.hit(sent);
      const released = trace.find(
        (event) =>
          event.seq > sent.seq &&
          event.kind === 'effect' &&
          event.effect.name === 'commits-released' &&
          (!event.target || eventKey(event) === eventKey(sent)),
      );
      if (!answer || (released && answer.seq >= released.seq))
        rule.fail(
          'Claude steer was not settled while durable commits were held.',
          held,
          sent,
          ...(released ? [released] : []),
          ...(answer ? [answer] : []),
        );
    }
    // Canopy's handling starts at the CLI's acknowledgement; a script may
    // acknowledge late on purpose, and that delay is the provider's.
    const messageUuid = sent.ids?.messageUuid;
    const acknowledged =
      messageUuid === undefined
        ? undefined
        : trace.find(
            (event) =>
              event.seq > sent.seq &&
              event.kind === 'provider' &&
              event.direction === 'to-canopy' &&
              event.ids?.messageUuid === messageUuid,
          );
    const start = acknowledged ?? sent;
    if (context.absoluteTiming && answer && answer.at - start.at >= 1000)
      rule.fail(
        `Claude steer settlement took ${answer.at - start.at} ms, not below 1000 ms.`,
        start,
        answer,
      );
  }
}

/** Completion may amend its original command row; progress still cannot. */
function isCommandResultAmendment(
  trace: readonly PipelineTraceEvent[],
  target: PipelineChatTarget,
  beforeSeq: number,
  afterSeq: number,
): boolean {
  const rowsAt = (seq: number): readonly PersistedChatMessage[] | undefined => {
    for (const event of [...trace].reverse()) {
      if (
        event.kind !== 'revision' ||
        event.seq > seq ||
        event.projectId !== target.projectId ||
        event.worktreeId !== target.worktreeId
      )
        continue;
      const rows = event.chats[target.chatId]?.rows;
      if (rows) return rows;
    }
    return undefined;
  };
  const before = rowsAt(beforeSeq);
  const after = rowsAt(afterSeq);
  if (!before || !after || before.length !== after.length) return false;
  let amended = 0;
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index];
    const next = after[index];
    if (!prior || !next || prior.id !== next.id) return false;
    if (JSON.stringify(prior) === JSON.stringify(next)) continue;
    const completions = trace.filter(
      (event): event is ProviderTraceEvent =>
        event.kind === 'provider' &&
        event.provider === 'codex' &&
        event.direction === 'to-canopy' &&
        event.type === 'notification:item/completed' &&
        event.seq < afterSeq &&
        eventKey(event) === key(target) &&
        event.commandCompletion !== undefined,
    );
    const completion = completions
      .reverse()
      .find(
        (event) => prior.id === `codex-${event.commandCompletion?.itemId}`,
      )?.commandCompletion;
    if (
      !completion ||
      prior.codexThreadId !== completion.threadId ||
      prior.codexTurnId !== completion.turnId
    )
      return false;
    const toolUseId = `codex-${completion.itemId}`;
    if (
      !prior.blocks.some(
        (block) => block.type === 'tool_use' && block.toolUseId === toolUseId,
      )
    )
      return false;
    const results = next.blocks.filter(
      (block) => block.type === 'tool_result' && block.toolUseId === toolUseId,
    );
    if (
      results.length !== 1 ||
      results[0]?.type !== 'tool_result' ||
      results[0].output !== completion.aggregateOutput
    )
      return false;
    const withoutResult = (
      row: PersistedChatMessage,
    ): PersistedChatMessage => ({
      ...row,
      blocks: row.blocks.filter(
        (block) =>
          block.type !== 'tool_result' || block.toolUseId !== toolUseId,
      ),
    });
    if (
      JSON.stringify(withoutResult(prior)) !==
      JSON.stringify(withoutResult(next))
    )
      return false;
    amended += 1;
  }
  return amended === 1;
}

/** A child terminal may complete its existing Codex agent card after commit. */
function isAgentCardCompletionAmendment(
  trace: readonly PipelineTraceEvent[],
  target: PipelineChatTarget,
  fromSeq: number,
  toSeq: number,
): boolean {
  const rowsAt = (seq: number): readonly PersistedChatMessage[] | undefined => {
    for (const event of [...trace].reverse()) {
      if (
        event.kind !== 'revision' ||
        event.seq > seq ||
        event.projectId !== target.projectId ||
        event.worktreeId !== target.worktreeId
      )
        continue;
      const rows = event.chats[target.chatId]?.rows;
      if (rows) return rows;
    }
    return undefined;
  };
  const before = rowsAt(fromSeq);
  const after = rowsAt(toSeq);
  if (!before || !after || before.length !== after.length) return false;

  const rewrites = trace.filter(
    (event) =>
      event.kind === 'effect' &&
      event.effect.name === 'transcript-rewrite' &&
      event.seq > fromSeq &&
      event.seq < toSeq &&
      eventKey(event) === key(target),
  );
  const forbidden = rewrites.filter(
    (event) =>
      event.kind === 'effect' &&
      event.effect.name === 'transcript-rewrite' &&
      event.effect.reason !== 'prompt_relocation',
  );
  if (
    forbidden.length === 0 ||
    forbidden.some(
      (event) =>
        event.kind !== 'effect' ||
        event.effect.name !== 'transcript-rewrite' ||
        event.effect.reason !== 'patch',
    )
  )
    return false;

  const terminalAgentStates = new Set(['completed', 'cancelled', 'errored']);
  const terminalCardStatuses = new Set(['completed', 'failed', 'interrupted']);
  const hasChildTerminal = (childThreadId: string): boolean =>
    trace.some((event) => {
      if (
        event.kind !== 'provider' ||
        event.provider !== 'codex' ||
        event.direction !== 'to-canopy' ||
        event.seq <= fromSeq ||
        event.seq >= toSeq ||
        eventKey(event) !== key(target)
      )
        return false;
      return event.agentTerminal?.threadId === childThreadId;
    });

  let amended = false;
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index];
    const next = after[index];
    if (!prior || !next || prior.id !== next.id) return false;
    if (JSON.stringify(prior) === JSON.stringify(next)) continue;
    if (amended || prior.blocks.length !== next.blocks.length) return false;

    const priorRowWithoutBlocks = { ...prior, blocks: [] };
    const nextRowWithoutBlocks = { ...next, blocks: [] };
    if (
      JSON.stringify(priorRowWithoutBlocks) !==
      JSON.stringify(nextRowWithoutBlocks)
    )
      return false;

    let priorCard:
      | Extract<
          PersistedChatMessage['blocks'][number],
          { type: 'codex_agent_call' }
        >
      | undefined;
    let nextCard:
      | Extract<
          PersistedChatMessage['blocks'][number],
          { type: 'codex_agent_call' }
        >
      | undefined;
    let changedBlocks = 0;
    for (
      let blockIndex = 0;
      blockIndex < prior.blocks.length;
      blockIndex += 1
    ) {
      const priorBlock = prior.blocks[blockIndex];
      const nextBlock = next.blocks[blockIndex];
      if (!priorBlock || !nextBlock) return false;
      if (JSON.stringify(priorBlock) === JSON.stringify(nextBlock)) continue;
      changedBlocks += 1;
      if (
        changedBlocks > 1 ||
        priorBlock.type !== 'codex_agent_call' ||
        nextBlock.type !== 'codex_agent_call' ||
        priorBlock.callId !== nextBlock.callId
      )
        return false;
      priorCard = priorBlock;
      nextCard = nextBlock;
    }
    if (!priorCard || !nextCard || changedBlocks !== 1) return false;

    const {
      status: priorStatus,
      agentsStates: priorAgents,
      receiverTimes: priorTimes,
      ...priorCardFields
    } = priorCard;
    const {
      status: nextStatus,
      agentsStates: nextAgents,
      receiverTimes: nextTimes,
      ...nextCardFields
    } = nextCard;
    if (
      JSON.stringify(priorCardFields) !== JSON.stringify(nextCardFields) ||
      priorStatus === nextStatus ||
      terminalCardStatuses.has(priorStatus) ||
      !terminalCardStatuses.has(nextStatus)
    )
      return false;

    const priorChildren = Object.keys(priorAgents).sort();
    const nextChildren = Object.keys(nextAgents).sort();
    if (JSON.stringify(priorChildren) !== JSON.stringify(nextChildren))
      return false;
    const changedChildren: string[] = [];
    for (const childThreadId of priorChildren) {
      const priorState = priorAgents[childThreadId];
      const nextState = nextAgents[childThreadId];
      if (!priorState || !nextState) return false;
      if (JSON.stringify(priorState) === JSON.stringify(nextState)) continue;
      const { status: priorChildStatus, ...priorStateFields } = priorState;
      const { status: nextChildStatus, ...nextStateFields } = nextState;
      if (
        JSON.stringify(priorStateFields) !== JSON.stringify(nextStateFields) ||
        priorChildStatus !== 'running' ||
        !terminalAgentStates.has(nextChildStatus)
      )
        return false;
      changedChildren.push(childThreadId);
    }
    if (
      changedChildren.length === 0 ||
      changedChildren.some(
        (childThreadId) =>
          !priorCard.receiverThreadIds.includes(childThreadId) ||
          !hasChildTerminal(childThreadId),
      )
    )
      return false;
    for (const childThreadId of Object.keys({
      ...priorTimes,
      ...nextTimes,
    })) {
      const priorTime = priorTimes?.[childThreadId];
      const nextTime = nextTimes?.[childThreadId];
      if (JSON.stringify(priorTime) === JSON.stringify(nextTime)) continue;
      if (
        !changedChildren.includes(childThreadId) ||
        !nextTime ||
        nextTime.settledAt === undefined ||
        priorTime?.settledAt !== undefined ||
        priorTime?.startedAt !== nextTime.startedAt
      )
        return false;
    }
    amended = true;
  }
  return amended;
}

function transcripts(trace: readonly PipelineTraceEvent[], rule: Rule): void {
  const captures = new Map<string, PipelineTraceEvent>();
  for (const event of trace) {
    if (event.kind !== 'transcript') continue;
    const chat = key(event.target);
    const before = captures.get(chat);
    if (event.previous) {
      rule.hit(event);
      const rewrites = trace.filter(
        (candidate) =>
          candidate.kind === 'effect' &&
          candidate.effect.name === 'transcript-rewrite' &&
          eventKey(candidate) === chat &&
          candidate.seq < event.seq &&
          candidate.seq > (before?.seq ?? -1),
      );
      const changed =
        event.previous.prefixSha256 !== event.previous.sha256 ||
        event.committedBytes < event.previous.committedBytes;
      // The always-on journal records a turn start's committed rows plus its
      // active tail as mixed_active; allowed while committed bytes are kept.
      const forbidden = rewrites.filter(
        (candidate) =>
          candidate.kind === 'effect' &&
          candidate.effect.name === 'transcript-rewrite' &&
          candidate.effect.reason !== 'prompt_relocation' &&
          (candidate.effect.reason !== 'mixed_active' || changed),
      );
      const commandAmendment =
        forbidden.length > 0 &&
        forbidden.every(
          (candidate) =>
            candidate.kind === 'effect' &&
            candidate.effect.name === 'transcript-rewrite' &&
            candidate.effect.reason === 'patch',
        ) &&
        isCommandResultAmendment(
          trace,
          event.target,
          before?.seq ?? -1,
          event.seq,
        );
      const agentCardAmendment =
        forbidden.length > 0 &&
        forbidden.every(
          (candidate) =>
            candidate.kind === 'effect' &&
            candidate.effect.name === 'transcript-rewrite' &&
            candidate.effect.reason === 'patch',
        ) &&
        isAgentCardCompletionAmendment(
          trace,
          event.target,
          before?.seq ?? -1,
          event.seq,
        );
      if (
        (!commandAmendment && !agentCardAmendment && forbidden.length) ||
        (changed && rewrites.length === 0)
      )
        rule.fail(
          'Committed transcript bytes were rewritten outside prompt_relocation compatibility.',
          ...(before ? [before] : []),
          ...rewrites,
          event,
        );
    }
    captures.set(chat, event);
  }
}

function cancellations(trace: readonly PipelineTraceEvent[], rule: Rule): void {
  const calls = new Map<
    string,
    Map<string, { turnKey?: string; cancellation?: PipelineTraceEvent }>
  >();
  for (const event of trace) {
    const chat = eventKey(event);
    if (!chat) continue;
    const active =
      calls.get(chat) ??
      new Map<
        string,
        { turnKey?: string; cancellation?: PipelineTraceEvent }
      >();
    calls.set(chat, active);
    if (event.kind === 'provider' && event.direction === 'to-canopy') {
      const id = event.ids?.callId;
      if (event.type === 'notification:serverRequest/resolved' && id) {
        active.set(id, { ...active.get(id), cancellation: event });
      } else if (terminal(event)) {
        for (const call of Array.from(active.values()))
          if (!event.turnKey || !call.turnKey || event.turnKey === call.turnKey)
            call.cancellation ??= event;
      } else if (id && !active.has(id))
        active.set(id, { turnKey: event.turnKey });
    }
    if (event.kind === 'effect' && event.effect.name === 'tool-side-effect') {
      rule.hit(event);
      // Codex sinks see `codex-${callId}` (codex/canopy-dynamic-tools.ts); frames carry the raw id.
      const callId = event.effect.callId;
      const call =
        active.get(callId) ?? active.get(callId.replace(/^codex-/, ''));
      // A completion cancels the turn even when the trace did not capture handler admission.
      const completion = [...trace]
        .reverse()
        .find(
          (candidate) =>
            candidate.seq < event.seq &&
            candidate.kind === 'provider' &&
            eventKey(candidate) === chat &&
            terminal(candidate),
        );
      const cancelled = call?.cancellation ?? (!call ? completion : undefined);
      if (cancelled)
        rule.fail(
          `Tool call ${event.effect.callId} produced a side effect after cancellation.`,
          cancelled,
          event,
        );
    }
  }
}

function sessionTurns(trace: readonly PipelineTraceEvent[], rule: Rule): void {
  const turns = new Map<string, Map<string, ProviderTraceEvent>>();
  const completed = new Set<string>();
  const queues = new Map<
    string,
    Extract<PipelineTraceEvent, { kind: 'queue' }>
  >();
  for (const event of trace) {
    const chat = eventKey(event);
    if (event.kind === 'queue') queues.set(key(event.event), event);
    if (
      event.kind === 'provider' &&
      event.provider === 'claude' &&
      event.direction === 'to-canopy' &&
      event.turnKey &&
      chat
    ) {
      const active = turns.get(chat) ?? new Map<string, ProviderTraceEvent>();
      turns.set(chat, active);
      const identity = JSON.stringify([chat, event.turnKey]);
      if (terminal(event)) {
        active.delete(event.turnKey);
        completed.add(identity);
      } else if (!active.has(event.turnKey) && !completed.has(identity))
        active.set(event.turnKey, event);
    }
    // A stopped turn may end without a root result (an abort fallback or the
    // session's destruction), so the user's Stop retires it. An interrupted
    // turn's later aborted-streaming result is then a no-op here.
    if (
      chat &&
      ((event.kind === 'checkpoint' && event.userInitiated === true) ||
        (event.kind === 'effect' && event.effect.name === 'session-destroyed'))
    ) {
      for (const turnKey of Array.from(turns.get(chat)?.keys() ?? []))
        completed.add(JSON.stringify([chat, turnKey]));
      turns.get(chat)?.clear();
    }
    if (event.kind === 'checkpoint' && chat && turns.get(chat)?.size) {
      rule.hit(event);
      if (event.sessionTurnActive !== true)
        rule.fail(
          'Claude provider turn has no active session turn.',
          ...Array.from(turns.get(chat)?.values() ?? []),
          event,
        );
    }
    if (event.kind !== 'revision') continue;
    for (const [chatId, view] of Object.entries(event.chats)) {
      const scope = key({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId,
      });
      if (!turns.get(scope)?.size || !view.runtime?.activeTurn) continue;
      rule.hit(event);
      const queue = queues.get(scope);
      const userId = view.runtime.activeTurn.userMessageId;
      if (queue?.event.queue.some((row) => row.id === userId))
        rule.fail(
          `Active turn borrowed queued row id ${userId}.`,
          queue,
          event,
        );
    }
  }
}

const DORMANT_IDS = [1, 2, 3, 4, 5, 6, 15, 19] as const;
type DormantInvariantId = (typeof DORMANT_IDS)[number];

function dormantRule(
  id: DormantInvariantId,
  activation: Partial<Record<InvariantId, number>>,
  violations: InvariantViolation[],
): Rule {
  const evaluated = new Set<number>();
  return {
    hit(event): void {
      evaluated.add(event.seq);
      activation[id] = evaluated.size;
    },
    fail(message, ...events): void {
      violations.push({
        id,
        message,
        seqs: Array.from(new Set(events.map((event) => event.seq))).sort(
          (left, right) => left - right,
        ),
      });
    },
  };
}

type TurnTimerBlock = Extract<
  PersistedChatMessage['blocks'][number],
  { type: 'turn_timer' }
>;

function timerBlocks(row: PersistedChatMessage): TurnTimerBlock[] {
  return row.blocks.filter(
    (block): block is TurnTimerBlock => block.type === 'turn_timer',
  );
}

function timerRows(view: RevisionChatView): PersistedChatMessage[] {
  return (view.rows ?? []).filter((row) => timerBlocks(row).length > 0);
}

function reducerMeaning(state: ChatTurnState): string {
  return JSON.stringify({ ...state, cursors: {} });
}

function pairedTimerPlacement(
  view: RevisionChatView,
  sharedAnchorIds: ReadonlySet<string>,
): string | undefined {
  if (view.rows === undefined) return undefined;
  type PlacementPart =
    | { kind: 'timer'; row: PersistedChatMessage }
    | { kind: 'anchor'; id: string };
  const parts = view.rows.flatMap((row): PlacementPart[] => {
    if (timerBlocks(row).length > 0) return [{ kind: 'timer', row }];
    return sharedAnchorIds.has(row.id) ? [{ kind: 'anchor', id: row.id }] : [];
  });
  return JSON.stringify(parts);
}

function eventIfPresent(
  event: PipelineTraceEvent | undefined,
): PipelineTraceEvent[] {
  return event ? [event] : [];
}

function dormantTimerRows(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  timerRule: Rule,
  foregroundRule: Rule,
): void {
  const turnsByChat = new Map<string, Set<string>>();
  const rememberTurn = (chat: string, turnId: string | undefined): void => {
    if (turnId === undefined) return;
    const turns = turnsByChat.get(chat) ?? new Set<string>();
    turns.add(turnId);
    turnsByChat.set(chat, turns);
  };
  for (const event of trace) {
    if (event.kind === 'turn-lifecycle') {
      const turnId =
        event.event.type === 'TurnStarted' || event.event.type === 'TurnEnded'
          ? event.event.turnId
          : event.event.observedDuringTurnId;
      rememberTurn(key(event.target), turnId);
    } else if (event.kind === 'revision') {
      for (const [chatId, view] of Object.entries(event.chats)) {
        const chat = key({
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId,
        });
        rememberTurn(chat, view.runtime?.turn?.current?.id);
        rememberTurn(chat, view.runtime?.turn?.lastEnded?.id);
        for (const turnId of view.runtime?.turn?.endedTurnIds ?? [])
          rememberTurn(chat, turnId);
      }
    }
  }
  const settled = new Map<
    string,
    { row: PersistedChatMessage; event: RevisionTraceEvent }
  >();

  for (const entry of views) {
    const { view, event } = entry;
    const turn = view.runtime?.turn;
    const rows = timerRows(view);
    if (turn?.current || rows.length > 0) timerRule.hit(event);
    if (turn?.current && view.rows !== undefined) {
      const expectedId = chatTurnTimerId(turn.current.id);
      const matching = rows.filter((row) => row.id === expectedId);
      if (matching.length !== 1) {
        timerRule.fail(
          `Current turn ${turn.current.id} must have exactly one timer row keyed ${expectedId}; found ${matching.length}.`,
          event,
        );
      }
    }

    const seenIds = new Map<string, PersistedChatMessage>();
    for (const row of rows) {
      const blocks = timerBlocks(row);
      const previous = seenIds.get(row.id);
      if (previous) {
        timerRule.fail(
          `Timer row ${row.id} occurs more than once in one transcript snapshot.`,
          event,
        );
      } else seenIds.set(row.id, row);

      const knownTurnIds = turnsByChat.get(entry.key) ?? new Set<string>();
      if (
        !Array.from(knownTurnIds).some(
          (turnId) => chatTurnTimerId(turnId) === row.id,
        )
      )
        timerRule.fail(
          `Timer row ${row.id} has no exact chatTurnTimerId(turn.id) authority; timestamp correlation is not sufficient.`,
          event,
        );
      if (blocks.length !== 1)
        timerRule.fail(
          `Timer row ${row.id} must contain exactly one turn_timer block.`,
          event,
        );

      const firstBlock = blocks[0];
      if (firstBlock && firstBlock.completedAt !== null) {
        const identity = JSON.stringify([entry.key, row.id]);
        const before = settled.get(identity);
        if (before && JSON.stringify(before.row) !== JSON.stringify(row))
          timerRule.fail(
            `Settled timer row ${row.id} changed after completion.`,
            before.event,
            event,
          );
        else if (!before) settled.set(identity, { row, event });
      }
    }

    if (view.rows === undefined || !turn) continue;
    foregroundRule.hit(event);
    const current = turn.current;
    const hasCurrent = current !== undefined;
    if ((turn.phase === 'foreground') !== hasCurrent)
      foregroundRule.fail(
        `Persisted turn phase ${turn.phase} disagrees with its current turn.`,
        event,
      );
    const openRows = rows.filter((row) =>
      timerBlocks(row).some((block) => block.completedAt == null),
    );
    if (hasCurrent) {
      if (!current) continue;
      const currentId = chatTurnTimerId(current.id);
      const currentRows = rows.filter((row) => row.id === currentId);
      const currentBlock = currentRows.flatMap(timerBlocks)[0];
      const expectedPaused = current.pauses.some(
        (pause) => pause.endedAtMs === undefined,
      );
      const actuallyPaused =
        currentBlock !== undefined &&
        currentBlock.completedAt == null &&
        currentBlock.pausedAt != null &&
        currentBlock.resumedAt == null;
      if (currentBlock?.completedAt != null)
        foregroundRule.fail(
          `Foreground turn ${current.id} has a settled timer.`,
          event,
        );
      if (expectedPaused !== actuallyPaused)
        foregroundRule.fail(
          `Timer pause state for turn ${current.id} disagrees with persisted pause ownership.`,
          event,
        );
      if (
        matchingTimerRowCount(rows, currentId) !== 1 ||
        openRows.length !== 1 ||
        openRows[0]?.id !== currentId
      )
        foregroundRule.fail(
          `Foreground turn ${current.id} must own the only open timer row.`,
          event,
        );
    } else if (openRows.length > 0) {
      foregroundRule.fail(
        'A chat without a current foreground turn has an open or paused timer.',
        event,
      );
    }
  }
}

function matchingTimerRowCount(
  rows: readonly PersistedChatMessage[],
  id: string,
): number {
  return rows.filter((row) => row.id === id && timerBlocks(row).length > 0)
    .length;
}

function dormantSettlements(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  rule: Rule,
): void {
  const latestCurrent = new Map<string, string>();
  const reducerStates = new Map<string, ChatTurnState>();
  const causes: Array<{
    chat: string;
    turnId?: string;
    event: PipelineTraceEvent;
  }> = [];
  for (const event of trace) {
    if (event.kind === 'revision') {
      for (const [chatId, view] of Object.entries(event.chats)) {
        const chat = key({
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId,
        });
        const current = view.runtime?.turn?.current?.id;
        if (current) latestCurrent.set(chat, current);
        else latestCurrent.delete(chat);
      }
    } else if (event.kind === 'turn-lifecycle') {
      const chat = key(event.target);
      const before = reducerStates.get(chat) ?? initialChatTurnState();
      const priorTurnId = before.current?.id;
      const reduced = reduceChatTurn(before, event.event);
      reducerStates.set(chat, reduced.state);
      if (
        event.event.type === 'TurnStarted' &&
        priorTurnId !== undefined &&
        priorTurnId !== event.event.turnId
      ) {
        rule.hit(event);
        causes.push({ chat, turnId: priorTurnId, event });
      } else if (event.event.type === 'TurnEnded') {
        rule.hit(event);
        causes.push({ chat, turnId: event.event.turnId, event });
      }
    } else if (
      event.kind === 'checkpoint' &&
      event.target &&
      event.label === 'user-stop'
    ) {
      rule.hit(event);
      causes.push({
        chat: key(event.target),
        turnId:
          latestCurrent.get(key(event.target)) ??
          reducerStates.get(key(event.target))?.current?.id,
        event,
      });
    } else if (
      event.kind === 'effect' &&
      event.effect.name === 'session-destroyed' &&
      event.target
    ) {
      rule.hit(event);
      causes.push({
        chat: key(event.target),
        turnId:
          latestCurrent.get(key(event.target)) ??
          reducerStates.get(key(event.target))?.current?.id,
        event,
      });
    }
  }

  const viewsBySeq = new Map<number, SelectedView[]>();
  for (const entry of views) {
    const entries = viewsBySeq.get(entry.event.seq) ?? [];
    entries.push(entry);
    viewsBySeq.set(entry.event.seq, entries);
  }
  for (const cause of causes) {
    const what =
      cause.event.kind === 'turn-lifecycle'
        ? 'settlement'
        : cause.event.kind === 'checkpoint'
          ? 'Stop'
          : 'session removal';
    // The receipt comes first and the commit follows (contracts §3), so a
    // revision written between them can still show the turn open. Its close
    // must land by the next drained checkpoint and never reopen after it.
    let settled = false;
    let pending: PipelineTraceEvent | undefined;
    for (const event of trace) {
      if (event.seq <= cause.event.seq) continue;
      if (
        cause.turnId === undefined &&
        event.kind === 'turn-lifecycle' &&
        key(event.target) === cause.chat &&
        event.event.type === 'TurnStarted'
      )
        break; // Nothing was current: a later start is a new turn.
      if (
        event.kind === 'checkpoint' &&
        event.label === 'drained' &&
        event.target &&
        key(event.target) === cause.chat &&
        pending
      ) {
        rule.hit(event);
        rule.fail(
          `Turn timer remained current or open after ${what} through the drained checkpoint.`,
          cause.event,
          pending,
          event,
        );
        break;
      }
      for (const entry of viewsBySeq.get(event.seq) ?? []) {
        if (entry.key !== cause.chat || entry.view.runtime === undefined)
          continue;
        const current = entry.view.runtime.turn?.current;
        const currentOpen =
          current !== undefined &&
          (cause.turnId === undefined || current.id === cause.turnId);
        const timerOpen = timerRows(entry.view).some(
          (row) =>
            (cause.turnId === undefined ||
              row.id === chatTurnTimerId(cause.turnId)) &&
            timerBlocks(row).some((block) => block.completedAt == null),
        );
        if (!currentOpen && !timerOpen) {
          settled = true;
          pending = undefined;
          continue;
        }
        rule.hit(entry.event);
        // A timer close commits with its turn's end, so an open timer the
        // persisted turn no longer owns is never commit lag.
        if (settled || cause.turnId === undefined || !currentOpen)
          rule.fail(
            `Turn timer remained current or open after ${what}.`,
            cause.event,
            entry.event,
          );
        else pending ??= entry.event;
      }
    }
  }
}

function noOpSnapshotViolation(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  event: PipelineTraceEvent,
  chat: string,
  rule: Rule,
): void {
  const before = [...views]
    .reverse()
    .find(
      (candidate) => candidate.key === chat && candidate.event.seq < event.seq,
    );
  const after = views.find(
    (candidate) => candidate.key === chat && candidate.event.seq > event.seq,
  );
  if (!before || !after) return;
  // A later commit can include a buffered write from an admitted root turn,
  // queue/lifecycle transition, or transcript append. Without a causal marker
  // the harness cannot attribute that commit to the ignored frame.
  const ambiguousActivity = trace.some(
    (candidate) =>
      candidate.seq > before.event.seq &&
      candidate.seq < after.event.seq &&
      candidate.seq !== event.seq &&
      eventKey(candidate) === chat &&
      (candidate.kind === 'queue' ||
        candidate.kind === 'turn-lifecycle' ||
        (candidate.kind === 'provider' &&
          candidate.ids?.toolUseId === undefined) ||
        candidate.kind === 'transcript' ||
        (candidate.kind === 'checkpoint' && candidate.userInitiated === true) ||
        (candidate.kind === 'effect' &&
          (candidate.effect.name === 'transcript-rewrite' ||
            candidate.effect.name === 'session-created' ||
            candidate.effect.name === 'session-destroyed' ||
            candidate.effect.name === 'native-task-live' ||
            candidate.effect.name === 'native-task-ended'))),
  );
  if (ambiguousActivity) return;

  const beforeRuntime = before.view.runtime;
  const afterRuntime = after.view.runtime;
  const runtimeChanged =
    beforeRuntime !== undefined &&
    afterRuntime !== undefined &&
    (beforeRuntime.status !== afterRuntime.status ||
      !isDeepStrictEqual(beforeRuntime.turn, afterRuntime.turn));

  const beforeRows = before.view.rows;
  const afterRows = after.view.rows;
  let timerRowsChanged = false;
  if (beforeRows !== undefined && afterRows !== undefined) {
    const commonTimerIds = new Set(
      timerRows(before.view)
        .map((row) => row.id)
        .filter((id) => timerRows(after.view).some((row) => row.id === id)),
    );
    const afterRowIds = new Set(afterRows.map((row) => row.id));
    const sharedAnchors = new Set(
      beforeRows
        .filter(
          (row) => timerBlocks(row).length === 0 && afterRowIds.has(row.id),
        )
        .map((row) => row.id),
    );
    type PlacementPart =
      | { kind: 'timer'; id: string; blocks: TurnTimerBlock[] }
      | { kind: 'anchor'; id: string };
    const placement = (rows: readonly PersistedChatMessage[]): string =>
      JSON.stringify(
        rows.flatMap((row): PlacementPart[] => {
          const blocks = timerBlocks(row);
          if (blocks.length > 0)
            return [{ kind: 'timer' as const, id: row.id, blocks }];
          return sharedAnchors.has(row.id)
            ? [{ kind: 'anchor' as const, id: row.id }]
            : [];
        }),
      );
    const membershipChanged =
      sharedAnchors.size > 0 &&
      JSON.stringify(
        timerRows(before.view)
          .map((row) => row.id)
          .sort(),
      ) !==
        JSON.stringify(
          timerRows(after.view)
            .map((row) => row.id)
            .sort(),
        );
    timerRowsChanged =
      (commonTimerIds.size > 0 || sharedAnchors.size > 0) &&
      (membershipChanged || placement(beforeRows) !== placement(afterRows));
  }

  const gateSample = (
    candidate: PipelineTraceEvent,
  ): { session?: boolean; queue?: boolean } | undefined => {
    if (eventKey(candidate) !== chat) return undefined;
    if (candidate.kind === 'queue') return { queue: candidate.turnActive };
    if (candidate.kind === 'checkpoint')
      return {
        ...(candidate.sessionTurnActive === undefined
          ? {}
          : { session: candidate.sessionTurnActive }),
        ...(candidate.queueTurnActive === undefined
          ? {}
          : { queue: candidate.queueTurnActive }),
      };
    return undefined;
  };
  const sampleGate = (
    startSeq: number,
    endSeq: number,
  ): {
    session?: { value: boolean; event: PipelineTraceEvent };
    queue?: { value: boolean; event: PipelineTraceEvent };
  } => {
    let session: { value: boolean; event: PipelineTraceEvent } | undefined;
    let queue: { value: boolean; event: PipelineTraceEvent } | undefined;
    for (const candidate of trace) {
      if (candidate.seq <= startSeq || candidate.seq >= endSeq) continue;
      const sample = gateSample(candidate);
      if (sample?.session !== undefined)
        session = { value: sample.session, event: candidate };
      if (sample?.queue !== undefined)
        queue = { value: sample.queue, event: candidate };
    }
    return { ...(session ? { session } : {}), ...(queue ? { queue } : {}) };
  };
  const gateBefore = sampleGate(before.event.seq, event.seq);
  const gateAfter = sampleGate(event.seq, after.event.seq);
  const changedGateEvents: PipelineTraceEvent[] = [];
  if (
    gateBefore.session &&
    gateAfter.session &&
    gateBefore.session.value !== gateAfter.session.value
  )
    changedGateEvents.push(gateBefore.session.event, gateAfter.session.event);
  if (
    gateBefore.queue &&
    gateAfter.queue &&
    gateBefore.queue.value !== gateAfter.queue.value
  )
    changedGateEvents.push(gateBefore.queue.event, gateAfter.queue.event);

  if (runtimeChanged || timerRowsChanged || changedGateEvents.length > 0) {
    rule.hit(before.event);
    rule.hit(event);
    rule.hit(after.event);
    for (const gateEvent of changedGateEvents) rule.hit(gateEvent);
    rule.fail(
      'An ignored child, replayed or late frame changed a canonical runtime decision, sampled gate, or timer row.',
      before.event,
      ...changedGateEvents,
      event,
      after.event,
    );
  }
}

function dormantNoOpFrames(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  rule: Rule,
): void {
  const lifecycleStates = new Map<string, ChatTurnState>();
  const providerFrames = new Set<string>();
  const terminalKeys = new Set<string>();

  for (const event of trace) {
    if (event.kind === 'turn-lifecycle') {
      const chat = key(event.target);
      const state = lifecycleStates.get(chat) ?? initialChatTurnState();
      const reduced = reduceChatTurn(state, event.event);
      lifecycleStates.set(chat, reduced.state);
      const replayed =
        state.cursors[
          `${event.event.provider}:${event.event.processEpoch ?? ''}`
        ] !== undefined &&
        event.event.sequence <=
          (state.cursors[
            `${event.event.provider}:${event.event.processEpoch ?? ''}`
          ] ?? -1);
      const sameDecision =
        reducerMeaning(state) === reducerMeaning(reduced.state);
      if (
        replayed ||
        (event.event.type !== 'SessionState' &&
          reduced.effects.length === 0 &&
          sameDecision)
      ) {
        rule.hit(event);
        noOpSnapshotViolation(trace, views, event, chat, rule);
      }
      continue;
    }
    if (event.kind !== 'provider' || event.direction !== 'to-canopy') continue;
    const chat = key(event.target);
    const correlationId =
      event.ids?.callId ??
      event.ids?.requestId ??
      event.ids?.messageUuid ??
      event.ids?.toolUseId;
    const frameIdentity = correlationId
      ? JSON.stringify([
          chat,
          event.provider,
          event.turnKey,
          event.type,
          correlationId,
        ])
      : undefined;
    const replayed =
      frameIdentity !== undefined && providerFrames.has(frameIdentity);
    if (frameIdentity) providerFrames.add(frameIdentity);
    const turnIdentity = event.turnKey
      ? JSON.stringify([chat, event.provider, event.turnKey])
      : undefined;
    const child = event.ids?.toolUseId !== undefined;
    const late = turnIdentity !== undefined && terminalKeys.has(turnIdentity);
    if (child || replayed || late) {
      rule.hit(event);
      noOpSnapshotViolation(trace, views, event, chat, rule);
    }
    if (terminal(event) && turnIdentity) terminalKeys.add(turnIdentity);
  }
}

function dormantForegroundAndWakeLock(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  const turnByChat = new Map<string, PersistedChatTurnState | undefined>();
  const runtimeEventByChat = new Map<string, PipelineTraceEvent>();
  // Session turnActive and the queue gate follow receipt-time state; the
  // persisted turn commits after it (contracts §3).
  const receiptByChat = new Map<string, ChatTurnState>();
  const lifecycleEventByChat = new Map<string, PipelineTraceEvent>();
  const heldByChat = new Map<string, boolean>();
  const holderChats = new Map<string, string>();
  const liveTasks = new Map<string, Set<string>>();
  const activeForeground = (
    turn: PersistedChatTurnState | undefined,
  ): boolean => turn?.phase === 'foreground' && turn.current !== undefined;
  const receiptForeground = (chat: string): boolean =>
    receiptByChat.get(chat)?.current !== undefined;
  // Receipt-time or unacknowledged committed T, or live canonical background,
  // holds power (contracts §4). The receipt's background supersedes the
  // persisted one, which lags it; without a receipt, the persisted one counts.
  const needsLock = (chat: string): boolean => {
    const receipt = receiptByChat.get(chat);
    const persisted = turnByChat.get(chat);
    const background = receipt?.background ?? persisted?.background;
    return (
      activeForeground(persisted) ||
      receipt?.current !== undefined ||
      (background !== undefined &&
        (background.native.length > 0 ||
          background.managed.live > 0 ||
          background.managed.queued > 0)) ||
      (liveTasks.get(chat)?.size ?? 0) > 0
    );
  };
  // Queue busy is canonical admission; `isTurnActive` is host liveness only.
  const admission = (
    chat: string,
    blocked: boolean | undefined,
    event: PipelineTraceEvent,
  ): void => {
    if (blocked === undefined) return;
    rule.hit(event);
    if (receiptForeground(chat) && !blocked)
      rule.fail(
        'Queue admission was open during a receipt-time foreground turn.',
        ...eventIfPresent(lifecycleEventByChat.get(chat)),
        event,
      );
  };

  for (const event of trace) {
    if (event.kind === 'turn-lifecycle') {
      const chat = key(event.target);
      receiptByChat.set(
        chat,
        reduceChatTurn(
          receiptByChat.get(chat) ?? initialChatTurnState(),
          event.event,
        ).state,
      );
      lifecycleEventByChat.set(chat, event);
      continue;
    }

    if (event.kind === 'revision') {
      for (const [chatId, view] of Object.entries(event.chats)) {
        const chat = key({
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId,
        });
        if (view.runtime?.turn !== undefined) {
          turnByChat.set(chat, view.runtime.turn);
          runtimeEventByChat.set(chat, event);
        }
        const turn = turnByChat.get(chat);
        if (view.runtime?.turn !== undefined) {
          rule.hit(event);
          const foreground = activeForeground(turn);
          if ((turn?.phase === 'foreground') !== foreground)
            rule.fail(
              'Foreground phase and persisted current turn disagree.',
              event,
            );
          if (needsLock(chat) && heldByChat.get(chat) !== true)
            rule.fail(
              'Foreground or live background work exists without a held wake lock.',
              event,
            );
        }
      }
      continue;
    }

    if (event.kind === 'effect') {
      const effect = event.effect;
      const chat = event.target ? key(event.target) : undefined;
      if (effect.name === 'native-task-live' && chat) {
        const tasks = liveTasks.get(chat) ?? new Set<string>();
        tasks.add(effect.taskId);
        liveTasks.set(chat, tasks);
        rule.hit(event);
      } else if (effect.name === 'native-task-ended' && chat) {
        liveTasks.get(chat)?.delete(effect.taskId);
        rule.hit(event);
      } else if (effect.name === 'wake-lock-acquire') {
        const holderChat = chat ?? holderChats.get(effect.holder);
        if (holderChat) {
          holderChats.set(effect.holder, holderChat);
          heldByChat.set(holderChat, true);
          rule.hit(event);
        }
      } else if (effect.name === 'wake-lock-release') {
        const holderChat = chat ?? holderChats.get(effect.holder);
        if (!holderChat) continue;
        rule.hit(event);
        if (needsLock(holderChat))
          rule.fail(
            'Wake lock was released while foreground or live background work remained.',
            ...eventIfPresent(runtimeEventByChat.get(holderChat)),
            event,
          );
        heldByChat.set(holderChat, false);
      }
      continue;
    }

    if (event.kind === 'queue') {
      const chat = key(event.event);
      admission(chat, event.admissionBlocked, event);
      if (
        turnByChat.get(chat) !== undefined &&
        needsLock(chat) &&
        heldByChat.get(chat) !== true
      )
        rule.fail('Wake lock was not held while queue reported a turn.', event);
      continue;
    }

    if (event.kind === 'checkpoint' && event.target) {
      const chat = key(event.target);
      if (event.sessionTurnActive !== undefined) {
        rule.hit(event);
        if (event.sessionTurnActive !== receiptForeground(chat))
          rule.fail(
            'Session turnActive disagrees with receipt-time foreground turn state.',
            ...eventIfPresent(lifecycleEventByChat.get(chat)),
            event,
          );
      }
      admission(chat, event.admissionBlocked, event);
      if (
        turnByChat.get(chat) !== undefined &&
        needsLock(chat) &&
        heldByChat.get(chat) !== true
      )
        rule.fail(
          'Foreground or live background work exists without a held wake lock.',
          ...eventIfPresent(runtimeEventByChat.get(chat)),
          event,
        );
    }
  }
}

function dormantReducerMatrix(
  trace: readonly PipelineTraceEvent[],
  fullTrace: readonly PipelineTraceEvent[] | undefined,
  rule: Rule,
): void {
  if (!fullTrace) return;

  const lifecycleSnapshots = (
    events: readonly PipelineTraceEvent[],
  ): Map<
    string,
    {
      event: Extract<PipelineTraceEvent, { kind: 'turn-lifecycle' }>;
      decision: string;
    }
  > => {
    const states = new Map<string, ChatTurnState>();
    const snapshots = new Map<
      string,
      {
        event: Extract<PipelineTraceEvent, { kind: 'turn-lifecycle' }>;
        decision: string;
      }
    >();
    for (const event of events) {
      if (event.kind !== 'turn-lifecycle') continue;
      const chat = key(event.target);
      const before = states.get(chat) ?? initialChatTurnState();
      const reduced = reduceChatTurn(before, event.event);
      states.set(chat, reduced.state);
      const identity = JSON.stringify([
        chat,
        event.event.provider,
        event.event.processEpoch ?? '',
        event.event.sequence,
      ]);
      snapshots.set(identity, {
        event,
        decision: JSON.stringify({
          state: reducerMeaning(reduced.state),
          effects: reduced.effects,
        }),
      });
    }
    return snapshots;
  };

  const boundedLifecycle = lifecycleSnapshots(trace);
  const fullLifecycle = lifecycleSnapshots(fullTrace);
  for (const [identity, bounded] of Array.from(boundedLifecycle.entries())) {
    const full = fullLifecycle.get(identity);
    if (!full) continue;
    rule.hit(bounded.event);
    rule.hit(full.event);
    if (bounded.decision !== full.decision)
      rule.fail(
        'Bounded and full transcript runs reduced the same lifecycle event to different state or effects.',
        bounded.event,
        full.event,
      );
  }

  const fullRevisions = new Map<string, RevisionTraceEvent>();
  for (const event of fullTrace) {
    if (event.kind !== 'revision') continue;
    for (const chatId of Object.keys(event.chats)) {
      const chat = key({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId,
      });
      fullRevisions.set(JSON.stringify([chat, event.revision]), event);
    }
  }

  for (const event of trace) {
    if (event.kind !== 'revision') continue;
    for (const [chatId, boundedView] of Object.entries(event.chats)) {
      const chat = key({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId,
      });
      const paired = fullRevisions.get(JSON.stringify([chat, event.revision]));
      const fullView = paired?.chats[chatId];
      if (!paired || !fullView) continue;
      rule.hit(event);
      rule.hit(paired);
      if (
        JSON.stringify({
          status: boundedView.runtime?.status,
          turn: boundedView.runtime?.turn,
        }) !==
        JSON.stringify({
          status: fullView.runtime?.status,
          turn: fullView.runtime?.turn,
        })
      )
        rule.fail(
          'Bounded and full transcript runs made different persisted turn decisions.',
          event,
          paired,
        );
      const boundedRows = boundedView.rows;
      const fullRows = fullView.rows;
      const boundedAnchors = new Set(
        boundedRows
          ?.filter((row) => timerBlocks(row).length === 0)
          .map((row) => row.id) ?? [],
      );
      const fullAnchors = new Set(
        fullRows
          ?.filter((row) => timerBlocks(row).length === 0)
          .map((row) => row.id) ?? [],
      );
      const sharedAnchors = new Set(
        Array.from(boundedAnchors).filter((id) => fullAnchors.has(id)),
      );
      const boundedPlacement = pairedTimerPlacement(boundedView, sharedAnchors);
      const fullPlacement = pairedTimerPlacement(fullView, sharedAnchors);
      if (
        boundedPlacement !== undefined &&
        fullPlacement !== undefined &&
        JSON.stringify(boundedPlacement) !== JSON.stringify(fullPlacement)
      )
        rule.fail(
          'Bounded and full transcript runs placed the current or settled timer differently.',
          event,
          paired,
        );
    }
  }
  for (const event of trace) {
    if (event.kind !== 'checkpoint' || !event.target) continue;
    const target = event.target;
    const matching = fullTrace.find(
      (candidate) =>
        candidate.kind === 'checkpoint' &&
        candidate.label === event.label &&
        candidate.logicalAt === event.logicalAt &&
        eventKey(candidate) === key(target),
    );
    if (!matching || matching.kind !== 'checkpoint') continue;
    rule.hit(event);
    rule.hit(matching);
    if (
      event.sessionTurnActive !== matching.sessionTurnActive ||
      event.queueTurnActive !== matching.queueTurnActive
    )
      rule.fail(
        'Bounded and full transcript runs made different session or queue gate decisions.',
        event,
        matching,
      );
  }
}

function dormantGateBound(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
  rule: Rule,
): void {
  interface ArmedInterval {
    start: PipelineTraceEvent;
  }
  const reducerStates = new Map<string, ChatTurnState>();
  const activeRootTurns = new Map<string, Set<string>>();
  const gateByChat = new Map<string, boolean>();
  const armedIntervals = new Map<string, ArmedInterval>();
  const runningAtProvider = (chat: string): boolean =>
    reducerStates.get(chat)?.current !== undefined &&
    (activeRootTurns.get(chat)?.size ?? 0) > 0;
  const closeInterval = (chat: string, event: PipelineTraceEvent): void => {
    const interval = armedIntervals.get(chat);
    if (!interval) return;
    if (event.logicalAt - interval.start.logicalAt > context.gateBoundMs)
      rule.fail(
        `Queue gate stayed armed for ${event.logicalAt - interval.start.logicalAt} logical ms without a reduced foreground turn running at the provider; bound is ${context.gateBoundMs} ms.`,
        interval.start,
        event,
      );
    armedIntervals.delete(chat);
  };
  const refreshInterval = (chat: string, event: PipelineTraceEvent): void => {
    if (gateByChat.get(chat) !== true || runningAtProvider(chat)) {
      closeInterval(chat, event);
      return;
    }
    if (!armedIntervals.has(chat)) armedIntervals.set(chat, { start: event });
  };
  const sampleGate = (
    chat: string,
    armed: boolean,
    event: PipelineTraceEvent,
  ): void => {
    rule.hit(event);
    gateByChat.set(chat, armed);
    refreshInterval(chat, event);
  };

  for (const event of trace) {
    if (event.kind === 'revision') {
      continue;
    }
    if (event.kind === 'turn-lifecycle') {
      const chat = key(event.target);
      const state = reducerStates.get(chat) ?? initialChatTurnState();
      reducerStates.set(chat, reduceChatTurn(state, event.event).state);
      rule.hit(event);
      refreshInterval(chat, event);
      continue;
    }
    if (event.kind === 'provider' && event.direction === 'to-canopy') {
      const chat = key(event.target);
      const turnKey = event.turnKey;
      const rootStart =
        event.ids?.toolUseId === undefined &&
        ((event.provider === 'claude' &&
          turnKey !== undefined &&
          !terminal(event)) ||
          (event.provider === 'codex' &&
            event.type === 'notification:turn/started'));
      const rootEnd =
        event.ids?.toolUseId === undefined &&
        ((event.provider === 'claude' && terminal(event)) ||
          (event.provider === 'codex' &&
            event.type === 'notification:turn/completed'));
      const rootIdentity =
        event.provider === 'codex' && (rootStart || rootEnd)
          ? 'codex-root-turn'
          : turnKey;
      if (rootIdentity !== undefined && (rootStart || rootEnd)) {
        const active = activeRootTurns.get(chat) ?? new Set<string>();
        if (rootEnd) active.delete(rootIdentity);
        else active.add(rootIdentity);
        activeRootTurns.set(chat, active);
        rule.hit(event);
        refreshInterval(chat, event);
      }
      continue;
    }
    // The gate is armed while host liveness or canonical admission holds it.
    if (
      event.kind === 'queue' &&
      (event.turnActive !== undefined || event.admissionBlocked !== undefined)
    ) {
      sampleGate(
        key(event.event),
        event.turnActive === true || event.admissionBlocked === true,
        event,
      );
      continue;
    }
    if (
      event.kind === 'checkpoint' &&
      event.target &&
      (event.queueTurnActive !== undefined ||
        event.admissionBlocked !== undefined)
    )
      sampleGate(
        key(event.target),
        event.queueTurnActive === true || event.admissionBlocked === true,
        event,
      );
  }

  const horizon = trace[trace.length - 1];
  if (!horizon) return;
  for (const interval of Array.from(armedIntervals.values())) {
    const age = horizon.logicalAt - interval.start.logicalAt;
    if (age > context.gateBoundMs)
      rule.fail(
        `Queue gate stayed armed for ${age} logical ms without a reduced foreground turn running at the provider; bound is ${context.gateBoundMs} ms.`,
        interval.start,
        horizon,
      );
  }
}

function dormantTurnAuthority(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  type ActiveProviderTurn = {
    start: ProviderTraceEvent;
    /** Resolved at the first observation point after the start frame. */
    resolved: boolean;
    turnId?: string;
    /** A revision has persisted `turnId` as current. */
    persisted: boolean;
  };
  const states = new Map<string, ChatTurnState>();
  const latestLifecycle = new Map<string, PipelineTraceEvent>();
  const latestQueue = new Map<
    string,
    Extract<PipelineTraceEvent, { kind: 'queue' }>
  >();
  const latestPersisted = new Map<string, PersistedChatTurnState>();
  const latestRuntimeEvent = new Map<string, PipelineTraceEvent>();
  const activeProviderTurns = new Map<
    string,
    Map<string, ActiveProviderTurn>
  >();
  // Claude frames carry their turn's key, so a late background frame tagged
  // with an ended turn does not start another (as in `sessionTurns`).
  const completedClaudeTurns = new Map<string, Set<string>>();
  const completeClaudeTurn = (chat: string, turnKey: string): void => {
    if (!turnKey.startsWith('claude:')) return;
    const completed = completedClaudeTurns.get(chat) ?? new Set<string>();
    completed.add(turnKey);
    completedClaudeTurns.set(chat, completed);
  };
  // A stopped turn may end without a root result, so the user's Stop or the
  // session's removal retires it.
  const retire = (chat: string): void => {
    const turns = activeProviderTurns.get(chat);
    for (const turnKey of Array.from(turns?.keys() ?? []))
      completeClaudeTurn(chat, turnKey);
    turns?.clear();
  };
  // A start frame's own lifecycle events follow it in the trace, so its
  // authority is judged at the next revision, checkpoint or root terminal.
  const resolve = (chat: string, at: PipelineTraceEvent): void => {
    for (const turn of Array.from(
      activeProviderTurns.get(chat)?.values() ?? [],
    )) {
      if (turn.resolved) continue;
      turn.resolved = true;
      const current =
        states.get(chat)?.current ?? latestPersisted.get(chat)?.current;
      if (current) turn.turnId = current.id;
      else
        rule.fail(
          `${turn.start.provider} root turn ran without a receipt-time or persisted current turn authority.`,
          turn.start,
          at,
        );
    }
  };
  const sameAuthority = (
    left: PersistedChatTurnState['current'],
    right: ChatTurnState['current'],
  ): boolean =>
    left === undefined || right === undefined
      ? left === right
      : left.id === right.id &&
        left.origin === right.origin &&
        left.userMessageId === right.userMessageId &&
        JSON.stringify(left.inputIds ?? []) ===
          JSON.stringify(right.inputIds ?? []);

  for (const event of trace) {
    const chat = eventKey(event);
    if (event.kind === 'queue') latestQueue.set(key(event.event), event);
    if (event.kind === 'turn-lifecycle') {
      const identity = key(event.target);
      const state = states.get(identity) ?? initialChatTurnState();
      const next = reduceChatTurn(state, event.event).state;
      states.set(identity, next);
      latestLifecycle.set(identity, event);
      rule.hit(event);
      // The reducer's supersede is the authority; persistence follows it.
      if (next.current && next.current.id !== state.current?.id)
        for (const turn of Array.from(
          activeProviderTurns.get(identity)?.values() ?? [],
        ))
          if (turn.resolved && turn.turnId !== undefined) {
            turn.turnId = next.current.id;
            turn.persisted = false;
          }
      continue;
    }

    if (event.kind === 'provider' && chat) {
      const isCodexRootStart =
        event.provider === 'codex' &&
        event.type === 'notification:turn/started';
      const isCodexRootTerminal =
        event.provider === 'codex' &&
        event.type === 'notification:turn/completed';
      // Session-level system frames (init, session state, background tasks)
      // precede or outlive a turn; its own frames start it.
      const isClaudeRootFrame =
        event.provider === 'claude' && !event.type.startsWith('sdk:system:');
      if (
        event.direction !== 'to-canopy' ||
        event.ids?.toolUseId ||
        (!isClaudeRootFrame && !isCodexRootStart && !isCodexRootTerminal)
      )
        continue;
      // Codex turn notifications may lack a separately projected turnKey; the
      // session permits one active root turn per provider, so retain a stable
      // per-chat fallback while ignoring unrelated client initialization.
      const providerTurnKey =
        isCodexRootStart || isCodexRootTerminal
          ? 'codex-root-turn'
          : event.turnKey;
      if (!providerTurnKey) continue;
      const turns =
        activeProviderTurns.get(chat) ?? new Map<string, ActiveProviderTurn>();
      activeProviderTurns.set(chat, turns);
      const activeTurnKey = `${event.provider}:${providerTurnKey}`;
      const isRootTerminal =
        (event.provider === 'claude' && terminal(event)) || isCodexRootTerminal;
      if (isRootTerminal) {
        // Session activity is sampled at checkpoints; a turn with none between
        // its start and terminal has no sample to judge.
        resolve(chat, event);
        if (turns.get(activeTurnKey)?.turnId !== undefined) rule.hit(event);
        turns.delete(activeTurnKey);
        completeClaudeTurn(chat, activeTurnKey);
      } else if (isCodexRootStart || isClaudeRootFrame) {
        if (
          turns.has(activeTurnKey) ||
          completedClaudeTurns.get(chat)?.has(activeTurnKey)
        )
          continue;
        turns.set(activeTurnKey, {
          start: event,
          resolved: false,
          persisted: false,
        });
        rule.hit(event);
      }
      continue;
    }

    if (
      event.kind === 'effect' &&
      event.effect.name === 'session-destroyed' &&
      chat
    ) {
      retire(chat);
      continue;
    }

    if (event.kind === 'checkpoint' && chat) {
      resolve(chat, event);
      if (event.userInitiated === true) retire(chat);
      if (event.label === 'drained') {
        rule.hit(event);
        if (
          !sameAuthority(
            latestPersisted.get(chat)?.current,
            states.get(chat)?.current,
          )
        )
          rule.fail(
            'Persisted runtime.turn current id, source, or input ids did not converge to reduceChatTurn authority by the drained checkpoint.',
            ...eventIfPresent(latestLifecycle.get(chat)),
            ...eventIfPresent(latestRuntimeEvent.get(chat)),
            event,
          );
      }
      const turns = Array.from(
        activeProviderTurns.get(chat)?.values() ?? [],
      ).filter((turn) => turn.turnId !== undefined);
      if (turns.length === 0) continue;
      rule.hit(event);
      if (event.sessionTurnActive !== true)
        rule.fail(
          'Provider root turn did not retain session turn activity through its root terminal.',
          ...turns.map((turn) => turn.start),
          event,
        );
      continue;
    }

    if (event.kind !== 'revision') continue;
    for (const [chatId, view] of Object.entries(event.chats)) {
      const identity = key({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId,
      });
      if (view.runtime === undefined) continue;
      const turn = view.runtime.turn;
      if (turn !== undefined) {
        latestPersisted.set(identity, turn);
        latestRuntimeEvent.set(identity, event);
      }
      resolve(identity, event);
      const current = turn?.current;
      const expected = states.get(identity)?.current;
      for (const providerTurn of Array.from(
        activeProviderTurns.get(identity)?.values() ?? [],
      )) {
        if (providerTurn.turnId === undefined) continue;
        rule.hit(event);
        if (current?.id === providerTurn.turnId) providerTurn.persisted = true;
        // Before its commit a revision may still carry the earlier state; once
        // persisted, the authority must hold while the receipt still has it.
        else if (providerTurn.persisted && expected?.id === providerTurn.turnId)
          rule.fail(
            'Persisted session turn authority changed while a root provider turn was active.',
            providerTurn.start,
            event,
          );
      }
      if (!current) continue;
      rule.hit(event);
      const latest = latestLifecycle.get(identity);
      const queuedIds = new Set<string>([
        ...(latestQueue.get(identity)?.event.queue.map((row) => row.id) ?? []),
        ...(view.runtime.queuedMessageIds ?? []),
        ...(view.runtime.queuedMessages?.map((row) => row.id) ?? []),
      ]);
      const borrowed = [
        ...(current.inputIds ?? []),
        ...(current.userMessageId ? [current.userMessageId] : []),
      ].filter((id) => queuedIds.has(id));
      if (queuedIds.has(current.id) && current.id !== expected?.id)
        borrowed.push(current.id);
      if (borrowed.length > 0) {
        const queueEvent = latestQueue.get(identity);
        rule.fail(
          `Turn-scoped authority borrowed queued message id ${borrowed[0]}.`,
          ...eventIfPresent(queueEvent),
          ...eventIfPresent(latest),
          event,
        );
      }
    }
  }
}

/** Replaying each chat's recorded reducer stream twice must be a no-op. */
function lifecycleReplay(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  const eventsByChat = new Map<
    string,
    Extract<PipelineTraceEvent, { kind: 'turn-lifecycle' }>[]
  >();
  for (const event of trace) {
    if (event.kind !== 'turn-lifecycle') continue;
    rule.hit(event);
    const identity = key(event.target);
    const events = eventsByChat.get(identity) ?? [];
    events.push(event);
    eventsByChat.set(identity, events);
  }

  for (const events of Array.from(eventsByChat.values())) {
    let state = initialChatTurnState();
    for (const event of events) {
      state = reduceChatTurn(state, event.event).state;
    }
    const onceState = state;

    for (let replay = 0; replay < 2; replay += 1) {
      for (const event of events) {
        const before = state;
        const reduced = reduceChatTurn(before, event.event);
        if (
          reduced.effects.length > 0 ||
          !isDeepStrictEqual(reduced.state, before)
        ) {
          rule.fail(
            `Replaying this chat's lifecycle stream changed reducer state or emitted effects on replay ${replay + 1}.`,
            event,
          );
        }
        state = reduced.state;
      }
    }

    if (!isDeepStrictEqual(state, onceState)) {
      const first = events[0];
      if (first) {
        rule.fail(
          `Replaying this chat's lifecycle stream twice changed its final reducer state.`,
          first,
          ...events.slice(1),
        );
      }
    }
  }
}

/**
 * Whether this TurnEnded is the first for its turn. A replayed receipt
 * repeats one and ends no further turn.
 */
function firstTurnEnd(
  target: PipelineChatTarget,
  turnId: string,
  seen: Set<string>,
): boolean {
  const { projectId, worktreeId, chatId } = target;
  const key = JSON.stringify([projectId, worktreeId, chatId, turnId]);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/**
 * Invariant 8, per-turn half: a turn-end effect fires at most once per turn
 * end of its chat. The turn diff is keyed by session key and the code-review
 * hook by worktree. An end between two firings allows the second, so an end
 * observed after its effect still counts.
 */
function perTurnEffects(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  const unended = new Map<string, PipelineTraceEvent>();
  const ended = new Set<string>();
  for (const event of trace) {
    if (event.kind === 'turn-lifecycle' && event.event.type === 'TurnEnded') {
      if (!firstTurnEnd(event.target, event.event.turnId, ended)) continue;
      const { projectId, worktreeId, chatId } = event.target;
      unended.delete(
        JSON.stringify(['turn-diff', `${projectId}/${worktreeId}/${chatId}`]),
      );
      unended.delete(JSON.stringify(['code-review', worktreeId]));
      continue;
    }
    if (event.kind !== 'effect' || event.effect.name !== 'terminal-effect')
      continue;
    rule.hit(event);
    const id = JSON.stringify([event.effect.effect, event.effect.identity]);
    const previous = unended.get(id);
    if (previous)
      rule.fail(
        `The ${event.effect.effect} effect for ${event.effect.identity} fired twice with no turn end between.`,
        previous,
        event,
      );
    unended.set(id, event);
  }
}

/** One turn of a chat that captures turn diffs, for `turnDiffCounts`. */
interface CaptureTurn {
  readonly turnId: string;
  readonly events: PipelineTraceEvent[];
  readonly userMessageIds: Set<string>;
  ended: boolean;
  captured: boolean;
}

/**
 * Invariant 8's per-turn count for the turn diff (turn-state phases 43d and
 * 43e): each turn a capturing chat ended, including one Stop's abort fallback
 * ended, has exactly one capture. A capture belongs to the turn it names: a
 * wake's own turn, else the oldest turn binding its user message, else (a
 * wake reviving that prompt) the oldest turn binding none. So it may land
 * before or after that turn's end, even after the next turn starts, but a
 * duplicate can't stand in for another prompt's missing capture. An unnamed
 * capture, or one naming no turn seen, goes to the oldest started turn still
 * without one.
 */
function turnDiffCounts(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  const turns = new Map<string, Map<string, CaptureTurn>>();
  const strays = new Map<string, PipelineTraceEvent[]>();
  const capturing = new Set<string>();
  for (const event of trace) {
    if (
      event.kind === 'turn-lifecycle' &&
      (event.event.type === 'TurnStarted' || event.event.type === 'TurnEnded')
    ) {
      const { projectId, worktreeId, chatId } = event.target;
      const id = `${projectId}/${worktreeId}/${chatId}`;
      const chatTurns = turns.get(id) ?? new Map<string, CaptureTurn>();
      turns.set(id, chatTurns);
      const turn = chatTurns.get(event.event.turnId) ?? {
        turnId: event.event.turnId,
        events: [],
        userMessageIds: new Set<string>(),
        ended: false,
        captured: false,
      };
      for (const id of event.event.userMessageIds) turn.userMessageIds.add(id);
      chatTurns.set(event.event.turnId, turn);
      // A replayed receipt ends no further turn.
      if (turn.ended) continue;
      turn.events.push(event);
      if (event.event.type === 'TurnEnded') turn.ended = true;
    } else if (
      event.kind === 'effect' &&
      event.effect.name === 'turn-diff-baseline'
    ) {
      capturing.add(event.effect.identity);
    } else if (
      event.kind === 'effect' &&
      event.effect.name === 'terminal-effect' &&
      event.effect.effect === 'turn-diff'
    ) {
      const id = event.effect.identity;
      const named = event.effect.turn;
      const chatTurns = Array.from(turns.get(id)?.values() ?? []);
      const uncaptured = (list: CaptureTurn[]): CaptureTurn | undefined =>
        list.find((turn) => !turn.captured);
      const woken = chatTurns.find((turn) => turn.turnId === named?.wakeTurnId);
      const bound = chatTurns.filter(
        (turn) =>
          named !== undefined && turn.userMessageIds.has(named.userMessageId),
      );
      const owner = woken
        ? uncaptured([woken])
        : bound.length === 0
          ? uncaptured(chatTurns)
          : // A wake revives its prompt's turn, so its capture names the
            // prompt, but the wake's own turn binds no user message.
            (uncaptured(bound) ??
            uncaptured(
              chatTurns.filter((turn) => turn.userMessageIds.size === 0),
            ));
      if (owner) {
        owner.captured = true;
        owner.events.push(event);
      } else {
        strays.set(id, [...(strays.get(id) ?? []), event]);
      }
    }
  }
  const chats = new Set(
    Array.from(turns.keys()).concat(Array.from(strays.keys())),
  );
  for (const id of Array.from(chats)) {
    const chatTurns = Array.from(turns.get(id)?.values() ?? []);
    const extra = strays.get(id) ?? [];
    // A chat that took a baseline captures turn diffs; one that neither took
    // a baseline nor captured doesn't (Cowork, App Advisor).
    if (
      !capturing.has(id) &&
      extra.length === 0 &&
      !chatTurns.some((turn) => turn.captured)
    )
      continue;
    for (const event of chatTurns.flatMap((turn) => turn.events))
      rule.hit(event);
    for (const event of extra) rule.hit(event);
    if (extra.length > 0)
      rule.fail(
        `${id} captured ${String(extra.length)} turn diffs with no started turn awaiting one.`,
        ...extra,
      );
    const missed = chatTurns.filter((turn) => turn.ended && !turn.captured);
    if (missed.length > 0)
      rule.fail(
        `${id} captured no turn diff for ${String(missed.length)} ended turns.`,
        ...missed.flatMap((turn) => turn.events),
      );
  }
}

/**
 * Invariant 8's chat-level half (phase 36a, checked in 43d): a chat's
 * completion is reported only while none of its turns runs, and each turn's
 * completion at most once until the chat ends another turn.
 */
function idleCompletions(
  trace: readonly PipelineTraceEvent[],
  rule: Rule,
): void {
  const running = new Map<string, Set<string>>();
  const reported = new Map<string, Map<string, PipelineTraceEvent>>();
  const ended = new Set<string>();
  for (const event of trace) {
    if (event.kind === 'turn-lifecycle') {
      const chat = key(event.target);
      const turns = running.get(chat) ?? new Set<string>();
      if (event.event.type === 'TurnStarted') turns.add(event.event.turnId);
      else if (event.event.type === 'TurnEnded') {
        turns.delete(event.event.turnId);
        if (firstTurnEnd(event.target, event.event.turnId, ended))
          reported.delete(chat);
      }
      running.set(chat, turns);
      continue;
    }
    if (event.kind !== 'effect' || !event.target) continue;
    if (event.effect.name === 'chat-completion-deferred') {
      // The modal deferred that report; its replay is the one that goes out.
      reported.get(key(event.target))?.delete(event.effect.stamp);
      continue;
    }
    if (event.effect.name !== 'chat-completion-reported') continue;
    rule.hit(event);
    const chat = key(event.target);
    if ((running.get(chat)?.size ?? 0) > 0)
      rule.fail(
        `A completion was reported while a turn of the chat ran.`,
        event,
      );
    const seen = reported.get(chat) ?? new Map<string, PipelineTraceEvent>();
    const previous = seen.get(event.effect.stamp);
    if (previous)
      rule.fail(
        `The completion of ${event.effect.stamp} was reported twice with no turn end between.`,
        previous,
        event,
      );
    seen.set(event.effect.stamp, event);
    reported.set(chat, seen);
  }
}

function watchers(trace: readonly PipelineTraceEvent[], rule: Rule): void {
  const known = new Map<
    string,
    {
      watcherId: string;
      created?: PipelineTraceEvent;
      first: PipelineTraceEvent;
    }
  >();
  for (const event of trace) {
    if (event.kind !== 'effect' || event.effect.name !== 'watcher-registered')
      continue;
    rule.hit(event);
    const effect = event.effect;
    const before = known.get(effect.naturalKey);
    if (
      before &&
      (before.watcherId !== effect.watcherId ||
        (before.created && effect.created))
    )
      rule.fail(
        `Watcher natural key ${effect.naturalKey} changed identity or created twice.`,
        before.created ?? before.first,
        event,
      );
    if (!before)
      known.set(effect.naturalKey, {
        watcherId: effect.watcherId,
        first: event,
        ...(effect.created ? { created: event } : {}),
      });
    else if (effect.created && !before.created) before.created = event;
  }
}

function deliveryLedger(
  trace: readonly PipelineTraceEvent[],
  views: readonly SelectedView[],
  rule: Rule,
): void {
  const settled = new Map<string, PipelineTraceEvent>();
  const cancelling = new Map<string, number>();
  const fallback = new Map<
    string,
    { chat: string; text: string; event: PipelineTraceEvent }
  >();
  for (const entry of views) {
    const ledger = entry.view.inputDelivery;
    for (const row of ledger?.rows ?? []) {
      rule.hit(entry.event);
      for (const attempt of row.attempts) {
        const identity = JSON.stringify([
          entry.key,
          row.id,
          attempt.provider,
          attempt.generation,
          attempt.id,
        ]);
        const current = row.currentAttemptId === attempt.id;
        const before = settled.get(identity);
        if (current && row.state === 'cancelling')
          cancelling.set(identity, entry.event.seq);
        if (before && current && row.state === 'uncertain') {
          // chat-input-delivery-state.ts re-arms uncertainty on new evidence:
          // a lost session or Stop, an unconfirmed withdrawal, or a
          // conflicting or superseded pickup.
          const fresh =
            (cancelling.get(identity) ?? -1) > before.seq ||
            (attempt.pickedUpAt !== undefined &&
              attempt.withdrawnAt !== undefined) ||
            row.attempts.some(
              (other) =>
                other.id !== attempt.id && other.pickedUpAt !== undefined,
            ) ||
            trace.some(
              (event) =>
                event.seq > before.seq &&
                event.seq < entry.event.seq &&
                eventKey(event) === entry.key &&
                ((event.kind === 'effect' &&
                  event.effect.name === 'session-destroyed') ||
                  (event.kind === 'checkpoint' &&
                    event.userInitiated === true)),
            );
          if (fresh) settled.delete(identity);
          else
            rule.fail(
              `Settled delivery attempt ${attempt.id} became uncertain again.`,
              before,
              entry.event,
            );
        }
        const resolved =
          attempt.admittedAt !== undefined ||
          attempt.pickedUpAt !== undefined ||
          attempt.withdrawnAt !== undefined ||
          attempt.completedAt !== undefined ||
          attempt.turnSettledAt !== undefined ||
          row.notDelivered?.attemptId === attempt.id ||
          (current &&
            (['cancelled', 'picked-up'].includes(row.state) ||
              row.ordinaryOnly === true));
        if (resolved && !(current && row.state === 'uncertain') && !before)
          settled.set(identity, entry.event);
      }
      const continuation = row.ordinaryContinuation;
      const owesOrdinary =
        (row.ordinaryOnly === true && row.currentAttemptId !== undefined) ||
        (continuation &&
          continuation.epoch === ledger?.epoch &&
          continuation.attemptId === row.currentAttemptId) ||
        (row.notDelivered !== undefined &&
          row.notDelivered.attemptId === row.currentAttemptId) ||
        (row.state === 'cancelled' &&
          row.attempts.some(
            (attempt) =>
              attempt.id === row.currentAttemptId &&
              attempt.withdrawnAt !== undefined,
          ));
      if (generatedRequest(row.payload) && owesOrdinary) {
        const identity = JSON.stringify([entry.key, row.id]);
        if (!fallback.has(identity))
          fallback.set(identity, {
            chat: entry.key,
            text: row.text,
            event: entry.event,
          });
      }
    }
  }
  for (const { chat, text, event } of Array.from(fallback.values())) {
    const frames = trace.filter(
      (frame) =>
        frame.kind === 'provider' &&
        eventKey(frame) === chat &&
        frame.seq > event.seq &&
        ordinary(frame) &&
        carries(frame, text),
    );
    if (frames.length !== 1)
      rule.fail(
        `Generated input refused or proven not delivered reached the provider as an ordinary prompt ${frames.length} times, expected exactly once.`,
        event,
        ...frames,
      );
  }
}

function evaluate(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
): Evaluation {
  const ordered = [...trace].sort((a, b) => a.seq - b.seq);
  const views = selectedViews(ordered);
  const violations: InvariantViolation[] = [];
  const activation: Evaluation['activation'] = {};
  // One rule per id, so partial and full checks share its activation.
  const rules = new Map<InvariantId, Rule>();
  const rule = (id: InvariantId): Rule => {
    const existing = rules.get(id);
    if (existing) return existing;
    const enforced = ['enabled', 'partial'].includes(
      INVARIANT_STAGING[id].status,
    );
    const evaluated = new Set<number>();
    const created: Rule = {
      hit(event): void {
        if (!enforced) return;
        evaluated.add(event.seq);
        activation[id] = evaluated.size;
      },
      fail(message, ...events): void {
        if (enforced)
          violations.push({
            id,
            message,
            seqs: Array.from(new Set(events.map((event) => event.seq))).sort(
              (a, b) => a - b,
            ),
          });
      },
    };
    rules.set(id, created);
    return created;
  };
  timers(views, rule(1));
  taskSafety(ordered, rule(5), rule(12));
  childResults(ordered, views, rule(9));
  prompts(ordered, views, context, rule(11));
  generatedQueue(ordered, views, context, rule(13));
  privacy(ordered, views, context, rule(14));
  gates(ordered, context, rule(15));
  steers(ordered, context, rule(16));
  transcripts(ordered, rule(17));
  cancellations(ordered, rule(18));
  sessionTurns(ordered, rule(19));
  perTurnEffects(ordered, rule(8));
  turnDiffCounts(ordered, rule(8));
  idleCompletions(ordered, rule(8));
  watchers(ordered, rule(20));
  deliveryLedger(ordered, views, rule(21));
  lifecycleReplay(ordered, rule(7));
  // The full turn-state claims, as enabled by their staging.
  if (context.fullTurnStateClaims !== false) {
    const full = (id: DormantInvariantId): Rule =>
      INVARIANT_STAGING[id].status === 'enabled' ? rule(id) : IGNORED_RULE;
    dormantTimerRows(ordered, views, full(1), full(2));
    dormantSettlements(ordered, views, full(3));
    dormantNoOpFrames(ordered, views, full(4));
    dormantForegroundAndWakeLock(ordered, full(5));
    dormantGateBound(ordered, context, full(15));
    dormantTurnAuthority(ordered, full(19));
  }
  return { violations, activation };
}

const IGNORED_RULE: Rule = { hit: () => undefined, fail: () => undefined };

export function checkInvariants(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
): InvariantViolation[] {
  return evaluate(trace, context).violations;
}

/** Counts distinct evaluated events per enforced rule, including successful comparisons. */
export function invariantActivation(
  trace: readonly PipelineTraceEvent[],
): Partial<Record<InvariantId, number>> {
  return evaluate(trace, {
    secrets: [],
    deliveryBoundMs: Infinity,
    gateBoundMs: Infinity,
    absoluteTiming: false,
  }).activation;
}

/**
 * Explicit full-claim audit for the reducer-backed turn-state invariants.
 * This does not participate in the staged ordinary checker or its activation.
 */
export function checkDormantInvariants(
  trace: readonly PipelineTraceEvent[],
  context: InvariantContext,
  options: DormantInvariantOptions = {},
): DormantInvariantResult {
  const ordered = [...trace].sort((left, right) => left.seq - right.seq);
  const views = selectedViews(ordered);
  const violations: InvariantViolation[] = [];
  const activation: Partial<Record<InvariantId, number>> = {};
  const rules = new Map<DormantInvariantId, Rule>(
    DORMANT_IDS.map((id) => [id, dormantRule(id, activation, violations)]),
  );
  const timer = rules.get(1);
  const foreground = rules.get(2);
  const settled = rules.get(3);
  const noOp = rules.get(4);
  const agreement = rules.get(5);
  const matrix = rules.get(6);
  const gate = rules.get(15);
  const authority = rules.get(19);
  if (
    !timer ||
    !foreground ||
    !settled ||
    !noOp ||
    !agreement ||
    !matrix ||
    !gate ||
    !authority
  )
    return { violations, activation };

  dormantTimerRows(ordered, views, timer, foreground);
  dormantSettlements(ordered, views, settled);
  dormantNoOpFrames(ordered, views, noOp);
  dormantForegroundAndWakeLock(ordered, agreement);
  dormantReducerMatrix(ordered, options.fullTranscriptTrace, matrix);
  dormantGateBound(ordered, context, gate);
  dormantTurnAuthority(ordered, authority);
  return { violations, activation };
}

function short(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined
    ? 'undefined'
    : text.length > 220
      ? `${text.slice(0, 217)}...`
      : text;
}

function excerpt(event: PipelineTraceEvent): string {
  const stamp = `seq=${event.seq} kind=${event.kind} logicalAt=${event.logicalAt} at=${event.at}`;
  switch (event.kind) {
    case 'revision':
      return `${stamp} revision=${event.revision} chat=${Object.keys(event.chats).join(',')} ${Object.entries(
        event.chats,
      )
        .map(
          ([id, view]) =>
            `${id}: rows=${short(view.rows?.map((row) => ({ id: row.id, blocks: row.blocks })))} ledger=${short(view.inputDelivery)} runtime=${short(view.runtime)}`,
        )
        .join(' ')}`;
    case 'provider':
      return `${stamp} chat=${event.target.chatId} type=${event.type} ${event.direction} turn=${event.turnKey ?? '-'} ids=${short(event.ids)} text=${short(event.text)}`;
    case 'turn-lifecycle':
      return `${stamp} chat=${event.target.chatId} provider=${event.event.provider} type=${event.event.type} lifecycle=${short(event.event)}`;
    case 'queue':
      return `${stamp} chat=${event.event.chatId} active=${event.turnActive} admissionBlocked=${event.admissionBlocked} queue=${short(event.event.queue)}`;
    case 'transcript':
      return `${stamp} chat=${event.target.chatId} bytes=${event.committedBytes} sha=${event.sha256} previous=${short(event.previous)}`;
    case 'effect':
      return `${stamp} chat=${event.target?.chatId ?? '*'} type=${event.effect.name} effect=${short(event.effect)}`;
    case 'checkpoint':
      return `${stamp} chat=${event.target?.chatId ?? '*'} type=${event.label} runtime=${short({ liveness: event.liveness, sessionTurnActive: event.sessionTurnActive, queueTurnActive: event.queueTurnActive, admissionBlocked: event.admissionBlocked, userInitiated: event.userInitiated })}`;
  }
}

export function formatViolations(
  violations: readonly InvariantViolation[],
  trace: readonly PipelineTraceEvent[],
): string {
  const lines = violations.flatMap((violation) => [
    `Invariant ${violation.id}: ${INVARIANT_TEXT[violation.id]}`,
    `  ${violation.message}`,
    ...violation.seqs.map((seq) => {
      const event = trace.find((candidate) => candidate.seq === seq);
      return `  ${event ? excerpt(event) : `seq=${seq} (not captured)`}`;
    }),
  ]);
  lines.push('Invariant staging:');
  for (const status of ['enabled', 'partial', 'deferred', 'external']) {
    lines.push(`${status}:`);
    for (const id of IDS) {
      const entry = INVARIANT_STAGING[id];
      if (entry.status === status)
        lines.push(
          `  ${id}: ${entry.reason || `Shipped phases ${entry.introducedBy.join(', ')}.`}${entry.enableAfter ? ` Enable after ${entry.enableAfter}.` : ''}${entry.subclaims.length ? ` Enforced: ${entry.subclaims.join(' ')}` : ''}`,
        );
    }
  }
  return lines.join('\n');
}
