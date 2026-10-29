import { load, JSON_SCHEMA } from 'js-yaml';
import { parse, type ParseError } from 'jsonc-parser';
import {
  isRecord,
  type ScriptActionSourceKind,
} from '@canopy/protocol/script-actions';
import { type SourceReader } from './source-reader';
export interface ManifestEntry {
  name: string;
  entry: string;
  words: string[];
  kind: ScriptActionSourceKind;
  line: number | null;
  unavailableReason?: string;
}
export function parseObject(
  content: string,
  jsonc = false,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = jsonc ? parse(content, errors) : JSON.parse(content);
  if (errors.length || !isRecord(value)) throw new Error('Invalid manifest.');
  return value;
}
/** YAML aliases/tags are unnecessary here; rejecting them bounds alias expansion before parsing. */
export function parseYaml(content: string): unknown {
  if (/(?:^|[\s,[{])[*&!][^\s]/m.test(content))
    throw new Error('YAML aliases and tags are unsupported.');
  return load(content, { schema: JSON_SCHEMA });
}
export function literalTomlArray(
  content: string,
  section: string,
  key: string,
): string[] {
  let active = false;
  for (const line of content.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      active = header[1] === section;
      continue;
    }
    if (!active) continue;
    const field = /^\s*([A-Za-z_-]+)\s*=/.exec(line)?.[1];
    if (field !== key) continue;
    const assignment = /^\s*([A-Za-z_-]+)\s*=\s*(\[.*\])\s*(?:#.*)?$/.exec(
      line,
    );
    if (!assignment?.[2]) throw new Error('Unsupported workspace array.');
    const raw = assignment[2];
    if (!/^\[\s*(?:["'][^"'\\\r\n]*["']\s*,?\s*)*\]$/.test(raw))
      throw new Error('Unsupported workspace array.');
    return Array.from(raw.matchAll(/["']([^"']*)["']/g)).map(
      (match) => match[1] ?? '',
    );
  }
  return [];
}
function parseManifestUncached(
  file: string,
  content: string,
  manager: string,
): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const add = (
    name: string,
    words: string[],
    kind: ScriptActionSourceKind,
    line: number | null = null,
    sourceEntry?: string,
  ): void => {
    if (name && name.length <= 512 && !/[\0\r\n]/.test(name))
      entries.push({
        name,
        entry: sourceEntry ?? name,
        words,
        kind,
        line,
        ...(name.startsWith('-')
          ? {
              unavailableReason:
                'Option-like task names are unavailable for this command runner.',
            }
          : {}),
      });
  };
  if (
    file === 'package.json' ||
    file === 'composer.json' ||
    file.startsWith('deno.json')
  ) {
    const obj = parseObject(content, file.endsWith('jsonc'));
    const scripts = file.startsWith('deno') ? obj.tasks : obj.scripts;
    if (scripts !== undefined && !isRecord(scripts))
      throw new Error('Invalid script entries.');
    if (isRecord(scripts))
      for (const name of Object.keys(scripts).sort()) {
        if (file === 'package.json' && typeof scripts[name] === 'string')
          add(name, [manager, 'run', name], 'package-json');
        if (
          file === 'composer.json' &&
          !/^(pre-|post-)/.test(name) &&
          (typeof scripts[name] === 'string' || Array.isArray(scripts[name]))
        )
          add(name, ['composer', 'run', name], 'composer');
        if (
          file.startsWith('deno') &&
          (typeof scripts[name] === 'string' || isRecord(scripts[name]))
        )
          add(name, ['deno', 'task', name], 'deno');
      }
  } else if (/^(GNUmakefile|Makefile|makefile)$/.test(file)) {
    content.split(/\r?\n/).forEach((line, i) => {
      const match =
        /^([A-Za-z0-9_][A-Za-z0-9_.-]*(?: +[A-Za-z0-9_][A-Za-z0-9_.-]*)*)\s*:(?![:=])([^=]*)$/.exec(
          line,
        );
      if (match?.[1])
        for (const name of match[1].split(/ +/))
          add(name, ['make', name], 'makefile', i + 1);
    });
  } else if (/^(justfile|Justfile|\.justfile)$/.test(file)) {
    let privateRecipe = false;
    content.split(/\r?\n/).forEach((line, i) => {
      if (/^\[.*\bprivate\b/.test(line)) {
        privateRecipe = true;
        return;
      }
      if (/^(?:import|mod|alias|set|export)\b/.test(line)) return;
      const match = /^([A-Za-z][\w-]*)(?:\s+[^:=]*)?\s*:(?![=])/.exec(line);
      if (match?.[1] && !privateRecipe)
        add(match[1], ['just', match[1]], 'justfile', i + 1);
      if (line.trim() && !line.startsWith('#') && !line.startsWith('['))
        privateRecipe = false;
    });
  } else if (/^Taskfile/.test(file) || /^taskfile/.test(file)) {
    const obj = parseYaml(content);
    if (!isRecord(obj) || !isRecord(obj.tasks))
      throw new Error('Invalid Taskfile tasks.');
    for (const name of Object.keys(obj.tasks).sort()) {
      const task = obj.tasks[name];
      if (
        typeof task === 'string' ||
        Array.isArray(task) ||
        (isRecord(task) && task.internal !== true)
      )
        add(name, ['task', name], 'taskfile');
    }
  } else if (file === 'pyproject.toml') {
    let section = '';
    content.split(/\r?\n/).forEach((line, i) => {
      const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (header) {
        section = header[1] ?? '';
        return;
      }
      const match =
        /^([A-Za-z_][\w-]*)\s*=\s*(?:'[^'\r\n]*'|"[^"\\\r\n]*")\s*(?:#.*)?$/.exec(
          line,
        );
      if (match?.[1] && section === 'tool.poe.tasks')
        add(
          match[1],
          ['poe', match[1]],
          'pyproject',
          i + 1,
          `${section}.${match[1]}`,
        );
      if (
        match?.[1] &&
        section === 'tool.pdm.scripts' &&
        !match[1].startsWith('_')
      )
        add(
          match[1],
          ['pdm', 'run', match[1]],
          'pyproject',
          i + 1,
          `${section}.${match[1]}`,
        );
    });
  } else if (file === 'Cargo.toml') {
    if (/^\s*\[(?:package|workspace)\]/m.test(content))
      for (const action of ['build', 'test', 'clippy', 'fmt'])
        add(action, ['cargo', action], 'cargo');
  } else if (file === 'go.mod' && /^module\s+\S+/m.test(content)) {
    add('build', ['go', 'build', './...'], 'go');
    add('test', ['go', 'test', './...'], 'go');
  }
  return entries;
}
export async function packageManager(
  reader: SourceReader,
  pkg: string,
  manifest: string | undefined,
): Promise<{ manager: string; evidence: string; unavailableReason?: string }> {
  let explicit: unknown;
  if (manifest) {
    try {
      explicit = parseObject(manifest).packageManager;
    } catch {
      /* Manifest parsing reports separately. */
    }
  }
  if (typeof explicit === 'string') {
    const manager = explicit.split('@')[0];
    if (manager && ['pnpm', 'yarn', 'bun', 'npm'].includes(manager))
      return { manager, evidence: explicit };
    reader.diagnose(
      pkg ? `${pkg}/package.json` : 'package.json',
      'unsupported',
      'Unknown package manager; using lockfile precedence.',
    );
  }
  // Only the lockfile's presence selects the manager, so its contents are
  // never read: lockfiles routinely exceed the source limit, and dependency
  // updates must not invalidate script approvals.
  for (const directory of pkg ? ['', pkg] : ['']) {
    for (const [file, manager] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ] as const) {
      const name = directory ? `${directory}/${file}` : file;
      const failures = reader.failureCount;
      const present = await reader.exists(name);
      if (!present && reader.failureCount > failures)
        return {
          manager,
          evidence: `${name}:unverified`,
          unavailableReason:
            'Package manager evidence could not be verified. Rescan after fixing the source.',
        };
      if (present) return { manager, evidence: name };
    }
  }
  return { manager: 'npm', evidence: 'npm-default' };
}

const manifestCache = new Map<string, ManifestEntry[]>();
/** Cache bounded parser results by exact source digest; discovery inputs are always read again. */
export function parseManifest(
  file: string,
  content: string,
  manager: string,
  sourceDigest: string,
): ManifestEntry[] {
  const key = JSON.stringify([file, manager, sourceDigest]);
  const previous = manifestCache.get(key);
  if (previous)
    return previous.map((entry) => ({ ...entry, words: [...entry.words] }));
  const unique = new Map<string, ManifestEntry>();
  for (const entry of parseManifestUncached(file, content, manager)) {
    const identity = JSON.stringify([entry.kind, entry.entry]);
    if (!unique.has(identity)) unique.set(identity, entry);
  }
  const entries = Array.from(unique.values()).slice(0, 201);
  manifestCache.set(key, entries);
  if (manifestCache.size > 128) {
    const first = manifestCache.keys().next().value;
    if (first) manifestCache.delete(first);
  }
  return entries.map((entry) => ({ ...entry, words: [...entry.words] }));
}
