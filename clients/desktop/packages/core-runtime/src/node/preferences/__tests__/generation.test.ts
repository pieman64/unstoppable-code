import {
  documentGeneration,
  nextPreferencesGeneration,
  writePreferencesGeneration,
} from '../generation';
import { createLastGoodRefresher } from '../last-good-refresh';
import { MemoryPreferencesDocument } from './fixtures/memory-document';

describe('preference generation qualification (CAN-4471)', () => {
  const refresher = (): ReturnType<typeof createLastGoodRefresher> =>
    createLastGoodRefresher({ error: jest.fn() });

  it("next generation is one above both main's and the record's", async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('generation', '{"version":1,"generation":5}');
    const next = await nextPreferencesGeneration(document, refresher(), 3);
    expect(next).toBe(6);
    await writePreferencesGeneration(document, next);
    expect(document.slots.get('generation')).toBe(
      '{"version":1,"generation":6}',
    );
  });

  it("uses last-good's generation when the record is absent", async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('lastGood', '{"version":1,"generation":7}');
    await expect(
      nextPreferencesGeneration(document, refresher(), 2),
    ).resolves.toBe(8);
  });

  it('refuses an unknown main generation', async () => {
    const document = new MemoryPreferencesDocument();
    await expect(
      nextPreferencesGeneration(document, refresher(), null),
    ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_UNKNOWN' });
    expect(document.installs).toEqual([]);
  });

  it('refuses when the record is unreadable and last-good fails other than ENOENT', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('generation', '{');
    document.readFailures.set(
      'lastGood',
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await expect(
      nextPreferencesGeneration(document, refresher(), 2),
    ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_UNKNOWN' });
    expect(document.installs).toEqual([]);
  });

  it('a torn last-good sets no floor', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('lastGood', '{');
    await expect(
      nextPreferencesGeneration(document, refresher(), 4),
    ).resolves.toBe(5);
  });

  it('refuses an unsafe next generation', async () => {
    const document = new MemoryPreferencesDocument();
    await expect(
      nextPreferencesGeneration(document, refresher(), Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_EXHAUSTED' });
    expect(document.installs).toEqual([]);
  });

  it('an invalid generation is unknown, never zero', () => {
    expect(documentGeneration({ generation: -1 })).toBeNull();
    expect(documentGeneration({})).toBe(0);
  });
});
