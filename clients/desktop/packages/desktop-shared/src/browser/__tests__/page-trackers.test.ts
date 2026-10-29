import {
  decodeTrackerWitness,
  encodeTrackerWitness,
  mainWorldTrackerSource,
  TRACKER_KEY_PATTERN,
  trackerKeyFromBytes,
} from '../page-trackers';

describe('tracker keys and the preload witness (E4)', () => {
  it('makes a key from 16 random bytes that the host accepts', () => {
    const key = trackerKeyFromBytes(new Uint8Array(16).fill(171));
    expect(key).toBe(`__canopyPageModelTracker_${'ab'.repeat(16)}`);
    expect(TRACKER_KEY_PATTERN.test(key)).toBe(true);
    expect(() => trackerKeyFromBytes(new Uint8Array(8))).toThrow();
  });

  it('encodes an early witness with its key and a late one without', () => {
    const key = trackerKeyFromBytes(new Uint8Array(16).fill(1));
    expect(encodeTrackerWitness({ early: true, key })).toBe(`E${key}`);
    expect(encodeTrackerWitness({ early: false })).toBe('L');
    expect(decodeTrackerWitness(`E${key}`)).toEqual({ early: true, key });
    expect(decodeTrackerWitness('L')).toEqual({ early: false });
  });

  it.each([
    [undefined],
    [null],
    ['E'],
    ['E__canopyPageModelTracker_short'],
    ['E__canopyPageModelTracker_' + 'G'.repeat(32)],
    ['Lx'],
    [['E', 'key']],
    [{ early: true }],
  ])('treats a malformed witness %p as unknown', (value) => {
    expect(decodeTrackerWitness(value)).toBeUndefined();
  });

  it('names the documents a main-world source installs in', () => {
    expect(mainWorldTrackerSource('k', { documents: 'child' })).toContain(
      'if (child !== true) return;',
    );
    expect(mainWorldTrackerSource('k', { documents: 'top' })).toContain(
      'if (child !== false) return;',
    );
  });
});
