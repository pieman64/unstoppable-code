import type { CanopyEvent } from '@canopy/protocol/canopy-core';

import type { CanopyClientStreamFrame } from '../types';
import { rejection } from './client-conformance';
import { createEventsCore, type EventsCore } from './fixtures/events-core';

type Frame = CanopyClientStreamFrame<CanopyEvent, unknown>;

let core: EventsCore;
afterEach(() => core.close());

async function next(frames: AsyncIterator<Frame>): Promise<Frame> {
  const result = await frames.next();
  if (result.done === true) throw new Error('Stream ended without a frame.');
  return result.value;
}

describe('events core fake', () => {
  it('filters by family prefix and scope, replaying the journal to a late subscriber', async () => {
    core = createEventsCore();
    await core.append('core.chat.status', { status: 'idle' }, { chatId: 'a' });
    await core.append('core.chat.status', { status: 'busy' }, { chatId: 'b' });
    await core.append('core.chatter.noise');
    const client = await core.connect();
    expect(client.manifest.has('streams', 'core.events.subscribe')).toBe(true);
    const stream = await client.openStream('core.events.subscribe', {
      families: ['core.chat'],
      scope: { chatId: 'b' },
      cursor: null,
    });
    const frames = stream.frames[Symbol.asyncIterator]();
    const replayed = await next(frames);
    expect(replayed).toMatchObject({
      kind: 'item',
      cursor: { daemonEpoch: 'epoch-1', sequence: 2 },
      item: { payload: { status: 'busy' }, eventId: 'event-epoch-1-2' },
    });
    await core.append('core.chat.status', { status: 'x' }, { chatId: 'a' });
    const live = await core.append('core.chat.done', {}, { chatId: 'b' });
    const item = await next(frames);
    expect(item).toMatchObject({
      kind: 'item',
      cursor: live.cursor,
      item: live,
    });
    expect(core.subscriptions).toEqual([
      { families: ['core.chat'], scope: { chatId: 'b' }, cursor: null },
    ]);
  });

  it('rejects acks that are foreign, backwards, or beyond delivery', async () => {
    core = createEventsCore({ daemonEpoch: 'e1' });
    const client = await core.connect();
    const stream = await client.openStream('core.events.subscribe', {
      families: ['core.'],
    });
    const frames = stream.frames[Symbol.asyncIterator]();
    await core.append('core.a.one');
    await core.append('core.a.two');
    await next(frames);
    const { subscriptionId } = stream.openResult;
    const ack = (
      daemonEpoch: string,
      sequence: number,
    ): Promise<{ acknowledgedCursor: unknown }> =>
      client.instruction('core.events.ack', {
        subscriptionId,
        cursor: { daemonEpoch, sequence },
      });
    await expect(ack('e1', 2)).resolves.toEqual({
      acknowledgedCursor: { daemonEpoch: 'e1', sequence: 2 },
    });
    expect(await rejection(ack('e1', 1))).toMatchObject({
      code: 'core.events.invalidState',
    });
    expect(await rejection(ack('e1', 3))).toMatchObject({
      code: 'core.events.invalidState',
    });
    expect(await rejection(ack('other', 2))).toMatchObject({
      code: 'core.events.revisionConflict',
    });
    expect(core.acknowledgements).toHaveLength(1);
  });

  it.each(['open', 'end'] as const)(
    'answers an expired cursor with snapshotRequired as an %s error',
    async (snapshotRequired) => {
      core = createEventsCore({ snapshotRequired });
      await core.append('core.a.one');
      await core.append('core.a.two');
      core.expireThrough(2);
      const client = await core.connect();
      const opening = client.openStream('core.events.subscribe', {
        families: ['core.a'],
        cursor: { daemonEpoch: 'epoch-1', sequence: 1 },
      });
      if (snapshotRequired === 'open') {
        expect(await rejection(opening)).toMatchObject({
          code: 'core.events.snapshotRequired',
        });
        return;
      }
      const end = await next((await opening).frames[Symbol.asyncIterator]());
      expect(end).toMatchObject({
        kind: 'end',
        outcome: 'error',
        error: { code: 'core.events.snapshotRequired' },
      });
    },
  );
});
