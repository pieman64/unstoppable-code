/**
 * Growing outputs on the `chat:event` IPC channel, sent as appends.
 *
 * Two kinds of `chat:event` payloads carry a whole output that keeps growing,
 * so each one costs IPC bytes in proportion to what was already sent:
 *
 * - a running Codex command's `item.updated` event carries its aggregated
 *   output (up to 256 KB);
 * - a delegated child's `canopy_delegation` card event carries its cumulative
 *   transcript.
 *
 * Main encodes those outputs per receiving page ({@link ChatEventOutputEncoder})
 * and the page's preload decodes them before any subscriber sees an event
 * ({@link ChatEventOutputDecoder}): subscribers receive exactly the events
 * main produced. Nothing else changes: main's own consumers, the committed
 * chat state, `chat:state-changed` and persistence never see an encoded event.
 *
 * Both sides read the same events in the same order and apply the same rules
 * ({@link classifyChatEventOutput}), so their per-output state agrees. A page
 * that starts (a new page or a reload) has no state: its decoder first asks
 * main to start over, and an append it cannot apply (sent before main
 * processed that request) is dropped, with that output's next event sent in
 * full. The `epoch` echoed on encoded messages tells the decoder when main
 * has processed its request, so it asks once.
 *
 * Browser-safe: used by Electron main, the preload and the portable
 * CanopyClient adapter (`@canopy/ipc-canopy-client`).
 */
import {
  AppendEncoder,
  AppendReassembler,
  OutputAppendEncoder,
  OutputReassembler,
  listAppendCodec,
  type AppendCodec,
  type ListAppendStep,
  type OutputAppend,
} from './output-append';

/** One `chat:event` payload: a provider or host event for one chat. */
export interface ChatEvent {
  projectId: string;
  worktreeId: string;
  chatId: string;
  data: unknown;
}

/** One encoded text output: its revision, and the append when it is one. */
export interface EncodedTextOutput {
  readonly rev: number;
  /** When present, the payload's field is empty and the text is the base extended by this. */
  readonly append?: Omit<OutputAppend, 'rev'>;
}

/** One encoded item list: its revision, and the append when it is one. */
export interface EncodedListOutput {
  readonly rev: number;
  /** When present, the payload's list holds only the items after the base's first `keep`. */
  readonly append?: Omit<ListAppendStep<unknown>, 'items'> & {
    readonly baseRev: number;
  };
}

/** What an encoded `chat:event` message adds to the event. */
export interface ChatEventOutputDelta {
  /** The receiving page's last reset request main had processed. */
  readonly epoch?: string;
  /** A Codex command's `aggregated_output`. */
  readonly output?: EncodedTextOutput;
  /** A delegated child's `delegation.transcript`. */
  readonly transcript?: EncodedListOutput;
  /** A delegated child's `delegation.snapshot.partialText`. */
  readonly partialText?: EncodedTextOutput;
}

/** A `chat:event` message as sent: a chat event, maybe with an output delta. */
export interface ChatEventMessage extends ChatEvent {
  outputDelta?: ChatEventOutputDelta;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODEX_ITEM_EVENTS = new Set([
  'item.started',
  'item.updated',
  'item.completed',
]);
/** A delegate run in one of these statuses publishes no further progress. */
const SETTLED_DELEGATION_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
]);
/** Codex turn boundaries: no item of the chat streams across them. */
const CODEX_TURN_EVENTS = new Set([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'error',
]);

interface TextPart {
  readonly key: string;
  readonly value: string;
}

interface ListPart {
  readonly key: string;
  readonly value: readonly unknown[];
}

export type ChatEventOutputAction =
  | {
      readonly kind: 'command';
      readonly output: TextPart;
      /** The event with `output` in place of the command's output. */
      readonly rebuild: (output: string) => ChatEvent;
    }
  | {
      readonly kind: 'delegation';
      readonly transcript: ListPart;
      readonly partialText?: TextPart;
      /** A settled run: its card goes in full, then both sides forget it. */
      readonly settled: boolean;
      /** The event with these in place of the transcript and partial text. */
      readonly rebuild: (
        transcript: readonly unknown[],
        partialText: string | undefined,
      ) => ChatEvent;
    }
  | { readonly kind: 'forget'; readonly keys: readonly string[] }
  | { readonly kind: 'forget-chat'; readonly chat: string }
  | { readonly kind: 'none' };

function chatKey(event: ChatEvent): string {
  return JSON.stringify([event.projectId, event.worktreeId, event.chatId]);
}

function belongsToChat(chat: string): (key: string) => boolean {
  // Output keys extend the chat key's array: `["p","w","c",...]`.
  const prefix = `${chat.slice(0, -1)},`;
  return (key) => key.startsWith(prefix);
}

function outputKey(event: ChatEvent, ...rest: unknown[]): string {
  return JSON.stringify([
    event.projectId,
    event.worktreeId,
    event.chatId,
    ...rest,
  ]);
}

function classifyDelegation(
  event: ChatEvent,
  data: JsonRecord,
): ChatEventOutputAction {
  const delegation = data.delegation;
  if (
    !isRecord(delegation) ||
    typeof delegation.delegationId !== 'string' ||
    typeof delegation.runGeneration !== 'number'
  ) {
    return { kind: 'none' };
  }
  const run = [
    'canopy_delegation',
    delegation.delegationId,
    delegation.runGeneration,
  ];
  const transcriptKey = outputKey(event, ...run, 'transcript');
  const partialKey = outputKey(event, ...run, 'partialText');
  const transcript = delegation.transcript;
  const snapshot = delegation.snapshot;
  // A sidecar patch carries only changed items; it is small and not a base.
  if (
    !Array.isArray(transcript) ||
    delegation.transcriptMode === 'patch' ||
    !isRecord(snapshot)
  ) {
    return { kind: 'forget', keys: [transcriptKey, partialKey] };
  }
  const partialText =
    typeof snapshot.partialText === 'string'
      ? { key: partialKey, value: snapshot.partialText }
      : undefined;
  return {
    kind: 'delegation',
    transcript: { key: transcriptKey, value: transcript },
    ...(partialText ? { partialText } : {}),
    settled:
      typeof snapshot.status === 'string' &&
      SETTLED_DELEGATION_STATUSES.has(snapshot.status),
    rebuild: (items, partial) => ({
      ...event,
      data: {
        ...data,
        delegation: {
          ...delegation,
          transcript: items,
          snapshot:
            partial === undefined
              ? snapshot
              : { ...snapshot, partialText: partial },
        },
      },
    }),
  };
}

/**
 * What an event means for its chat's encoded outputs: a Codex command's
 * output update or a delegate card (both encoded), another event of one
 * Codex item (which ends that item's chain), a turn boundary (which ends all
 * of the chat's chains), or nothing.
 */
export function classifyChatEventOutput(
  event: ChatEvent,
): ChatEventOutputAction {
  const data = event.data;
  if (!isRecord(data)) return { kind: 'none' };
  const chat = chatKey(event);
  if (data.type === 'result') return { kind: 'forget-chat', chat };
  if (data.type === 'canopy_delegation') return classifyDelegation(event, data);
  if (data.type !== 'codex' || !isRecord(data.event)) return { kind: 'none' };
  const codexEvent = data.event;
  const type = codexEvent.type;
  if (typeof type !== 'string') return { kind: 'none' };
  if (CODEX_TURN_EVENTS.has(type)) return { kind: 'forget-chat', chat };
  if (!CODEX_ITEM_EVENTS.has(type) || !isRecord(codexEvent.item)) {
    return { kind: 'none' };
  }
  const item = codexEvent.item;
  if (typeof item.id !== 'string') return { kind: 'none' };
  const thread =
    typeof codexEvent.thread_id === 'string' ? codexEvent.thread_id : null;
  const key = outputKey(event, thread, item.id);
  if (
    type === 'item.updated' &&
    item.type === 'command_execution' &&
    typeof item.aggregated_output === 'string'
  ) {
    return {
      kind: 'command',
      output: { key, value: item.aggregated_output },
      rebuild: (output) => ({
        ...event,
        data: {
          ...data,
          event: {
            ...codexEvent,
            item: { ...item, aggregated_output: output },
          },
        },
      }),
    };
  }
  return { kind: 'forget', keys: [key] };
}

/**
 * Transcript items are flat records of strings, numbers and booleans; two are
 * the same when they have the same keys in the same order and equal values.
 * Anything else is never the same, which only sends more items.
 */
function sameFlatRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => {
    if (rightKeys[index] !== key) return false;
    const value = left[key];
    return (
      (value === null || typeof value !== 'object') &&
      typeof value !== 'function' &&
      Object.is(value, right[key])
    );
  });
}

function copyItem(item: unknown): unknown {
  return isRecord(item) ? { ...item } : item;
}

const transcriptCodec: AppendCodec<
  readonly unknown[],
  ListAppendStep<unknown>
> = listAppendCodec<unknown>(sameFlatRecord, copyItem);

interface ChatEventOutputEncoderOptions {
  /** One revision counter for every page main sends to. */
  nextRev(): number;
  /** Notices main's clamp puts in front of a truncated command output. */
  heads: readonly string[];
  /** Outputs of each kind remembered per page; the least recently sent go first. */
  maxItems?: number;
}

/** Main's per-page bound; the decoder keeps more so it never forgets first. */
const DEFAULT_ENCODER_ITEMS = 64;
const DEFAULT_DECODER_ITEMS = 256;

function encodedText(
  encoder: OutputAppendEncoder<string>,
  part: TextPart,
): EncodedTextOutput {
  const encoding = encoder.encode(part.key, part.value);
  if (encoding.kind === 'full') return { rev: encoding.rev };
  const { rev, ...append } = encoding.append;
  return { rev, append };
}

/** Main's encoder for one receiving page. */
export class ChatEventOutputEncoder {
  private readonly commands: OutputAppendEncoder<string>;
  private readonly partialTexts: OutputAppendEncoder<string>;
  private readonly transcripts: AppendEncoder<
    string,
    readonly unknown[],
    ListAppendStep<unknown>
  >;
  private epoch: string | undefined;

  constructor(options: ChatEventOutputEncoderOptions) {
    const maxKeys = options.maxItems ?? DEFAULT_ENCODER_ITEMS;
    const nextRev = (): number => options.nextRev();
    this.commands = new OutputAppendEncoder<string>({
      nextRev,
      heads: options.heads,
      maxKeys,
    });
    this.partialTexts = new OutputAppendEncoder<string>({ nextRev, maxKeys });
    this.transcripts = new AppendEncoder(transcriptCodec, { nextRev, maxKeys });
  }

  /** The message to send for `message`; anything but an output is unchanged. */
  encode(message: ChatEvent): ChatEvent | ChatEventMessage {
    const action = classifyChatEventOutput(message);
    const epoch = this.epoch === undefined ? {} : { epoch: this.epoch };
    switch (action.kind) {
      case 'none':
        return message;
      case 'forget':
        action.keys.forEach((key) => this.forget(key));
        return message;
      case 'forget-chat':
        this.forgetWhere(belongsToChat(action.chat));
        return message;
      case 'command': {
        const output = encodedText(this.commands, action.output);
        return {
          ...(output.append ? action.rebuild('') : message),
          outputDelta: { ...epoch, output },
        };
      }
      case 'delegation':
        return this.encodeDelegation(action, epoch);
    }
  }

  private encodeDelegation(
    action: Extract<ChatEventOutputAction, { kind: 'delegation' }>,
    epoch: { epoch?: string },
  ): ChatEventMessage {
    // A settled run's last card goes in full, so no gap can ever hide it.
    if (action.settled) this.forgetDelegation(action);
    const encoding = this.transcripts.encode(
      action.transcript.key,
      action.transcript.value,
    );
    const partialText = action.partialText
      ? encodedText(this.partialTexts, action.partialText)
      : undefined;
    if (action.settled) this.forgetDelegation(action);
    const transcript: EncodedListOutput =
      encoding.kind === 'append'
        ? {
            rev: encoding.append.rev,
            append: {
              baseRev: encoding.append.baseRev,
              baseLength: encoding.append.baseLength,
              keep: encoding.append.keep,
            },
          }
        : { rev: encoding.rev };
    return {
      ...action.rebuild(
        encoding.kind === 'append'
          ? encoding.append.items
          : action.transcript.value,
        partialText?.append ? '' : action.partialText?.value,
      ),
      outputDelta: {
        ...epoch,
        transcript,
        ...(partialText ? { partialText } : {}),
      },
    };
  }

  /** `message` was not delivered: its outputs' next events go in full. */
  discard(message: ChatEvent): void {
    const action = classifyChatEventOutput(message);
    if (action.kind === 'forget')
      action.keys.forEach((key) => this.forget(key));
    if (action.kind === 'command') this.forget(action.output.key);
    if (action.kind === 'delegation') this.forgetDelegation(action);
  }

  private forgetDelegation(
    action: Extract<ChatEventOutputAction, { kind: 'delegation' }>,
  ): void {
    this.forget(action.transcript.key);
    if (action.partialText) this.forget(action.partialText.key);
  }

  /** The page started over (`epoch` names its request): send every output in full. */
  reset(epoch: string): void {
    this.forgetWhere(() => true);
    this.epoch = epoch;
  }

  private forget(key: string): void {
    this.commands.forget(key);
    this.partialTexts.forget(key);
    this.transcripts.forget(key);
  }

  private forgetWhere(predicate: (key: string) => boolean): void {
    this.commands.forgetWhere(predicate);
    this.partialTexts.forgetWhere(predicate);
    this.transcripts.forgetWhere(predicate);
  }
}

interface ChatEventOutputDecoderOptions {
  /**
   * Ask main to send every output in full from now on. A rejected request
   * lets the next undecodable append ask again.
   */
  requestReset(epoch: string): Promise<void>;
  /** A fresh request id, unique to this page. */
  newEpoch(): string;
  /** Outputs of each kind remembered; keep it above main's per-page bound. */
  maxItems?: number;
}

type Decoded<Value> =
  | { readonly status: 'applied'; readonly value: Value }
  | { readonly status: 'duplicate' }
  | { readonly status: 'gap' };

/**
 * A page's decoder. Creating one asks main to start over, so a new page never
 * depends on what an earlier page received.
 */
export class ChatEventOutputDecoder {
  private readonly commands: OutputReassembler<string>;
  private readonly partialTexts: OutputReassembler<string>;
  private readonly transcripts: AppendReassembler<
    string,
    readonly unknown[],
    ListAppendStep<unknown>
  >;
  /** The reset request main has not yet confirmed, if any. */
  private awaiting: string | undefined;

  constructor(private readonly options: ChatEventOutputDecoderOptions) {
    const maxKeys = options.maxItems ?? DEFAULT_DECODER_ITEMS;
    this.commands = new OutputReassembler<string>({ maxKeys });
    this.partialTexts = new OutputReassembler<string>({ maxKeys });
    this.transcripts = new AppendReassembler(transcriptCodec, { maxKeys });
    this.requestReset();
  }

  /**
   * The event main produced for `message`, or `undefined` when it cannot be
   * rebuilt (an append whose base this page does not hold, or a duplicate).
   */
  decode(message: ChatEventMessage): ChatEvent | undefined {
    const { outputDelta, ...event } = message;
    if (outputDelta !== undefined && outputDelta.epoch === this.awaiting) {
      this.awaiting = undefined;
    }
    const action = classifyChatEventOutput(event);
    switch (action.kind) {
      case 'none':
        return event;
      case 'forget':
        action.keys.forEach((key) => this.forget(key));
        return event;
      case 'forget-chat':
        this.forgetWhere(belongsToChat(action.chat));
        return event;
      case 'command':
        return this.decodeCommand(event, action, outputDelta);
      case 'delegation':
        return this.decodeDelegation(event, action, outputDelta);
    }
  }

  private decodeCommand(
    event: ChatEvent,
    action: Extract<ChatEventOutputAction, { kind: 'command' }>,
    delta: ChatEventOutputDelta | undefined,
  ): ChatEvent | undefined {
    const output = this.text(this.commands, action.output, delta?.output);
    if (output.status !== 'applied') return this.unusable(output);
    return delta?.output?.append ? action.rebuild(output.value) : event;
  }

  private decodeDelegation(
    event: ChatEvent,
    action: Extract<ChatEventOutputAction, { kind: 'delegation' }>,
    delta: ChatEventOutputDelta | undefined,
  ): ChatEvent | undefined {
    const transcript = this.list(action.transcript, delta?.transcript);
    const partialText = action.partialText
      ? this.text(this.partialTexts, action.partialText, delta?.partialText)
      : undefined;
    if (action.settled) {
      this.forget(action.transcript.key);
      if (action.partialText) this.forget(action.partialText.key);
    }
    if (transcript.status !== 'applied') return this.unusable(transcript);
    if (partialText !== undefined && partialText.status !== 'applied') {
      return this.unusable(partialText);
    }
    if (
      delta?.transcript?.append === undefined &&
      delta?.partialText?.append === undefined
    ) {
      return event;
    }
    return action.rebuild(transcript.value, partialText?.value);
  }

  /** A text output: a full value is kept as the base; an append is applied. */
  private text(
    reassembler: OutputReassembler<string>,
    part: TextPart,
    encoded: EncodedTextOutput | undefined,
  ): Decoded<string> {
    if (encoded?.append === undefined) {
      reassembler.full(part.key, part.value, encoded?.rev);
      return { status: 'applied', value: part.value };
    }
    return reassembler.apply(part.key, { ...encoded.append, rev: encoded.rev });
  }

  private list(
    part: ListPart,
    encoded: EncodedListOutput | undefined,
  ): Decoded<readonly unknown[]> {
    if (encoded?.append === undefined) {
      this.transcripts.full(part.key, part.value, encoded?.rev);
      return { status: 'applied', value: part.value };
    }
    return this.transcripts.apply(part.key, {
      ...encoded.append,
      items: part.value,
      rev: encoded.rev,
    });
  }

  /** Drop an event that cannot be rebuilt; a gap asks main to start over. */
  private unusable(result: {
    readonly status: 'duplicate' | 'gap';
  }): undefined {
    if (result.status === 'gap' && this.awaiting === undefined) {
      this.requestReset();
    }
    return undefined;
  }

  private forget(key: string): void {
    this.commands.forget(key);
    this.partialTexts.forget(key);
    this.transcripts.forget(key);
  }

  private forgetWhere(predicate: (key: string) => boolean): void {
    this.commands.forgetWhere(predicate);
    this.partialTexts.forgetWhere(predicate);
    this.transcripts.forgetWhere(predicate);
  }

  private requestReset(): void {
    const epoch = this.options.newEpoch();
    this.awaiting = epoch;
    this.options.requestReset(epoch).catch(() => {
      if (this.awaiting === epoch) this.awaiting = undefined;
    });
  }
}
