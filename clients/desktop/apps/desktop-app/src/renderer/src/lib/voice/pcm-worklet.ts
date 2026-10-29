/**
 * AudioWorklet processor source as a string. The browser requires the
 * processor to be registered via `audioWorkletNode.addModule(url)` with a
 * URL — we build a Blob URL from this source so we do not need a separate
 * bundled JS entry point.
 *
 * The processor downsamples the incoming Web Audio stream (typically 48 kHz)
 * to 16 kHz mono Int16 PCM and posts each frame chunk back to the main
 * thread as a transferable `ArrayBuffer`. The Swift helper expects little-
 * endian signed 16-bit samples, which is the native byte order on every
 * platform we support.
 */
const PCM_WORKLET_SOURCE = `
class DownsamplePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetSampleRate = 16000;
    this._ratio = sampleRate / this._targetSampleRate;
    this._accumulator = 0;
    this._pending = [];
    this._pendingFrames = 0;
    this._frameSize = 1600; // 100ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this._accumulator += 1;
      if (this._accumulator >= this._ratio) {
        this._accumulator -= this._ratio;
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this._pending.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
        this._pendingFrames += 1;
        if (this._pendingFrames >= this._frameSize) {
          this._flush();
        }
      }
    }
    return true;
  }

  _flush() {
    if (this._pendingFrames === 0) return;
    const buffer = new ArrayBuffer(this._pendingFrames * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this._pendingFrames; i += 1) {
      view.setInt16(i * 2, this._pending[i] | 0, true);
    }
    this.port.postMessage(buffer, [buffer]);
    this._pending = [];
    this._pendingFrames = 0;
  }
}

registerProcessor('canopy-pcm-downsampler', DownsamplePCMProcessor);
`;

let cachedModuleUrl: string | null = null;

/**
 * Build (or return the cached) Blob URL for the worklet source. Revoked
 * automatically when the renderer navigates away because the browser owns
 * the URL lifetime.
 */
export function getPcmWorkletModuleUrl(): string {
  if (cachedModuleUrl) return cachedModuleUrl;
  const blob = new Blob([PCM_WORKLET_SOURCE], {
    type: 'application/javascript',
  });
  cachedModuleUrl = URL.createObjectURL(blob);
  return cachedModuleUrl;
}
