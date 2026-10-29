/**
 * High-quality headless recorder for `*.demo-spec.ts` demo videos.
 *
 * Playwright's built-in `recordVideo` is tuned for test diagnostics: 25 fps,
 * VP8 at 1 Mbit/s with a realtime encoder, and frames scaled to fit 800×800.
 * This recorder listens to the same Chromium screencast but keeps every frame
 * at device-pixel resolution as a lossless-quality JPEG in a temp directory,
 * then encodes offline (no realtime deadline) to a high-bitrate VP8 WebM at a
 * constant frame rate. It works on the harness's hidden Electron windows, so
 * recording stays headless.
 *
 * The encoder is Playwright's bundled ffmpeg (VP8/WebM only), so no extra
 * dependency is needed. `CANOPY_DEMO_FFMPEG` may point at another ffmpeg
 * binary; the output format stays VP8 WebM either way.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { evenPixels, expandFrameTimeline } from './demoMath.mjs';

const require = createRequire(import.meta.url);

/**
 * Resolve the ffmpeg binary used for encoding.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDemoFfmpeg(env = process.env) {
  const override = env.CANOPY_DEMO_FFMPEG?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CANOPY_DEMO_FFMPEG does not exist: ${override}`);
    }
    return override;
  }
  const { registry } = require('playwright-core/lib/server/registry/index');
  const executable = registry.findExecutable('ffmpeg');
  const ffmpegPath = executable?.executablePath();
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error(
      "Playwright's ffmpeg is not installed. Run `npx playwright install ffmpeg` " +
        'or set CANOPY_DEMO_FFMPEG to an ffmpeg binary.',
    );
  }
  return ffmpegPath;
}

/**
 * The color mode the capture runner selected, used to suffix artifact names
 * so light and dark runs never overwrite each other.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'light' | 'dark'}
 */
export function demoColorMode(env = process.env) {
  return env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
}

/**
 * Opaque stand-ins for the macOS `under-window` vibrancy behind the main
 * window's translucent sidebar. Hidden windows have no native material, so
 * without a backdrop the sidebar composites over black and reads as a muddy
 * gray in the recording.
 */
const VIBRANCY_BACKDROP = Object.freeze({
  light: { r: 232, g: 232, b: 232 },
  dark: { r: 36, g: 36, b: 38 },
});

/**
 * @typedef {object} DemoRecordingOptions
 * @property {string} dir output directory (under `.playwright/<slug>/`)
 * @property {string} name artifact base name; the color mode is appended
 * @property {number} [fps] output frame rate (default 30)
 * @property {number} [scale] device pixels per CSS pixel (default 2). The
 *   harness's hidden windows render at 1x; the recorder overrides the device
 *   scale for the duration of the recording so frames are Retina-sharp while
 *   the layout keeps its CSS size.
 * @property {number} [jpegQuality] screencast JPEG quality (default 95)
 * @property {number} [crf] VP8 constant-quality level, lower is better
 *   (default 6)
 * @property {string} [bitrate] VP8 bitrate cap (default `24M`)
 */

/**
 * @typedef {object} DemoRecordingEvent
 * @property {number} atMs offset from the start of the recording
 * @property {string} type
 * @property {string} [label]
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [still] relative path of a still saved for this event
 */

/**
 * Start recording `page`. Call `stop()` before the app closes; it encodes the
 * video and writes `<name>-<mode>.webm`, `<name>-<mode>.timeline.json`, and
 * any step stills.
 *
 * @param {import('@playwright/test').Page} page
 * @param {DemoRecordingOptions} options
 */
export async function startDemoRecording(page, options) {
  const fps = options.fps ?? 30;
  const jpegQuality = options.jpegQuality ?? 95;
  const colorMode = demoColorMode();
  const baseName = `${options.name}-${colorMode}`;
  await mkdir(options.dir, { recursive: true });
  // Re-recording this mode must not leave removed or renamed steps in reports.
  await rm(path.join(options.dir, `${baseName}-steps`), {
    recursive: true,
    force: true,
  });
  await mkdir(path.join(options.dir, `${baseName}-steps`));

  const session = await page.context().newCDPSession(page);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
  const scale = options.scale ?? 2;
  if (scale !== viewport.devicePixelRatio) {
    // Scoped to this CDP session: detaching in stop() restores the window.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: scale,
      mobile: false,
    });
  }
  const backdrop = VIBRANCY_BACKDROP[colorMode];
  await page.evaluate(
    ({ id, color }) => {
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `html { background-color: ${color} !important; }`;
      document.head.appendChild(style);
    },
    {
      id: '__canopy-demo-backdrop',
      color: `rgb(${backdrop.r}, ${backdrop.g}, ${backdrop.b})`,
    },
  );
  const width = evenPixels(viewport.width * scale);
  const height = evenPixels(viewport.height * scale);

  const frameDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-demo-frames-'));
  /** @type {Array<{ frame: string, timestamp: number }>} */
  const frames = [];
  /** @type {Promise<void>[]} */
  const pendingWrites = [];
  /** @type {DemoRecordingEvent[]} */
  const events = [];
  let stillIndex = 0;
  let stopped = false;

  session.on('Page.screencastFrame', (frame) => {
    // Ack first so Chromium keeps streaming while the frame is written.
    session
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => {});
    if (stopped) return;
    const framePath = path.join(
      frameDir,
      `${String(frames.length).padStart(6, '0')}.jpg`,
    );
    frames.push({
      frame: framePath,
      timestamp: frame.metadata.timestamp ?? Date.now() / 1000,
    });
    pendingWrites.push(writeFile(framePath, frame.data, 'base64'));
  });
  // Let the device-scale override and backdrop paint first; otherwise the
  // opening frame is the compositor's stale 1x, backdrop-less frame.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const startSeconds = Date.now() / 1000;
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: jpegQuality,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  const elapsedMs = () => Math.round(Date.now() - startSeconds * 1000);

  return {
    colorMode,
    /**
     * Record a timeline event (clicks, captions, steps).
     *
     * @param {Omit<DemoRecordingEvent, 'atMs'>} event
     */
    mark(event) {
      events.push({ atMs: elapsedMs(), ...event });
    },

    /**
     * Save a full-resolution still of the current state, named for the step,
     * and record it on the timeline. Stills are JPEG so the capture runner's
     * PNG/WebM color-mode copying leaves them alone.
     *
     * @param {string} label
     */
    async still(label) {
      if (stopped) throw new Error('Demo recording already stopped');
      stillIndex += 1;
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      const relative = path.posix.join(
        `${baseName}-steps`,
        `${String(stillIndex).padStart(2, '0')}-${slug || 'step'}.jpg`,
      );
      const stillPath = path.join(options.dir, relative);
      await mkdir(path.dirname(stillPath), { recursive: true });
      // Capture through the recording session so the still carries the same
      // device scale and backdrop as the video.
      const { data } = await session.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 92,
      });
      await writeFile(stillPath, data, 'base64');
      events.push({ atMs: elapsedMs(), type: 'step', label, still: relative });
    },

    /**
     * Stop capturing, encode, and write the artifacts. Safe to call once.
     *
     * @returns {Promise<{ videoPath: string, timelinePath: string, durationMs: number, frameCount: number }>}
     */
    async stop() {
      if (stopped) throw new Error('Demo recording already stopped');
      stopped = true;
      const endSeconds = Date.now() / 1000;
      await session.send('Page.stopScreencast').catch(() => {});
      await session.detach().catch(() => {});
      await Promise.all(pendingWrites);
      const videoPath = path.join(options.dir, `${baseName}.webm`);
      const timelinePath = path.join(options.dir, `${baseName}.timeline.json`);
      try {
        if (frames.length === 0) {
          throw new Error('Demo recording captured no frames');
        }
        const sequence = expandFrameTimeline(frames, {
          startSeconds,
          endSeconds,
          fps,
        });
        const ffmpegPath = resolveDemoFfmpeg();
        await encodeWebm({
          ffmpegPath,
          sequence,
          outputPath: videoPath,
          width,
          height,
          fps,
          crf: options.crf ?? 6,
          bitrate: options.bitrate ?? '24M',
        });
        const frameCount = sequence.reduce(
          (total, entry) => total + entry.repeat,
          0,
        );
        const durationMs = Math.round((frameCount / fps) * 1000);
        await writeFile(
          timelinePath,
          `${JSON.stringify(
            {
              name: options.name,
              colorMode,
              video: path.basename(videoPath),
              width,
              height,
              scale,
              fps,
              durationMs,
              capturedFrames: frames.length,
              encoder: path.basename(ffmpegPath),
              events,
            },
            null,
            2,
          )}\n`,
        );
        return { videoPath, timelinePath, durationMs, frameCount };
      } finally {
        await rm(frameDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.ffmpegPath
 * @param {Array<{ frame: string, repeat: number }>} options.sequence
 * @param {string} options.outputPath
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.fps
 * @param {number} options.crf
 * @param {string} options.bitrate
 */
async function encodeWebm({
  ffmpegPath,
  sequence,
  outputPath,
  width,
  height,
  fps,
  crf,
  bitrate,
}) {
  // Frames can differ in size if the window resizes mid-demo; letterbox every
  // frame into the fixed output size instead of failing the decode.
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;
  const args = [
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    'mjpeg',
    '-i',
    'pipe:0',
    '-an',
    '-vf',
    filter,
    '-c:v',
    'libvpx',
    '-crf',
    String(crf),
    '-b:v',
    bitrate,
    '-qmin',
    '0',
    '-qmax',
    '32',
    '-deadline',
    'good',
    '-cpu-used',
    '2',
    '-threads',
    String(Math.max(1, Math.min(8, os.availableParallelism()))),
    '-r',
    String(fps),
    '-y',
    outputPath,
  ];
  const child = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // A failed encoder is reported through its exit code below; keep a stray
  // EPIPE from becoming an unhandled 'error' event.
  child.stdin.on('error', () => {});
  // `once` rejects on a stdin 'error' (EPIPE when ffmpeg exits early), so a
  // dead encoder fails the write loop instead of hanging on 'drain'.
  const write = async (buffer) => {
    if (!child.stdin.write(buffer)) await once(child.stdin, 'drain');
  };
  try {
    for (const { frame, repeat } of sequence) {
      const buffer = await readFile(frame);
      for (let count = 0; count < repeat; count += 1) await write(buffer);
    }
  } finally {
    child.stdin.end();
  }
  const { code, signal } = await exited;
  if (code !== 0) {
    throw new Error(
      `ffmpeg failed (${signal ?? `exit ${code}`}) encoding ${outputPath}: ${stderr.trim()}`,
    );
  }
}
