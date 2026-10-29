// The visual preview renderer in a real Electron build: the hidden window, the
// production two-frame structure, measurement, capture, and isolation. Mocked
// unit tests cover the policy and lifecycle logic; these rows prove what only
// a real renderer can (pixels, widths, CSP, navigation, cleanup).
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDesktopShowVisualChat } from './fixtures/show-visual-tool-row.mjs';

test.describe.configure({ mode: 'serial' });

let electronApp;
let userDataDir;
let sink;
let sinkUrl;
const sinkRequests = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  sink = createServer((request, response) => {
    sinkRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('sink');
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  sinkUrl = `http://127.0.0.1:${sink.address().port}`;
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-preview-visual-'));
  seedDesktopShowVisualChat(userDataDir);
  ({ electronApp } = await launchCanopy({ userDataDir }));
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell();
});

test.afterAll(async () => {
  await new Promise((resolve) => sink?.close(resolve));
  if (electronApp) await closeCanopy(electronApp, userDataDir);
  else if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

function preview(input) {
  return electronApp.evaluate(async (_electron, request) => {
    if (typeof globalThis.__CANOPY_E2E_PREVIEW_VISUAL__ !== 'function')
      throw new Error('Missing main preview fixture');
    return globalThis.__CANOPY_E2E_PREVIEW_VISUAL__(request);
  }, input);
}

async function liveWindows() {
  return (await preview({ kind: 'count' })).liveWindows;
}

function appWindowCount() {
  return electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
}

/** RGB at each `[x, y]` of a returned screenshot, decoded in the main process. */
function samplePixels(dataUrl, points) {
  return electronApp.evaluate(
    ({ nativeImage }, input) => {
      const image = nativeImage.createFromDataURL(input.dataUrl);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      return {
        width,
        height,
        pixels: input.points.map(([x, y]) => {
          const index = (y * width + x) * 4;
          // The bitmap is BGRA.
          return [bitmap[index + 2], bitmap[index + 1], bitmap[index]];
        }),
      };
    },
    { dataUrl, points },
  );
}

const RED_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test('captures the whole visual, including content below the first screen', async () => {
  const html = `<!doctype html><html><body>
    <img src="${RED_PIXEL}" style="display:block;width:100px;height:100px">
    <div style="height:1100px;background:rgb(0,128,255)"></div>
    <div style="height:100px;background:rgb(0,200,80)"></div>
    <script>console.log('rendered:' + document.querySelectorAll('div').length)</script>
  </body></html>`;
  const result = await preview({ kind: 'preview', html, width: 720 });
  expect(result.status).toBe('ok');
  expect(result.contentHeight).toBe(1300);
  expect(result.capturedHeight).toBe(1300);
  expect(result.image).toMatchObject({
    mime: 'image/png',
    width: 720,
    height: 1300,
  });
  expect(result.image.dataUrl.startsWith('data:image/png;base64,iVBOR')).toBe(
    true,
  );
  expect(result.console).toContainEqual(
    expect.objectContaining({ level: 'info', message: 'rendered:2' }),
  );
  const sampled = await samplePixels(result.image.dataUrl, [
    [50, 50],
    [360, 600],
    [360, 1250],
  ]);
  expect(sampled).toMatchObject({ width: 720, height: 1300 });
  // The inlined data: image, the tall block, and the block past 1,200 px.
  // Captures follow the display's color profile, so compare which channel
  // dominates rather than exact sRGB values.
  const [red, blue, green] = sampled.pixels;
  expect(red[0]).toBeGreaterThan(200);
  expect(Math.max(red[1], red[2])).toBeLessThan(100);
  expect(blue[2]).toBeGreaterThan(200);
  expect(blue[0]).toBeLessThan(100);
  expect(green[1]).toBeGreaterThan(150);
  expect(Math.max(green[0], green[2])).toBeLessThan(130);
  expect(result.liveWindows).toBe(0);
});

test('measures with the frame height rule at each requested width', async () => {
  const widthDependent = await preview({
    kind: 'measure',
    html: '<div style="aspect-ratio:2/1;background:#888"></div>',
    widths: [360, 520, 720, 960],
    maxHeight: 2000,
  });
  // Each width is really applied: the box is half as tall as it is wide.
  expect(widthDependent).toEqual({
    status: 'ok',
    heights: [
      [360, 180],
      [520, 260],
      [720, 360],
      [960, 480],
    ],
  });

  // A document that fills its frame reports the frame, so the hint is the
  // visual's own maxHeight, as it renders today.
  const fills = await preview({
    kind: 'measure',
    html: '<style>html,body{height:100%}</style><div style="height:100%"></div>',
    widths: [360, 960],
    maxHeight: 640,
  });
  expect(fills.heights).toEqual([
    [360, 640],
    [960, 640],
  ]);

  // Short content in a tall frame reports the content, not the frame.
  const short = await preview({
    kind: 'measure',
    html: '<div style="height:120px"></div>',
    widths: [360, 960],
    maxHeight: 900,
  });
  expect(short.heights).toEqual([
    [360, 120],
    [960, 120],
  ]);
  expect(await liveWindows()).toBe(0);
});

test('uses the requested appearance', async () => {
  const html = '<div style="height:200px"></div>';
  const light = await preview({ kind: 'preview', html, appearance: 'light' });
  const dark = await preview({ kind: 'preview', html, appearance: 'dark' });
  const [lightPixel] = (await samplePixels(light.image.dataUrl, [[10, 10]]))
    .pixels;
  const [darkPixel] = (await samplePixels(dark.image.dataUrl, [[10, 10]]))
    .pixels;
  const luminance = ([r, g, b]) => r + g + b;
  expect(luminance(lightPixel)).toBeGreaterThan(600);
  expect(luminance(darkPixel)).toBeLessThan(200);
});

test('loads allowlisted CDN scripts and nothing else', async () => {
  // A fake CDN on the preview session: only a request that passed the page
  // CSP and the session request policy can reach this handler.
  await electronApp.evaluate(({ session }) => {
    globalThis.__previewCdnRequests = [];
    session
      .fromPartition('visual-preview')
      .protocol.handle('https', (request) => {
        globalThis.__previewCdnRequests.push(request.url);
        return new Response('window.__cdn = (window.__cdn || 0) + 1;', {
          headers: { 'content-type': 'text/javascript' },
        });
      });
  });
  try {
    sinkRequests.length = 0;
    const html = `<!doctype html><html><body>
      <script src="https://cdn.jsdelivr.net/npm/example@1.0.0/index.js"></script>
      <script src="https://evil.example/steal.js"></script>
      <script src="${sinkUrl}/script.js"></script>
      <img src="${sinkUrl}/pixel.png">
      <img src="file:///etc/hosts">
      <link rel="stylesheet" href="${sinkUrl}/style.css">
      <div style="height:100px"></div>
      <script>
        fetch('${sinkUrl}/fetch').catch(() => {});
        try { new WebSocket('${sinkUrl.replace('http', 'ws')}/socket'); } catch {}
        navigator.sendBeacon && navigator.sendBeacon('${sinkUrl}/beacon');
        console.log('cdn:' + (window.__cdn || 0));
      </script>
    </body></html>`;
    const result = await preview({ kind: 'preview', html });
    expect(result.status).toBe('ok');
    expect(result.console).toContainEqual(
      expect.objectContaining({ message: 'cdn:1' }),
    );
    const cdnRequests = await electronApp.evaluate(
      () => globalThis.__previewCdnRequests,
    );
    expect(cdnRequests).toEqual([
      'https://cdn.jsdelivr.net/npm/example@1.0.0/index.js',
    ]);
    // Loopback and file: were refused before any request left the renderer.
    expect(sinkRequests).toEqual([]);
    expect(result.cspViolations.length).toBeGreaterThanOrEqual(4);
    expect(
      result.cspViolations.some((item) => item.blockedUri.startsWith(sinkUrl)),
    ).toBe(true);
  } finally {
    await electronApp.evaluate(({ session }) => {
      session.fromPartition('visual-preview').protocol.unhandle('https');
      delete globalThis.__previewCdnRequests;
    });
  }
});

test('refuses popups and top navigation and still measures the document', async () => {
  const before = await appWindowCount();
  sinkRequests.length = 0;
  const html = `<!doctype html><html><body>
    <div style="height:240px"></div>
    <script>
      try { window.open('${sinkUrl}/popup'); } catch {}
      try { window.top.location.href = '${sinkUrl}/top'; } catch {}
      try { window.parent.location.href = '${sinkUrl}/parent'; } catch {}
    </script>
  </body></html>`;
  const result = await preview({ kind: 'preview', html });
  expect(result.status).toBe('ok');
  expect(result.contentHeight).toBe(240);
  expect(sinkRequests).toEqual([]);
  expect(await appWindowCount()).toBe(before);
  expect(result.liveWindows).toBe(0);
});

test('fails fast, with no request, when a visual navigates itself away', async () => {
  sinkRequests.length = 0;
  const started = Date.now();
  const result = await preview({
    kind: 'preview',
    html: `<div style="height:240px"></div><script>location.href = '${sinkUrl}/self';</script>`,
  });
  // The relay's frame-src policy blocks the load; nothing is left to measure.
  expect(result.status).toBe('error');
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(sinkRequests).toEqual([]);
  expect(result.liveWindows).toBe(0);
});

test('stops a visual that never yields and destroys its window', async () => {
  const started = Date.now();
  const result = await preview({
    kind: 'measure',
    html: '<div style="height:100px"></div><script>for(;;){}</script>',
    widths: [360],
    maxHeight: 400,
  });
  expect(result).toEqual({ status: 'timeout', heights: [] });
  // The measure deadline is 3 s, including the queue.
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(await liveWindows()).toBe(0);
});

test('runs two previews at once, queues one, and reports the rest as busy', async () => {
  const statuses = await electronApp.evaluate(async () => {
    const html = '<div style="height:100px"></div>';
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        globalThis.__CANOPY_E2E_PREVIEW_VISUAL__({ kind: 'preview', html }),
      ),
    );
    return results.map((result) => result.status);
  });
  expect(statuses.filter((status) => status === 'ok')).toHaveLength(3);
  expect(statuses.filter((status) => status === 'busy')).toHaveLength(2);
  expect(await liveWindows()).toBe(0);
});

test('fits a noisy screenshot within a small provider budget', async () => {
  // Per-pixel noise defeats compression, as a photo would.
  const html = `<canvas id="c" width="1600" height="2000" style="display:block"></canvas><script>
    const context = document.getElementById('c').getContext('2d');
    const image = context.createImageData(1600, 2000);
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = (index * 7919) % 256;
      image.data[index + 1] = (index * 104729) % 256;
      image.data[index + 2] = (index * 1299709) % 256;
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  </script>`;
  // The delay histogram shows how long image encoding holds the main thread.
  const measured = await electronApp.evaluate(async (_electron, noisy) => {
    const { monitorEventLoopDelay } =
      process.getBuiltinModule('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const result = await globalThis.__CANOPY_E2E_PREVIEW_VISUAL__({
      kind: 'preview',
      html: noisy,
      width: 1600,
      imageBudgetBytes: 35_328,
    });
    histogram.disable();
    return {
      status: result.status,
      capturedHeight: result.capturedHeight,
      image: result.image
        ? {
            mime: result.image.mime,
            width: result.image.width,
            height: result.image.height,
            bytes: result.image.bytes,
          }
        : null,
      imageOmittedReason: result.imageOmittedReason ?? null,
      timing: result.timing,
      p99Ms: histogram.percentile(99) / 1e6,
      maxMs: histogram.max / 1e6,
    };
  }, html);
  expect(measured.status).toBe('ok');
  expect(measured.capturedHeight).toBe(2000);
  if (measured.image) {
    expect(measured.image.bytes).toBeLessThanOrEqual(35_328);
    expect(measured.image.width).toBeGreaterThanOrEqual(240);
  } else {
    expect(measured.imageOmittedReason).toBeTruthy();
  }
  console.log(
    `[preview-visual] 1600x2000 noisy preview ${JSON.stringify(measured)}`,
  );
  test.info().annotations.push({
    type: 'main-event-loop-delay',
    description: JSON.stringify(measured),
  });
});

test('previews a document at the 4 MiB prepared limit', async () => {
  const padding = 'x'.repeat(4 * 1024 * 1024 - 200);
  const result = await preview({
    kind: 'preview',
    html: `<div style="height:150px"></div><!--${padding}-->`,
  });
  expect(result.status).toBe('ok');
  expect(result.contentHeight).toBe(150);
  expect(result.liveWindows).toBe(0);
});
