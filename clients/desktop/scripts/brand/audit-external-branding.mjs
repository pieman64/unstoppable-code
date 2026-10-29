#!/usr/bin/env node
// Scans built branded artifacts for externally visible legacy Canopy names.
// Usage: node scripts/brand/audit-external-branding.mjs [--brand <id>] [--dist <path>] [--repo-root <path>]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from './load-brand.mjs';

const defaultRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function parseArgs(argv) {
  const args = {
    brand: process.env.CANOPY_BRAND ?? 'canopy',
    root: defaultRoot,
    distArg: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--brand') {
      args.brand = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--dist') {
      args.distArg = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--repo-root') {
      args.root = resolve(defaultRoot, argv[i + 1]);
      i += 1;
    }
  }
  return {
    brand: args.brand,
    root: args.root,
    dist: args.distArg
      ? resolve(args.root, args.distArg)
      : join(args.root, 'dist'),
  };
}

function collectFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  const rootStats = statSync(dir);
  if (rootStats.isFile()) {
    if (rootStats.size < 5_000_000) files.push(dir);
    return files;
  }
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) collectFiles(fullPath, files);
    else if (stats.isFile() && stats.size < 5_000_000) files.push(fullPath);
  }
  return files;
}

const args = parseArgs(process.argv.slice(2));
const brand = loadBrand(args.brand, { repoRoot: args.root });
if (brand.id === 'canopy') {
  process.stdout.write('Default Canopy brand audit skipped.\n');
  process.exit(0);
}

const forbiddenExact = [
  'mcp__canopy__',
  'canopy_get_script_output',
  'canopy_ask_user_question',
  'canopy-dictate',
  'X-Canopy-Integration-Token',
];
const allowsLegacyCanopyEnvPrefix =
  Array.isArray(brand.environment?.prefixes) &&
  brand.environment.prefixes.includes('CANOPY');

function reviewedAllowlistEntries() {
  return [
    {
      token: 'canopy-dictate',
      fileSuffix: 'electron-builder.json',
      snippets: [
        '"!canopy-dictate"',
        '"!canopy-dictate.exe"',
        '"!.canopy-dictate-version"',
      ],
      reason: 'Electron Builder excludes the legacy dictation helper name.',
    },
    {
      token: 'mcp__canopy__',
      filePrefix: 'out/renderer/',
      snippets: [
        'HISTORICAL_CANOPY_NAMES',
        'mcp__canopy__AskUserQuestion',
        'mcp__canopy__GetScriptOutput',
        'mcp__canopy__Monitor',
        'normalizeCanopyMcpServerDisplayName',
        'toolName.startsWith("mcp__canopy__")',
      ],
      reason:
        'Renderer keeps legacy transcript/tool-display aliases for old saved chats.',
    },
    {
      token: 'canopy_ask_user_question',
      filePrefix: 'out/renderer/',
      snippets: [
        'canopy_ask_user_question',
        'HISTORICAL_CANOPY_NAMES',
        'getCanopyInjectedAliases',
        'ASK_USER_TOOL_ALIASES',
      ],
      reason:
        'Renderer keeps legacy transcript/tool-display aliases for old saved chats.',
    },
    {
      token: 'canopy_get_script_output',
      filePrefix: 'out/renderer/',
      snippets: [
        'canopy_get_script_output',
        'HISTORICAL_CANOPY_NAMES',
        'getCanopyInjectedAliases',
        'GET_SCRIPT_OUTPUT_TOOL_ALIASES',
      ],
      reason:
        'Renderer keeps legacy transcript/tool-display aliases for old saved chats.',
    },
    {
      token: 'canopy',
      snippets: [
        args.root,
        '.canopy/workspaces/canopy/worktrees/',
        '/workspaces/canopy/worktrees/',
      ],
      reason:
        'Generated build artifacts can embed the absolute local checkout path.',
    },
    {
      token: 'canopy',
      filePrefix: 'out/renderer/',
      snippets: [
        'canopy.json',
        '.canopy',
        'builtin:app',
        'custom:app',
        'source id must be "canopy"',
        'source:{type:"builtin",id:"canopy"',
        'source: { type: "builtin", id: "canopy"',
        'canopy:',
        'canopy-',
        'canopy_',
        'canopyPortal',
        'canopy_portal',
        'canopyNative',
        'canopyKey',
        'canopyDisabled',
        'canopyTitle',
        'canopyButtonClass',
        'canopyContentChanged',
        'loadCanopy',
        'saveCanopy',
        'validateCanopy',
        'CanopyLogo',
        'CanopyPortal',
        'CanopyServer',
        'CanopyProxy',
        'HISTORICAL_CANOPY_NAMES',
        'getCanopyInjectedAliases',
        'normalizeCanopyMcpServerDisplayName',
        'chat-interface-mode-toggle-canopy',
        'settings-tab-canopy',
        'source-icon-canopy',
        'TOOLTIP_CANOPY',
        'legacy Canopy-native chat',
        "treated as `'canopy'` by callers",
        '"canopy"',
      ],
      reason:
        'Reviewed renderer compatibility identifiers, test ids, event names, and legacy transcript aliases.',
    },
    {
      token: 'canopy',
      snippets: [
        '@canopy/protocol/brand',
        'canopy.json',
        'canopy-json',
        '.canopy',
        '.canopy-dev',
        'canopy-build-summary',
        'builtin:app',
        'source id must be "canopy"',
        'id:"canopy"',
        '"repo": "canopy"',
        'repo: canopy',
      ],
      reason:
        'Reviewed compatibility identifiers that remain stable across brands.',
    },
    {
      token: 'canopy',
      filePrefix: 'dist/cli/',
      snippets: [
        'e.canopy',
        'n.canopy',
        'i.canopy',
        'canopy:Hc',
        'canopy:n',
        'canopy:a',
        'canopy?.event',
        'b.internalName!=="canopy"',
      ],
      reason: 'Reviewed CLI bundle internals for pipeline context plumbing.',
    },
    {
      token: 'CANOPY',
      filePrefix: 'out/renderer/',
      snippets: [
        '"CANOPY"',
        'TERMINAL_CANOPY',
        'MCP_HTTP_AUTH_CANOPY',
        'TOOLTIP_CANOPY',
        'CANOPY_INJECTED_TOOL',
        'HISTORICAL_CANOPY',
        'CANOPY_PREFERENCES',
        '__CANOPY_BRAND',
      ],
      reason:
        'Reviewed renderer constants and configured CANOPY fallback metadata.',
    },
    {
      token: 'Canopy',
      filePrefix: 'out/renderer/',
      snippets: [
        'CanopyLogo',
        'CanopyPortal',
        'CanopyServer',
        'CanopyTab',
        'CanopyMcp',
        'CanopyProxy',
        'applyCanopyCompactionEvent',
        'endedByCanopyManagedCleanup',
        'getCanonicalCanopyToolKey',
        'getCanopyInjectedAliases',
        'prevCanopyJsonHash',
        'Canopy-native',
        'Canopy-injected name',
        'Canopy injected tools',
        'InvalidCanopyJsonError',
        'HISTORICAL_CANOPY_NAMES',
      ],
      reason:
        'Reviewed renderer symbol names and explicit compatibility text that are not visible product copy.',
    },
    {
      token: 'Canopy',
      snippets: ['InvalidCanopyJsonError'],
      reason:
        'Explicit fallback documentation for configured CANOPY_* aliases.',
    },
  ];
}

function collectAuditRoots() {
  const roots = [args.dist];
  roots.push(join(args.root, 'out', 'renderer'));
  roots.push(join(args.root, '.cache', 'brand', brand.id, 'resources'));
  roots.push(
    join(args.root, '.cache', 'brand', brand.id, 'electron-builder.json'),
  );
  roots.push(join(args.root, '.cache', 'bin'));
  roots.push(join(args.root, '.cache', 'cli'));
  return roots;
}

function isIgnoredReleaseStagingFile(relativeFile) {
  if (!relativeFile.startsWith('.cache/bin/')) {
    return false;
  }
  if (brand.dictation.binaryName === 'canopy-dictate') {
    return false;
  }
  return new Set([
    'canopy-dictate',
    'canopy-dictate.exe',
    '.canopy-dictate-version',
  ]).has(basename(relativeFile));
}

function isReviewedAllowedOccurrence(relativeFile, content, index, token) {
  const before = content.slice(Math.max(0, index - 80), index);
  const after = content.slice(index, Math.min(content.length, index + 120));
  const context = `${before}${after}`;
  return reviewedAllowlistEntries().some((entry) => {
    if (entry.token !== token) return false;
    if (entry.fileSuffix && !relativeFile.endsWith(entry.fileSuffix)) {
      return false;
    }
    if (entry.filePrefix && !relativeFile.startsWith(entry.filePrefix)) {
      return false;
    }
    return entry.snippets.some((snippet) => context.includes(snippet));
  });
}

function isAllowedOccurrence(relativeFile, content, index, token) {
  if (token === 'CANOPY') {
    if (isReviewedAllowedOccurrence(relativeFile, content, index, token)) {
      return true;
    }
    const before = content.slice(Math.max(0, index - 80), index);
    const after = content.slice(index, Math.min(content.length, index + 120));
    return (
      allowsLegacyCanopyEnvPrefix &&
      (content.slice(index, index + 'CANOPY_'.length) === 'CANOPY_' ||
        (content.slice(index, index + 'CANOPY'.length) === 'CANOPY' &&
          /["']$/.test(before) &&
          /^["']/.test(after.slice('CANOPY'.length))))
    );
  }
  return isReviewedAllowedOccurrence(relativeFile, content, index, token);
}

function debugRejectedOccurrence(relativeFile, content, index, token) {
  if (process.env.DEBUG_BRAND_AUDIT !== '1') return;
  const before = content.slice(Math.max(0, index - 80), index);
  const after = content.slice(index, Math.min(content.length, index + 120));
  process.stderr.write(
    `[brand-audit-debug] ${relativeFile}: ${token}: ${JSON.stringify(
      `${before}${after}`,
    )}\n`,
  );
}

const violations = [];
const files = Array.from(
  new Set(collectAuditRoots().flatMap((auditRoot) => collectFiles(auditRoot))),
);
for (const file of files) {
  const relativeFile = relative(args.root, file);
  if (isIgnoredReleaseStagingFile(relativeFile)) {
    continue;
  }
  if (
    relativeFile.includes('/resources/actions/') &&
    (relativeFile.endsWith('.js') || relativeFile.endsWith('.js.map'))
  ) {
    continue;
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const forbidden of forbiddenExact) {
    let index = content.indexOf(forbidden);
    while (index !== -1) {
      if (
        isReviewedAllowedOccurrence(relativeFile, content, index, forbidden)
      ) {
        index = content.indexOf(forbidden, index + forbidden.length);
        continue;
      }
      debugRejectedOccurrence(relativeFile, content, index, forbidden);
      violations.push(`${relativeFile}: contains forbidden ${forbidden}`);
      break;
    }
  }
  for (const token of ['Canopy', 'canopy', 'CANOPY']) {
    let index = content.indexOf(token);
    while (index !== -1) {
      if (!isAllowedOccurrence(relativeFile, content, index, token)) {
        debugRejectedOccurrence(relativeFile, content, index, token);
        violations.push(`${relativeFile}: contains ${token}`);
        break;
      }
      index = content.indexOf(token, index + token.length);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Brand audit failed for ${brand.id}:\n${violations.join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Brand audit passed for ${brand.id}.\n`);
