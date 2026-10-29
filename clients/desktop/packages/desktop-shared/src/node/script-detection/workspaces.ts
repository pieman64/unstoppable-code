import {
  isRecord,
  isScriptActionRelativePath,
} from '@canopy/protocol/script-actions';
import { DETECTION_LIMITS, type SourceReader } from './source-reader';
import { literalTomlArray, parseObject, parseYaml } from './manifests';
const excluded = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'vendor',
  'target',
  '.venv',
  'venv',
]);
export async function workspacePackages(
  reader: SourceReader,
): Promise<string[]> {
  const patterns: string[] = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      patterns.push(...value);
    else
      reader.diagnose('.', 'unsupported', 'Unsupported workspace declaration.');
  };
  const packageJson = await reader.read('package.json');
  if (packageJson)
    try {
      const obj = parseObject(packageJson.content);
      if (Array.isArray(obj.workspaces)) add(obj.workspaces);
      else if (isRecord(obj.workspaces)) add(obj.workspaces.packages);
    } catch {
      reader.diagnose('package.json', 'malformed', 'Invalid package manifest.');
    }
  const pnpm = await reader.read('pnpm-workspace.yaml');
  if (pnpm)
    try {
      const obj = parseYaml(pnpm.content);
      if (isRecord(obj)) add(obj.packages);
      else throw new Error();
    } catch {
      reader.diagnose(
        'pnpm-workspace.yaml',
        'malformed',
        'Invalid workspace manifest.',
      );
    }
  const cargo = await reader.read('Cargo.toml');
  if (cargo) {
    for (const key of ['members', 'exclude']) {
      try {
        patterns.push(
          ...literalTomlArray(cargo.content, 'workspace', key).map((entry) =>
            key === 'exclude' ? `!${entry}` : entry,
          ),
        );
      } catch {
        reader.diagnose(
          'Cargo.toml',
          'unsupported',
          'Unsupported workspace array syntax.',
        );
      }
    }
  }
  const included = new Set<string>();
  const exclusions = new Set<string>();
  const walk = async (
    base: string,
    recursive: boolean,
    depth: number,
    output: Set<string>,
  ): Promise<void> => {
    if (depth >= DETECTION_LIMITS.globDepth) {
      reader.diagnose(base, 'truncated', 'Workspace glob depth limit reached.');
      return;
    }
    for (const entry of await reader.directory(base)) {
      if (
        !entry.directory ||
        entry.name.startsWith('.') ||
        excluded.has(entry.name)
      )
        continue;
      const child = base ? `${base}/${entry.name}` : entry.name;
      output.add(child);
      if (output.size > DETECTION_LIMITS.packages) {
        reader.diagnose(base, 'truncated', 'Workspace package limit reached.');
        return;
      }
      if (recursive) await walk(child, true, depth + 1, output);
    }
  };
  const declarations = Array.from(new Set(patterns)).sort();
  if (declarations.length > 400)
    reader.diagnose('.', 'truncated', 'Workspace declaration limit reached.');
  for (const pattern of declarations.slice(0, 400)) {
    const negative = pattern.startsWith('!');
    const raw = negative ? pattern.slice(1) : pattern;
    const match = /^(.*)\/(\*\*|\*)$/.exec(raw);
    const base = (match?.[1] ?? raw).replace(/^\.\//, '').replace(/\/$/, '');
    if (
      !base ||
      !isScriptActionRelativePath(base) ||
      /[*?{}[\]]/.test(base) ||
      base.split('/').some((part) => excluded.has(part) || part === '.')
    ) {
      reader.diagnose(pattern, 'unsupported', 'Unsupported workspace pattern.');
      continue;
    }
    const output = negative ? exclusions : included;
    if (match) await walk(base, match[2] === '**', 0, output);
    else {
      const path = await reader.contained(base).catch(() => null);
      if (path) output.add(base);
    }
  }
  const paths = Array.from(included)
    .filter(
      (name) =>
        !Array.from(exclusions).some(
          (exclusion) => name === exclusion || name.startsWith(`${exclusion}/`),
        ),
    )
    .sort();
  if (paths.length > DETECTION_LIMITS.packages)
    reader.diagnose('.', 'truncated', 'Workspace package limit reached.');
  return paths.slice(0, DETECTION_LIMITS.packages);
}
