/** Quieter than this reads as silence (room noise, a fan). */
const FLOOR_DB = -55;
/** Louder than this reads as a full bar (raised voice, close to the mic). */
const CEILING_DB = -18;

/**
 * How loud a chunk of 16-bit little-endian mono PCM is, from 0 (silence) to
 * 1 (loud speech), for a live waveform. Loudness is heard on a log scale, so
 * the RMS is mapped through decibels between a noise floor and a ceiling.
 */
export function pcm16Level(buffer: ArrayBuffer): number {
  const samples = Math.floor(buffer.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(buffer);
  let sumOfSquares = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumOfSquares += sample * sample;
  }
  const rms = Math.sqrt(sumOfSquares / samples);
  if (rms === 0) return 0;
  const decibels = 20 * Math.log10(rms);
  const level = (decibels - FLOOR_DB) / (CEILING_DB - FLOOR_DB);
  return Math.min(1, Math.max(0, level));
}
