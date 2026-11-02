import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatStateChangedEvent } from '@canopy/desktop-shared/types';
import { createRepositoryTranscriptPortFixture } from '../../__tests__/helpers/repository-transcript-port-fixture';

async function settle(): Promise<void> {
  for (let i = 0; i < 32; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('child stream writes and committed chat state events', () => {
  // The renderer treats a base revision it has not applied as a gap and
  // resyncs the whole scope, remounting every mounted child reader. So child
  // rows committed to a card with state publish their stream revision.
  it('publishes committed child rows as a card stream advance, so later events do not gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-revision-publication-'));
    const fixture = await createRepositoryTranscriptPortFixture(root)();
    const events: ChatStateChangedEvent[] = [];
    const unsubscribe = fixture.service.subscribe((event): void => {
      events.push(event);
    });
    try {
      const target = fixture.ownedTarget('chat', 'd', 1);
      expect((await fixture.port.open({ target })).ok).toBe(true);
      expect(
        (
          await fixture.port.registerGeneration({
            chatId: 'chat',
            delegationId: 'd',
            runGeneration: 1,
            createdAt: 10,
            store: 'stream',
            origin: { kind: 'launch', anchorMessageId: 'delegated-agent-d' },
            executionMode: 'background',
          })
        ).ok,
      ).toBe(true);
      const card = (cardRevision: number): Promise<{ ok: boolean }> =>
        fixture.port.updateCardState({
          target,
          cardRevision,
          cardDraft: {
            version: 2,
            requestedModelId: 'model',
            status: 'running',
            outputTruncated: false,
          },
        });
      expect((await card(1)).ok).toBe(true);
      await fixture.service.commitChildStream(
        fixture.scope,
        {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'd',
          runGeneration: 1,
        },
        'rows-1',
        [
          {
            id: 'child-row-1',
            role: 'assistant',
            timestamp: 11,
            parentBlockId: 'delegated-agent-d',
            delegationSequence: 0,
            itemRevision: 0,
            final: true,
            blocks: [{ type: 'text', text: 'first child row' }],
          },
        ],
      );
      expect((await card(2)).ok).toBe(true);
      await settle();

      const cardEvents = events.filter((event) =>
        event.changes.some(
          (change) => change.type === 'delegation.card_state_updated',
        ),
      );
      // The first card update, the committed rows, the second card update.
      expect(cardEvents).toHaveLength(3);
      const first = events.indexOf(cardEvents[0] ?? events[0]);
      // From the first card update on, every event continues from the last.
      for (let index = first + 1; index < events.length; index++) {
        expect(events[index]?.baseRevision).toBe(events[index - 1]?.revision);
      }
      const rows = cardEvents[1]?.changes.find(
        (change) => change.type === 'delegation.card_state_updated',
      );
      const before = cardEvents[0]?.changes.find(
        (change) => change.type === 'delegation.card_state_updated',
      );
      // The rows keep the card revision and advance the stream revision.
      expect(rows).toMatchObject({ cardRevision: 1 });
      expect(
        rows?.type === 'delegation.card_state_updated' &&
          before?.type === 'delegation.card_state_updated' &&
          rows.streamRevision > before.streamRevision,
      ).toBe(true);
    } finally {
      unsubscribe();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
