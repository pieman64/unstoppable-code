import type {
  AgentDelegationResult,
  DelegateOutputContentErrorCode,
  DelegateOutput,
  DelegateOutputAnswerPage,
  DelegateSettledStatus,
  GetDelegateOutputValue,
} from '@canopy/protocol/delegation';
import { DELEGATION_NOT_DESCENDANT_ERROR } from '@canopy/protocol/delegation';
import { Buffer } from 'node:buffer';
import type {
  DelegationTranscriptContentRange,
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptResultEntry,
} from './transcript-port';

/** Get Delegate Output paging (phase 11c2). Types and texts are frozen; bodies land in S1. */

export const DELEGATE_OUTPUT_PAGE_MIN_LIMIT = 4;
export const DELEGATE_OUTPUT_PAGE_MAX_LIMIT = 65_536;

/** Sent with every page that has a `nextOffset`. */
export const DELEGATE_OUTPUT_CONTINUATION_NOTICE =
  'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.';

/** Fixed public messages; port and host messages are never copied. */
export const DELEGATE_OUTPUT_CONTENT_ERROR_MESSAGES: Readonly<
  Record<DelegateOutputContentErrorCode, string>
> = Object.freeze({
  answer_unavailable: "The delegate's answer is not available.",
  corruption: "The delegate's stored answer could not be read.",
  not_found: "The delegate's result was not found.",
  storage_failure:
    "The delegate's answer could not be read right now. Try again.",
});

export const DELEGATE_OUTPUT_UNRECOVERABLE_MESSAGE =
  "The delegate's result could not be read right now.";
export const DELEGATE_OUTPUT_INVARIANT_MESSAGE =
  "The delegate's result could not be read.";

export type DelegateOutputDelivery =
  | { readonly kind: 'whole' }
  | { readonly kind: 'range'; readonly offset: number; readonly limit: number };

export type RegistryBodyRead =
  /** The answer kind is none, empty or lost: no range call. */
  | { readonly kind: 'skipped' }
  /** Every page joined, for a no-range delivery. */
  | {
      readonly kind: 'whole';
      readonly text: string;
      readonly encoding: 'utf8' | 'utf16le';
      readonly byteLength: number;
    }
  /** One range at `delivery.offset`. */
  | { readonly kind: 'range'; readonly range: DelegationTranscriptContentRange }
  | {
      readonly kind: 'failed';
      readonly code: DelegationTranscriptPortErrorCode;
    };

/** Execution metadata the bounded record holds for one result; never borrowed from another generation. */
export interface LocalResultLocator {
  readonly resultIndex: number;
  readonly runGeneration: number;
  readonly status: DelegateSettledStatus;
}

export type RegistryOutputRead =
  | {
      readonly kind: 'entry';
      readonly entry: DelegationTranscriptResultEntry;
      readonly body: RegistryBodyRead;
    }
  /** No entry was obtained; `known` only when the record holds this index's locator. */
  | {
      readonly kind: 'lookup_failed';
      readonly code: DelegationTranscriptPortErrorCode;
      readonly known?: LocalResultLocator;
    };

export interface RegistryOutputContext {
  readonly delivery: DelegateOutputDelivery;
  /** The pinned index, chosen once per request. */
  readonly requestedResultIndex: number;
  readonly current: Pick<
    GetDelegateOutputValue,
    | 'delegationId'
    | 'currentRunGeneration'
    | 'currentStatus'
    | 'latestResultIndex'
    | 'currentPhase'
    | 'queue'
  >;
}

/**
 * Projects a stream-backed result read from the registry onto the public
 * reply (plan C8). Phase 11c3 calls it; 11c2 has no registry I/O.
 */
export function projectRegistryDelegateOutput(
  read: RegistryOutputRead,
  context: RegistryOutputContext,
): AgentDelegationResult<GetDelegateOutputValue> {
  if (read.kind === 'lookup_failed') {
    if (
      read.known !== undefined &&
      read.known.resultIndex !== context.requestedResultIndex
    ) {
      return invariantFailure();
    }
    if (read.code === 'unauthorized') {
      return { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
    }
    if (read.code === 'invalid_request') {
      return unavailableIndexFailure();
    }
    if (read.code === 'not_found' && read.known === undefined) {
      return unavailableIndexFailure();
    }
    const contentError = mapContentError(read.code);
    if (read.known === undefined) {
      return {
        ok: false,
        error: {
          code: 'runtime_error',
          message: DELEGATE_OUTPUT_UNRECOVERABLE_MESSAGE,
          retryable: contentError.retryable,
        },
      };
    }
    return {
      ok: true,
      value: projectOutputValue(context.current, {
        resultIndex: read.known.resultIndex,
        runGeneration: read.known.runGeneration,
        status: read.known.status,
        outputTruncated: false,
        contentError,
      }),
    };
  }

  const { entry, body } = read;
  if (entry.resultIndex !== context.requestedResultIndex) {
    return invariantFailure();
  }
  if (!isValidBodyForDelivery(entry.answer, body, context.delivery)) {
    return invariantFailure();
  }

  const resultBody: Pick<
    DelegateOutput,
    'finalText' | 'partialText' | 'answer' | 'contentError'
  > =
    entry.answer.kind === 'none'
      ? {}
      : entry.answer.kind === 'empty'
        ? context.delivery.kind === 'whole'
          ? entry.answer.role === 'final'
            ? { finalText: '' }
            : { partialText: '' }
          : {
              answer: {
                role: entry.answer.role,
                text: '',
                encoding: 'utf8',
                byteLength: 0,
                offset: 0,
              },
            }
        : entry.answer.kind === 'lost'
          ? {
              contentError: {
                code: 'answer_unavailable',
                message:
                  DELEGATE_OUTPUT_CONTENT_ERROR_MESSAGES.answer_unavailable,
                retryable: false,
              },
            }
          : body.kind === 'failed'
            ? { contentError: mapContentError(body.code) }
            : body.kind === 'whole'
              ? entry.answer.role === 'final'
                ? { finalText: body.text }
                : { partialText: body.text }
              : body.kind === 'range' && context.delivery.kind === 'range'
                ? {
                    answer: rangeAnswer(
                      entry.answer.role,
                      context.delivery.offset,
                      body.range,
                    ),
                  }
                : {};

  if (
    entry.answer.kind === 'none' &&
    context.delivery.kind === 'range' &&
    context.delivery.offset !== 0
  ) {
    return invalidRequestFailure();
  }
  if (
    entry.answer.kind === 'empty' &&
    context.delivery.kind === 'range' &&
    context.delivery.offset !== 0
  ) {
    return invalidRequestFailure();
  }
  if (body.kind === 'failed') {
    if (body.code === 'unauthorized') {
      return { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
    }
    if (body.code === 'invalid_request') {
      return invalidReadFailure();
    }
  }

  const result: DelegateOutput = {
    resultIndex: entry.resultIndex,
    runGeneration: entry.runGeneration,
    status: entry.outcome.status,
    ...(resultBody.finalText === undefined
      ? {}
      : { finalText: resultBody.finalText }),
    ...(resultBody.partialText === undefined
      ? {}
      : { partialText: resultBody.partialText }),
    outputTruncated: false,
    ...(entry.outcome.error === undefined
      ? {}
      : { error: entry.outcome.error }),
    ...(entry.outcome.usage === undefined
      ? {}
      : { usage: entry.outcome.usage }),
    ...(resultBody.contentError === undefined
      ? {}
      : { contentError: resultBody.contentError }),
    ...(resultBody.answer === undefined ? {} : { answer: resultBody.answer }),
  };
  return { ok: true, value: projectOutputValue(context.current, result) };
}

function projectOutputValue(
  current: RegistryOutputContext['current'],
  result: DelegateOutput | null,
): GetDelegateOutputValue {
  return {
    delegationId: current.delegationId,
    currentRunGeneration: current.currentRunGeneration,
    currentStatus: current.currentStatus,
    latestResultIndex: current.latestResultIndex,
    result,
    ...(current.currentPhase === undefined
      ? {}
      : { currentPhase: current.currentPhase }),
    ...(current.queue === undefined ? {} : { queue: current.queue }),
  };
}

/** Builds a legacy answer page using the encoding selected for the whole text. */
export function pageLegacyDelegateText(
  text: string,
  role: 'final' | 'partial',
  offset: number,
  limit: number,
): AgentDelegationResult<DelegateOutputAnswerPage> {
  if (!isValidRangeRequest(offset, limit)) {
    return invalidRequestFailure();
  }

  const encoding = hasLoneSurrogate(text) ? 'utf16le' : 'utf8';
  const byteLength = Buffer.byteLength(text, encoding);
  if (offset > byteLength) {
    return invalidRequestFailure();
  }

  let position = 0;
  let pageText = '';
  let pageBytes = 0;
  let offsetIsBoundary = offset === 0 || offset === byteLength;

  for (const character of text) {
    const characterBytes = encodedCharacterLength(character, encoding);
    if (position === offset) {
      offsetIsBoundary = true;
    } else if (position < offset && position + characterBytes > offset) {
      return invalidRequestFailure();
    }

    if (position >= offset) {
      if (pageBytes + characterBytes > limit) {
        break;
      }
      pageText += character;
      pageBytes += characterBytes;
    }
    position += characterBytes;
  }
  if (!offsetIsBoundary) {
    return invalidRequestFailure();
  }

  const nextOffset = offset + pageBytes;
  return {
    ok: true,
    value: {
      role,
      text: pageText,
      encoding,
      byteLength,
      offset,
      ...(nextOffset < byteLength
        ? { nextOffset, notice: DELEGATE_OUTPUT_CONTINUATION_NOTICE }
        : {}),
    },
  };
}

/** Projects one legacy inline result into a range reply without changing other field order. */
export function projectLegacyDelegateOutput(
  output: DelegateOutput,
  offset: number,
  limit: number,
): AgentDelegationResult<DelegateOutput> {
  let role: 'final' | 'partial' | undefined;
  let text: string | undefined;
  if (output.finalText !== undefined) {
    role = 'final';
    text = output.finalText;
  } else if (output.partialText !== undefined) {
    role = 'partial';
    text = output.partialText;
  }
  const {
    finalText: _finalText,
    partialText: _partialText,
    answer: _previousAnswer,
    ...rest
  } = output;
  void _finalText;
  void _partialText;
  void _previousAnswer;
  if (role === undefined || text === undefined) {
    if (!isValidRangeRequest(offset, limit) || offset !== 0) {
      return invalidRequestFailure();
    }
    return { ok: true, value: rest };
  }
  const page = pageLegacyDelegateText(text, role, offset, limit);
  if (!page.ok) {
    return { ok: false, error: page.error };
  }
  return { ok: true, value: { ...rest, answer: page.value } };
}

function encodedCharacterLength(
  character: string,
  encoding: 'utf8' | 'utf16le',
): number {
  if (encoding === 'utf16le') {
    return character.length * 2;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  return codePoint <= 0xffff ? 3 : 4;
}

function isValidBodyForDelivery(
  answer: DelegationTranscriptResultEntry['answer'],
  body: RegistryBodyRead,
  delivery: DelegateOutputDelivery,
): boolean {
  if (answer.kind !== 'body') {
    return body.kind === 'skipped';
  }
  if (body.kind === 'failed') {
    return true;
  }
  if (delivery.kind === 'whole') {
    return body.kind === 'whole' && body.byteLength === answer.byteLength;
  }
  return body.kind === 'range' && body.range.encoding === answer.encoding;
}

function rangeAnswer(
  role: 'final' | 'partial',
  offset: number,
  range: DelegationTranscriptContentRange,
): DelegateOutputAnswerPage {
  return {
    role,
    text: range.text,
    encoding: range.encoding,
    byteLength: range.byteLength,
    offset,
    ...(range.nextOffset === undefined
      ? {}
      : {
          nextOffset: range.nextOffset,
          notice: DELEGATE_OUTPUT_CONTINUATION_NOTICE,
        }),
  };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidRangeRequest(offset: number, limit: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(limit) &&
    limit >= DELEGATE_OUTPUT_PAGE_MIN_LIMIT &&
    limit <= DELEGATE_OUTPUT_PAGE_MAX_LIMIT
  );
}

function mapContentError(code: DelegationTranscriptPortErrorCode): {
  readonly code: DelegateOutputContentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
} {
  const contentCode =
    code === 'not_found'
      ? 'not_found'
      : code === 'corruption' || code === 'conflict'
        ? 'corruption'
        : code === 'storage_failure' || code === 'stale_identity'
          ? 'storage_failure'
          : 'answer_unavailable';
  return {
    code: contentCode,
    message: DELEGATE_OUTPUT_CONTENT_ERROR_MESSAGES[contentCode],
    retryable: contentCode === 'storage_failure',
  };
}

function invalidRequestFailure<T>(): AgentDelegationResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'The requested answer range is not available.',
      retryable: false,
    },
  };
}

function invalidReadFailure<T>(): AgentDelegationResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: DELEGATE_OUTPUT_INVARIANT_MESSAGE,
      retryable: false,
    },
  };
}

function unavailableIndexFailure<T>(): AgentDelegationResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Result index is not available.',
      retryable: false,
    },
  };
}

function invariantFailure<T>(): AgentDelegationResult<T> {
  return {
    ok: false,
    error: {
      code: 'runtime_error',
      message: DELEGATE_OUTPUT_INVARIANT_MESSAGE,
      retryable: false,
    },
  };
}
