import {
  inlineVisualImages,
  validateVisualHtml,
  type VisualPreparationHost,
} from '../prepare-visual-html';
import { readAuthorizedRegularFile } from '../../lib/authorized-file-open';

jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getCanonicalState: () => Promise<{ codexHome: string }>;
  } => ({
    getCanonicalState: (): Promise<{ codexHome: string }> =>
      Promise.resolve({ codexHome: '/codex' }),
  }),
}));

jest.mock('../../lib/authorized-file-open', () => ({
  getAuthorizedFileRoots: jest.fn(() =>
    Promise.resolve({ paths: ['/workspace'] }),
  ),
  readAuthorizedRegularFile: jest.fn(),
}));

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const host: VisualPreparationHost = {
  scope: { projectId: 'project', worktreeId: 'worktree' },
  cwd: '/workspace',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(readAuthorizedRegularFile)
    .mockImplementation((path: string) =>
      path.endsWith('missing.png')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(png),
    );
});

test('validates text and size and strips a leading BOM', () => {
  expect(validateVisualHtml('﻿<p>ok</p>')).toEqual({
    ok: true,
    value: '<p>ok</p>',
  });
  expect(validateVisualHtml('\u0000')).toEqual({
    ok: false,
    error: 'The visual must be a text HTML document, not binary data.',
  });
  expect(validateVisualHtml('x'.repeat(512_001))).toEqual({
    ok: false,
    error:
      'The HTML document must be at most 512,000 UTF-8 bytes. Shorten it and try again.',
  });
});

test('report mode keeps an unreadable reference exactly as written and lists it', async () => {
  const html =
    '<img src="./missing.png"><script>const p = "./missing.png";</script><img src="./ok.png">';
  const result = await inlineVisualImages(html, host, {
    unresolved: 'report',
  });
  if (!result.ok) throw new Error(result.error);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  expect(result.value.html).toBe(
    `<img src="./missing.png"><script>const p = "./missing.png";</script><img src="${dataUrl}">`,
  );
  expect(result.value.unresolvedImagePaths).toEqual(['./missing.png']);
});

test('report mode keeps a refused UNC path verbatim', async () => {
  const html = '<img src="\\\\server\\share\\a.png">';
  const result = await inlineVisualImages(html, host, {
    unresolved: 'report',
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.value.html).toBe(html);
  expect(result.value.unresolvedImagePaths).toEqual([
    '\\\\server\\share\\a.png',
  ]);
  expect(readAuthorizedRegularFile).not.toHaveBeenCalled();
});

test('error mode fails on an unreadable image with the ShowVisual message', async () => {
  const result = await inlineVisualImages('<img src="./missing.png">', host, {
    unresolved: 'error',
  });
  expect(result).toEqual({
    ok: false,
    error:
      'These images could not be read: ./missing.png. Use paths inside the workspace, or remove them.',
  });
});

test.each(['report', 'error'] as const)(
  '%s mode still fails past 32 distinct images',
  async (unresolved) => {
    const html = Array.from(
      { length: 33 },
      (_, index) => `<img src="./i${String(index)}.png">`,
    ).join('');
    const result = await inlineVisualImages(html, host, { unresolved });
    expect(result).toEqual({
      ok: false,
      error:
        'A visual can contain at most 32 distinct local images. Remove some images and try again.',
    });
  },
);

describe('a document that repeats one reference many times', () => {
  const references = 2_000;
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  // Counts the text handed to Buffer.byteLength, so the check does not depend
  // on how fast the machine is.
  async function measuring<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; measured: number }> {
    const byteLength = Buffer.byteLength.bind(Buffer);
    let measured = 0;
    const spy = jest
      .spyOn(Buffer, 'byteLength')
      .mockImplementation((value, encoding) => {
        measured += typeof value === 'string' ? value.length : value.byteLength;
        return byteLength(value, encoding);
      });
    try {
      return { result: await run(), measured };
    } finally {
      spy.mockRestore();
    }
  }

  test('measures each part of the document once, not once per reference', async () => {
    const html = '<img src="./ok.png">'.repeat(references);
    const { result, measured } = await measuring(() =>
      inlineVisualImages(html, host, { unresolved: 'error' }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.html).toBe(`<img src="${dataUrl}">`.repeat(references));
    expect(readAuthorizedRegularFile).toHaveBeenCalledTimes(1);
    expect(measured).toBeLessThanOrEqual(
      4 * (html.length + result.value.html.length),
    );
  });

  test('reads an unreadable image once and keeps every reference to it', async () => {
    const html = '<img src="./missing.png">'.repeat(references);
    const { result, measured } = await measuring(() =>
      inlineVisualImages(html, host, { unresolved: 'report' }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.html).toBe(html);
    expect(result.value.unresolvedImagePaths).toEqual(['./missing.png']);
    expect(readAuthorizedRegularFile).toHaveBeenCalledTimes(1);
    expect(measured).toBeLessThanOrEqual(4 * 2 * html.length);
  });

  test('still fails once the inlined images pass the prepared limit', async () => {
    const image = Buffer.concat([png, Buffer.alloc(300_000)]);
    jest.mocked(readAuthorizedRegularFile).mockResolvedValue(image);
    const result = await inlineVisualImages(
      '<img src="./ok.png">'.repeat(12),
      host,
      { unresolved: 'report' },
    );
    expect(result).toEqual({
      ok: false,
      error:
        'The visual exceeds the 4 MiB prepared-document limit. Downscale images and try again.',
    });
  });

  test('holds the prepared limit to the byte, counting multi-byte text', async () => {
    // 1,500,000 image bytes make a 2,000,022 character data URL.
    jest
      .mocked(readAuthorizedRegularFile)
      .mockResolvedValue(Buffer.concat([png, Buffer.alloc(1_500_000 - 9)]));
    const limit = 4 * 1024 * 1024;
    // '<img src="' and '">' around the URL are 12 bytes; 'é' is 2 bytes.
    const filler = 'é'.repeat((limit - 12 - 2_000_022) / 2);
    const atLimit = await inlineVisualImages(
      `${filler}<img src="./ok.png">`,
      host,
      { unresolved: 'report' },
    );
    if (!atLimit.ok) throw new Error(atLimit.error);
    expect(Buffer.byteLength(atLimit.value.html, 'utf8')).toBe(limit);
    expect(
      await inlineVisualImages(`${filler}x<img src="./ok.png">`, host, {
        unresolved: 'report',
      }),
    ).toEqual({
      ok: false,
      error:
        'The visual exceeds the 4 MiB prepared-document limit. Downscale images and try again.',
    });
  });

  test('counts text outside the basic plane by its UTF-8 size', async () => {
    // 4 bytes each in UTF-8, 2 code units each in the string.
    const filler = '😀'.repeat(1_000);
    const html = `<p>${filler}</p><img src="./ok.png"><p>${filler}</p>`;
    const result = await inlineVisualImages(html, host, {
      unresolved: 'error',
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.html).toBe(
      `<p>${filler}</p><img src="${dataUrl}"><p>${filler}</p>`,
    );
  });
});
