// Filename → Seti icon name resolver.
//
// Mirrors the lookup order used by VS Code's file icon themes:
//   1. Exact filename match (eg. `package.json`, `Dockerfile`)
//   2. Longest extension match — for compound names like `app.test.ts`
//      we try the longest tail first (`test.ts`), then progressively
//      shorter (`ts`). This matches how VS Code's theme keys work.
//   3. Default file icon
//
// Reference for lookup order:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/fileIconThemeData.ts

import { SETI_ICON_REGISTRY, type SetiIconDef } from './icon-registry';
import {
  EXTENSION_TO_LANGUAGE_ID,
  FILE_EXTENSION_TO_ICON,
  FILE_NAME_TO_ICON,
  LANGUAGE_ID_TO_ICON,
} from './mapping';

const MARKDOWN_BLUE = '#529BBA';
const CONFIG_GRAY = '#41535B';

const MARKDOWN_BLUE_FILE_NAMES = new Set([
  'changelog.md',
  'changes.md',
  'readme.md',
  'todo.md',
  'version.md',
]);

const CONFIG_GRAY_FILE_NAMES = new Set([
  'changelog',
  'changelog.txt',
  'changes',
  'changes.txt',
  'readme',
  'readme.txt',
  'todo',
  'todo.txt',
  'version',
  'version.txt',
]);

const CONFIG_GRAY_ICON_NAMES = new Set([
  'babel',
  'eslint',
  'firefox',
  'ionic',
  'jenkins',
  'makefile',
  'maven',
  'rollup',
  'stylelint',
  'vite',
  'webpack',
  'yarn',
]);

export interface ResolveOptions {
  // Language id (eg. "typescript", "python") used as a fallback when the
  // filename has no useful extension — common for chat artifacts where the
  // title is a free-form string and the language is tracked separately.
  language?: string;
}

// Returns the resolved Seti icon name, or `null` when nothing matched. A
// `null` result tells the renderer to fall back to the project's generic
// FileIcon — Seti's own `default` SVG uses a wide viewBox that scales poorly
// at small sizes, so we deliberately route fallback through our outline icon.
export function resolveFileIconName(
  filename: string,
  options?: ResolveOptions,
): string | null {
  const base = baseName(filename).toLowerCase();

  if (base) {
    const exact = FILE_NAME_TO_ICON[base];
    if (exact && exact in SETI_ICON_REGISTRY) return exact;

    // Walk extension segments from longest to shortest. For "vite.config.ts"
    // we try "config.ts", then "ts". At each step we try the Seti
    // fileExtensions override map first, and then bridge through the
    // `extension → language id → icon` chain that VS Code does implicitly
    // via its language contribution points.
    let dot = base.indexOf('.');
    while (dot !== -1) {
      const ext = base.slice(dot + 1);
      const direct = FILE_EXTENSION_TO_ICON[ext];
      if (direct && direct in SETI_ICON_REGISTRY) return direct;
      const bridged = EXTENSION_TO_LANGUAGE_ID[ext];
      if (bridged) {
        const hit = LANGUAGE_ID_TO_ICON[bridged];
        if (hit && hit in SETI_ICON_REGISTRY) return hit;
      }
      dot = base.indexOf('.', dot + 1);
    }
  }

  const lang = options?.language?.toLowerCase();
  if (lang) {
    const hit = LANGUAGE_ID_TO_ICON[lang];
    if (hit && hit in SETI_ICON_REGISTRY) return hit;
  }

  return null;
}

export function getFileIconDef(
  filename: string,
  options?: ResolveOptions,
): SetiIconDef | null {
  const name = resolveFileIconName(filename, options);
  if (!name) return null;
  const def = SETI_ICON_REGISTRY[name];
  if (!def) return null;
  const fill = getFileIconFillOverride(filename, name);
  if (!fill) return def;
  return { ...def, paths: forceSvgFill(def.paths, fill) };
}

function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}

function getFileIconFillOverride(
  filename: string,
  iconName: string,
): string | null {
  const base = baseName(filename).toLowerCase();
  if (MARKDOWN_BLUE_FILE_NAMES.has(base)) return MARKDOWN_BLUE;
  if (CONFIG_GRAY_FILE_NAMES.has(base)) return CONFIG_GRAY;
  if (CONFIG_GRAY_ICON_NAMES.has(iconName)) return CONFIG_GRAY;
  return null;
}

export function forceSvgFill(paths: string, fill: string): string {
  const recolored = paths
    .replace(
      /fill=(["'])(?!none\b)(?!transparent\b)(?!url\()[^"']+\1/gi,
      `fill="${fill}"`,
    )
    .replace(/fill:\s*([^;"'}]+)/gi, (match, value: string) =>
      shouldPreserveFillValue(value) ? match : `fill:${fill}`,
    );

  return `<g fill="${fill}">${recolored}</g>`;
}

function shouldPreserveFillValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'none' ||
    normalized === 'transparent' ||
    normalized.startsWith('url(')
  );
}
