import { homedir } from 'node:os';
import { posix } from 'node:path';
import { nativeImage } from 'electron';
import { hasDesktopControlCharacters } from './linux-desktop-exec';
import { readDesktopBytes, readDesktopText } from './linux-desktop-files';

const MAX_ICON_BYTES = 1024 * 1024;
// Enough for the supported 256x256, four-characters-per-pixel subset and its
// color table, with a smaller synchronous scan budget than native PNG decoding.
const MAX_XPM_BYTES = 384 * 1024;
const MAX_THEMES = 16;
const MAX_LOCATIONS = 256;
const MAX_SCAN_ICON_READS = 4096;
const MAX_THEME_READS = 128;
const MAX_ICON_DIRECTORIES = 128;
const FALLBACK_DIRECTORIES = [
  '64x64/apps',
  '48x48/apps',
  '32x32/apps',
  'scalable/apps',
  '256x256/apps',
];

/** NativeImage does not decode XPM on every Electron host. Decode a deliberately
 * small, non-executable XPM subset to BGRA; unsupported colors use neutral UI. */
function xpmPng(bytes: Buffer): string {
  const rows = Array.from(
    bytes.toString('utf8').matchAll(/^[ \t]*"([^"\\\r\n]*)"/gm),
  ).map((match) => match[1]);
  const header = rows.shift()?.match(/^(\d+) (\d+) (\d+) (\d+)$/);
  if (!header) return '';
  const [, widthRaw, heightRaw, colorsRaw, cppRaw] = header;
  const width = Number(widthRaw),
    height = Number(heightRaw),
    count = Number(colorsRaw),
    cpp = Number(cppRaw);
  if (
    !width ||
    !height ||
    width > 256 ||
    height > 256 ||
    !count ||
    count > 256 ||
    cpp < 1 ||
    cpp > 4 ||
    rows.length < count + height
  )
    return '';
  const colors = new Map<string, readonly number[]>();
  for (const row of rows.slice(0, count)) {
    const color = row
      .slice(cpp)
      .trim()
      .match(/^c\s+(None|#[\da-f]{6}|#[\da-f]{3})$/i)?.[1];
    if (!color) return '';
    const hex =
      color.length === 4
        ? color
            .slice(1)
            .split('')
            .map((c) => c + c)
            .join('')
        : color.slice(1);
    colors.set(
      row.slice(0, cpp),
      color.toLowerCase() === 'none'
        ? [0, 0, 0, 0]
        : [
            parseInt(hex.slice(4, 6), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(0, 2), 16),
            255,
          ],
    );
  }
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = rows[count + y];
    if (row.length !== width * cpp) return '';
    for (let x = 0; x < width; x += 1) {
      const color = colors.get(row.slice(x * cpp, (x + 1) * cpp));
      if (!color) return '';
      color.forEach((value, i) => {
        bitmap[(y * width + x) * 4 + i] = value;
      });
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height });
  return image.isEmpty() ? '' : image.toDataURL();
}

async function imageData(file: string): Promise<string> {
  const extension = posix.extname(file).toLowerCase();
  // Never forward or parse untrusted SVG markup. The renderer already has a
  // neutral category icon for empty artwork, including SVG-only themes.
  if (!['.png', '.xpm'].includes(extension)) return '';
  const bytes = await readDesktopBytes(
    file,
    extension === '.xpm' ? MAX_XPM_BYTES : MAX_ICON_BYTES,
  );
  if (!bytes) return '';
  try {
    if (extension === '.xpm') return xpmPng(bytes);
    // Check IHDR before native decoding to bound decompressed image dimensions.
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) > 1024 ||
      bytes.readUInt32BE(20) > 1024
    )
      return '';
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return '';
    const output = image
      .resize({ width: 64, height: 64, quality: 'best' })
      .toPNG();
    return output.length
      ? `data:image/png;base64,${output.toString('base64')}`
      : '';
  } catch {
    return '';
  }
}

function safePart(value: string): boolean {
  return (
    !!value &&
    value.length < 256 &&
    !value.includes('..') &&
    !hasDesktopControlCharacters(value) &&
    !value.includes('\\') &&
    !posix.isAbsolute(value)
  );
}

/** Per-scan resolver: theme metadata and repeated icons are shared, never stale
 * across a Refresh. All filesystem access is async and strictly bounded. */
export function createLinuxIconResolver(
  roots: readonly string[],
): (name: string) => Promise<string> {
  const bases = Array.from(
    new Set([
      posix.join(homedir(), '.icons'),
      ...roots.map((root) => posix.join(root, 'icons')),
    ]),
  );
  const cache = new Map<string, Promise<string>>();
  let themeLocations: Promise<string[]> | undefined;
  let remainingReads = MAX_SCAN_ICON_READS;
  const locations = async (): Promise<string[]> => {
    const result: string[] = [];
    const seen = new Set<string>();
    let metadataReads = 0;
    const readMetadata = async (
      file: string,
      reservedReads = bases.length,
    ): Promise<string | undefined> => {
      if (metadataReads >= MAX_THEME_READS - reservedReads) return undefined;
      metadataReads += 1;
      return readDesktopText(file);
    };
    const parents = (metadata: string | undefined): string[] =>
      metadata
        ?.match(/^Inherits=(.+)$/m)?.[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => safePart(name) && !name.includes('/')) ?? [];
    const visit = async (theme: string): Promise<void> => {
      if (
        seen.has(theme) ||
        seen.size >= (theme === 'hicolor' ? MAX_THEMES : MAX_THEMES - 1) ||
        !safePart(theme) ||
        theme.includes('/')
      )
        return;
      seen.add(theme);
      const inherited: string[] = [];
      for (const base of bases) {
        const directory = posix.join(base, theme);
        const metadata = await readMetadata(
          posix.join(directory, 'index.theme'),
          theme === 'hicolor' ? 0 : bases.length,
        );
        inherited.push(...parents(metadata).slice(0, MAX_THEMES));
        const declared =
          metadata
            ?.match(/^Directories=(.+)$/m)?.[1]
            .split(',')
            .map((name) => name.trim())
            .filter(safePart) ?? [];
        for (const sub of Array.from(
          new Set([...FALLBACK_DIRECTORIES, ...declared]),
        ).slice(0, MAX_ICON_DIRECTORIES)) {
          if (result.length < MAX_LOCATIONS)
            result.push(posix.join(directory, sub));
        }
      }
      // Depth-first inheritance; hicolor is always the final fallback, never
      // ahead of a selected theme's parent. Cycles and huge chains are bounded.
      for (const parent of inherited)
        if (parent !== 'hicolor') await visit(parent);
    };
    const config = process.env.XDG_CONFIG_HOME;
    const configRoot =
      config && posix.isAbsolute(config) && !hasDesktopControlCharacters(config)
        ? config
        : posix.join(homedir(), '.config');
    const settings = await readMetadata(
      posix.join(configRoot, 'gtk-3.0/settings.ini'),
    );
    const selected = settings
      ?.match(/^gtk-icon-theme-name\s*=\s*(.+)$/m)?.[1]
      .trim();
    if (selected && selected !== 'hicolor') await visit(selected);
    const defaults = await readMetadata(
      posix.join(bases[0], 'default/index.theme'),
    );
    for (const parent of parents(defaults))
      if (parent !== 'hicolor') await visit(parent);
    await visit('Adwaita');
    // Reserve a bounded tail for hicolor even when a hostile theme fills the
    // location budget. Real fallback artwork must remain available.
    result.splice(MAX_LOCATIONS - 32);
    await visit('hicolor');
    return result;
  };
  const resolve = async (name: string): Promise<string> => {
    if (!name || name.length > 4096 || hasDesktopControlCharacters(name))
      return '';
    if (posix.isAbsolute(name))
      return remainingReads-- > 0 ? imageData(name) : '';
    if (!safePart(name) || name.includes('/')) return '';
    themeLocations ??= locations();
    const names = /\.(?:png|svg|xpm)$/i.test(name)
      ? [name]
      : [`${name}.png`, `${name}.svg`, `${name}.xpm`];
    for (const directory of [
      ...(await themeLocations),
      ...roots.map((root) => posix.join(root, 'pixmaps')),
    ]) {
      for (const file of names) {
        if (file.endsWith('.svg')) continue;
        if (remainingReads-- <= 0) return '';
        const data = await imageData(posix.join(directory, file));
        if (data) return data;
      }
    }
    return '';
  };
  return (name): Promise<string> => {
    let value = cache.get(name);
    if (!value) {
      value = resolve(name);
      cache.set(name, value);
    }
    return value;
  };
}
