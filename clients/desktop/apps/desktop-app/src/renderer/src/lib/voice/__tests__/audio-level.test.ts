import { pcm16Level } from '../audio-level';

function tone(amplitude: number, samples = 320): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples * 2));
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(
      amplitude * 32767 * Math.sin((2 * Math.PI * i) / 32),
    );
    view.setInt16(i * 2, value, true);
  }
  return view.buffer;
}

describe('pcm16Level', () => {
  it('reads silence as zero', () => {
    expect(pcm16Level(tone(0))).toBe(0);
    expect(pcm16Level(new ArrayBuffer(0))).toBe(0);
  });

  it('keeps room noise near the floor', () => {
    expect(pcm16Level(tone(0.002))).toBeLessThan(0.05);
  });

  it('puts ordinary speech in the middle of the range', () => {
    const level = pcm16Level(tone(0.05));
    expect(level).toBeGreaterThan(0.3);
    expect(level).toBeLessThan(0.9);
  });

  it('rises with loudness and tops out at one', () => {
    expect(pcm16Level(tone(0.2))).toBeGreaterThan(pcm16Level(tone(0.05)));
    expect(pcm16Level(tone(1))).toBe(1);
  });
});
