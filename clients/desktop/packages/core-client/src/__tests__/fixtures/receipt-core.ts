import { z } from 'zod';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CanopyErrorPayloadSchema,
  defineCanopyInstruction,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient, type CanopyClient } from '../../index';
import {
  CANONICAL_DEFINITIONS,
  CanonicalCoreError,
  canonicalInitializeResult,
  serveCanonicalCore,
} from './canonical-core';

const INSTRUCTIONS = {
  'core.test.record': CANONICAL_DEFINITIONS.instructions['core.test.record'],
  'core.test.fire': defineCanopyInstruction({
    plane: 'core',
    domain: 'test',
    version: 1,
    placement: 'core-only',
    requiredGrants: [],
    error: CanopyErrorPayloadSchema,
    idempotency: 'none',
    params: z.strictObject({ value: z.number().int() }),
    result: z.strictObject({ fired: z.number().int() }),
  }),
};

export type ReceiptClient = CanopyClient<
  Record<never, never>,
  typeof INSTRUCTIONS,
  Record<never, never>
>;

type Receipt = { fingerprint: string; outcome?: unknown };

/** How the core answers a key it already holds, after W5 `lookupReceipt`. */
const IN_PROGRESS: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'This request is still in progress.',
  retry: { kind: 'same_idempotency_key', delayMs: 500 },
};
const KEY_REUSED: CanopyErrorPayload = {
  kind: 'conflict',
  message: 'This request was already completed with different details.',
  retry: { kind: 'never' },
};

/**
 * One core behind any number of connections, deduplicating keyed requests by
 * W5 receipt rules: a key's first request runs its effect and records its
 * outcome under the request's fingerprint; the same key and fingerprint
 * replays that outcome, a running one is `in-progress`, and a different
 * fingerprint is `key-reused`. Unkeyed requests always run. `loseReply`
 * closes the connection after the effect, before the reply.
 */
export class ReceiptCore {
  readonly effects: { method: string; value: number }[] = [];
  readonly requests: {
    method: string;
    key: string | null;
    connection: number;
  }[] = [];
  readonly servers: CanopyFramedConnection[] = [];
  loseReply = false;
  /** Holds the next effect until the returned gate opens. */
  hold: Promise<void> | null = null;
  private readonly receipts = new Map<string, Receipt>();

  async connect(authorityId = 'authority-1'): Promise<ReceiptClient> {
    const { client: connection, server } = await createInMemoryFramedPair();
    const index = this.servers.push(server) - 1;
    const handle =
      (method: string) =>
      async (raw: Record<string, unknown>): Promise<unknown> => {
        const { _meta, ...params } = raw;
        const key =
          typeof _meta === 'object' && _meta && 'idempotencyKey' in _meta
            ? String(_meta.idempotencyKey)
            : null;
        this.requests.push({ method, key, connection: index });
        const fingerprint = JSON.stringify([method, params]);
        const receipt = key === null ? undefined : this.receipts.get(key);
        if (receipt && receipt.fingerprint !== fingerprint)
          throw new CanonicalCoreError(KEY_REUSED);
        if (receipt && !('outcome' in receipt))
          throw new CanonicalCoreError(IN_PROGRESS);
        if (receipt) return receipt.outcome;
        const running: Receipt = { fingerprint };
        if (key !== null) this.receipts.set(key, running);
        const lose = this.loseReply;
        this.loseReply = false;
        if (lose) server.close();
        const held = this.hold;
        this.hold = null;
        await held;
        const value = Number(params.value);
        this.effects.push({ method, value });
        running.outcome =
          method === 'core.test.fire'
            ? { fired: value }
            : {
                recorded: value,
                label: typeof params.label === 'string' ? params.label : 'none',
              };
        return lose ? new Promise(() => {}) : running.outcome;
      };
    serveCanonicalCore(
      server,
      {
        'core.test.record': handle('core.test.record'),
        'core.test.fire': handle('core.test.fire'),
      },
      {
        initialize: canonicalInitializeResult({
          runtime: { ...canonicalInitializeResult().runtime, authorityId },
          capabilities: {
            operations: Object.keys(INSTRUCTIONS),
            events: [],
            streams: [],
          },
        }),
      },
    );
    return createCanopyClient({
      connection,
      clientName: 'receipt-test',
      clientVersion: '1.0.0',
      definitions: { queries: {}, instructions: INSTRUCTIONS, streams: {} },
    });
  }
}
