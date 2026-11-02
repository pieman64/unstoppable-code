import {
  chatInputDeliveryFailure,
  chatInputRefusal,
  type ChatInputRefusalCode,
} from '@canopy/protocol/portal/input-delivery';
import { CodexRecoverableProcessExitError } from '../connection';
import { classifyCodexSteerError } from '../steer-refusal';

const SENTINEL = 'payload-sentinel-7f3c';

/** A JSON-RPC error response as the connection surfaces it. */
function rpcError(message: string): Error {
  return new Error(message);
}

/** Mirrors the connection's request deadline error, which is not exported. */
function requestTimeoutError(): Error {
  const error = new Error(
    'Codex app-server did not respond to turn/steer within 30s',
  );
  error.name = 'CodexAppServerRequestTimeoutError';
  return error;
}

describe('classifyCodexSteerError', () => {
  it.each<[string, ChatInputRefusalCode]>([
    ['no active turn to steer', 'no-active-turn'],
    ['expected active turn id `turn-1` but found `turn-2`', 'turn-id-mismatch'],
    ['cannot steer a compact turn', 'compact-turn'],
    ['cannot steer a review turn', 'review-turn'],
    ['active turn uses a different output schema', 'output-schema-mismatch'],
    ['expectedTurnId must not be empty', 'empty-expected-turn-id'],
    ['input must not be empty', 'empty-input'],
    ['Server is draining; retry after reconnecting', 'not-steerable'],
    ['Server overloaded; retry later.', 'not-steerable'],
    ['Not initialized', 'not-steerable'],
    ['Invalid request: missing field `input`', 'not-steerable'],
    ['turn/steer requires experimentalApi capability', 'not-steerable'],
    [
      'remote image URLs are not supported; use an inline data URL instead',
      'not-steerable',
    ],
    ['invalid thread id: bad', 'not-steerable'],
    ['thread not found: thread-1', 'not-steerable'],
    [
      'direct app-server input is not allowed for multi-agent v2 sub-agents',
      'not-steerable',
    ],
    ['failed to load configuration: broken', 'not-steerable'],
    [
      'Input exceeds the maximum length of 1048576 characters.',
      'not-steerable',
    ],
  ])('classifies %j as a refusal', (message, code) => {
    expect(classifyCodexSteerError(rpcError(message))).toEqual({
      kind: 'refusal',
      refusal: chatInputRefusal(code),
    });
  });

  it.each([
    // Codex can raise this after it accepted the input (settings apply).
    'failed to steer turn: internal agent died',
    'no active turn to steer.',
    ' no active turn to steer',
    'expected active turn id turn-1 but found turn-2',
    'cannot steer a turn',
    'Codex app-server process exited',
  ])('keeps unproven %j as a transport error', (message) => {
    expect(classifyCodexSteerError(rpcError(message))).toEqual({
      kind: 'failure',
      failure: chatInputDeliveryFailure('transport-error'),
    });
  });

  it('classifies a thrown non-error as a transport error', () => {
    expect(classifyCodexSteerError('no active turn to steer')).toEqual({
      kind: 'failure',
      failure: chatInputDeliveryFailure('transport-error'),
    });
  });

  it('classifies a recoverable process exit as process-exit', () => {
    expect(
      classifyCodexSteerError(
        new CodexRecoverableProcessExitError('no active turn to steer'),
      ),
    ).toEqual({
      kind: 'failure',
      failure: chatInputDeliveryFailure('process-exit'),
    });
  });

  it('classifies the request deadline as steer-timeout', () => {
    expect(classifyCodexSteerError(requestTimeoutError())).toEqual({
      kind: 'failure',
      failure: chatInputDeliveryFailure('steer-timeout'),
    });
  });

  it('never copies error text into the result', () => {
    const mismatch = classifyCodexSteerError(
      rpcError(
        `expected active turn id \`${SENTINEL}\` but found \`${SENTINEL}\``,
      ),
    );
    expect(mismatch).toEqual({
      kind: 'refusal',
      refusal: chatInputRefusal('turn-id-mismatch'),
    });
    const unknown = classifyCodexSteerError(
      rpcError(`unexpected failure for ${SENTINEL}`),
    );
    const prefixed = classifyCodexSteerError(
      rpcError(`thread not found: ${SENTINEL}`),
    );
    for (const result of [mismatch, unknown, prefixed])
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
