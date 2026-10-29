import type { PreparedVisual } from '../browser/visual-preview-types';
import { isAbsolute, join, resolve } from 'node:path';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  VISUAL_HTML_MAX_BYTES,
  VISUAL_PREPARED_MAX_BYTES,
} from '@canopy/agent-transcript/lib/visual-ref';
import {
  getAuthorizedFileRoots,
  readAuthorizedRegularFile,
  type AuthorizedFileRoots,
} from '../lib/authorized-file-open';

/** Trusted session authority for reading workspace images; never tool input. */
export interface VisualPreparationHost {
  scope: { projectId: string; worktreeId: string };
  cwd: string;
}

export type VisualPreparationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_REFERENCE =
  /(["'`])([^"'`]*?\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg))\1|url\(\s*([^\s"'()]+\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg))\s*\)/gi;

function isText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0 ||
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    )
      return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff)
        return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// An optional XML declaration, then comments and an SVG DOCTYPE (with an
// optional internal subset) before the root. The bytes are only inlined as an
// image data URL, so no declaration is ever resolved.
const SVG_ROOT =
  /^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[^]*?-->|<!DOCTYPE\s+svg\b[^>[]*(?:\[[^\]]*\])?\s*>)\s*)*<svg(?:\s|>)/i;

function imageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)))
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))
  )
    return 'image/avif';
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM')
    return 'image/bmp';
  if (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    (bytes[2] === 1 || bytes[2] === 2) &&
    bytes[3] === 0
  )
    return 'image/x-icon';
  if (
    SVG_ROOT.test(
      bytes
        .subarray(0, 1024)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    )
  )
    return 'image/svg+xml';
  return undefined;
}

const PREPARED_LIMIT_ERROR =
  'The visual exceeds the 4 MiB prepared-document limit. Downscale images and try again.';

/** Strip a leading BOM and check that the agent document is text within the size limit. */
export function validateVisualHtml(
  rawHtml: string,
): VisualPreparationResult<string> {
  const html = rawHtml.replace(/^\uFEFF/, '');
  if (!isText(html))
    return {
      ok: false,
      error: 'The visual must be a text HTML document, not binary data.',
    };
  const size = Buffer.byteLength(html, 'utf8');
  if (size < 1 || size > VISUAL_HTML_MAX_BYTES)
    return {
      ok: false,
      error:
        'The HTML document must be at most 512,000 UTF-8 bytes. Shorten it and try again.',
    };
  return { ok: true, value: html };
}

/**
 * Inline workspace images as data URLs. With `unresolved: 'error'` an image
 * that cannot be read fails the whole document (ShowVisual); with `'report'`
 * its reference stays exactly as written and its path is listed (preview).
 * The image count and size limits fail in both modes.
 */
export async function inlineVisualImages(
  html: string,
  host: VisualPreparationHost,
  options: { unresolved: 'error' | 'report' },
): Promise<VisualPreparationResult<PreparedVisual>> {
  const failure = (error: string): VisualPreparationResult<PreparedVisual> => ({
    ok: false,
    error,
  });
  let roots: AuthorizedFileRoots | undefined;
  const cache = new Map<string, string>();
  const unreadable = new Set<string>();
  const encountered = new Set<string>();
  const refused = new Set<string>();
  // The prepared document in parts, with its UTF-8 size and the size of the
  // source already walked kept as running totals. Counting either string again
  // for each reference makes a document with many references quadratic.
  const prepared: string[] = [];
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  let preparedBytes = 0;
  let walkedBytes = 0;
  const append = (text: string): number => {
    const bytes = Buffer.byteLength(text, 'utf8');
    prepared.push(text);
    preparedBytes += bytes;
    return bytes;
  };
  let cursor = 0;
  const imageReference = new RegExp(IMAGE_REFERENCE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = imageReference.exec(html)) !== null) {
    const candidate = match[2] ?? match[3];
    if (!candidate || /^(?:data:|blob:|https?:|\/\/)/i.test(candidate))
      continue;
    const start = match.index;
    const written = match[0];
    walkedBytes += append(html.slice(cursor, start));
    // The source from this reference to its end.
    const restBytes = htmlBytes - walkedBytes;
    cursor = start + written.length;
    walkedBytes += Buffer.byteLength(written, 'utf8');
    if (/^(?:\\\\|\\\?\?\\|\\GLOBALROOT\\)/i.test(candidate)) {
      refused.add(candidate);
      if (options.unresolved === 'report') append(written);
      continue;
    }
    const path = isAbsolute(candidate)
      ? candidate
      : resolve(host.cwd, candidate);
    encountered.add(path);
    if (encountered.size > 32)
      return failure(
        'A visual can contain at most 32 distinct local images. Remove some images and try again.',
      );
    let url = cache.get(path);
    if (!url) {
      try {
        if (!roots) {
          const extraRoots: string[] = [];
          try {
            const { codexHome } =
              await getCodexRuntimeService().getCanonicalState();
            extraRoots.push(join(codexHome, 'generated_images'));
          } catch {
            // Codex images are optional; workspace roots remain available.
          }
          roots = await getAuthorizedFileRoots(host.scope, {
            images: true,
            extraRoots,
          });
        }
        const remaining = VISUAL_PREPARED_MAX_BYTES - preparedBytes - restBytes;
        if (remaining < 32) return failure(PREPARED_LIMIT_ERROR);
        // An image that could not be read is not read again for each later
        // reference to it.
        if (unreadable.has(path)) throw new Error('Image already refused');
        const bytes = await readAuthorizedRegularFile(
          path,
          roots,
          Math.min(IMAGE_MAX_BYTES, Math.floor((remaining * 3) / 4)),
        );
        if (bytes.length > IMAGE_MAX_BYTES) throw new Error('Image too large');
        const mime = imageMime(bytes);
        if (!mime) throw new Error('Not an image');
        url = `data:${mime};base64,${bytes.toString('base64')}`;
        cache.set(path, url);
      } catch {
        // Without roots the read was never tried, so a later reference may.
        if (roots) unreadable.add(path);
        refused.add(candidate);
        if (options.unresolved === 'report') append(written);
        continue;
      }
    }
    append(match[1] ? `${match[1]}${url}${match[1]}` : `url(${url})`);
    if (preparedBytes + (htmlBytes - walkedBytes) > VISUAL_PREPARED_MAX_BYTES)
      return failure(PREPARED_LIMIT_ERROR);
  }
  if (refused.size && options.unresolved === 'error')
    return failure(
      `These images could not be read: ${Array.from(refused).join(', ')}. Use paths inside the workspace, or remove them.`,
    );
  append(html.slice(cursor));
  if (preparedBytes > VISUAL_PREPARED_MAX_BYTES)
    return failure(PREPARED_LIMIT_ERROR);
  return {
    ok: true,
    value: {
      html: prepared.join(''),
      unresolvedImagePaths: Array.from(refused),
    },
  };
}
