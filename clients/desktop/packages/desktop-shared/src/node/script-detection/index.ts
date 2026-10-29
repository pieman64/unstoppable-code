import { createHash } from 'node:crypto';
import {
  isScriptActionRelativePath,
  type ScriptAction,
} from '@canopy/protocol/script-actions';
import { DETECTION_LIMITS, SourceReader } from './source-reader';
import { parseManifest, packageManager } from './manifests';
import { workspacePackages } from './workspaces';
import {
  renderScriptCommand,
  type ScriptTerminalShell,
} from './render-command';
import type { DetectionResult } from './aliases';
export {
  detectShellAliases,
  parseStaticAliases,
  SHELL_ALIAS_FILES,
} from './aliases';
export { DETECTION_LIMITS } from './source-reader';
export type { DetectionResult } from './aliases';
export type { ScriptTerminalShell } from './render-command';
const manifestGroups = [
  ['package.json'],
  ['GNUmakefile', 'Makefile', 'makefile'],
  ['justfile', 'Justfile', '.justfile'],
  [
    'Taskfile.yml',
    'Taskfile.yaml',
    'Taskfile.dist.yml',
    'Taskfile.dist.yaml',
    'taskfile.yml',
    'taskfile.yaml',
  ],
  ['deno.json', 'deno.jsonc'],
  ['composer.json'],
  ['pyproject.toml'],
  ['Cargo.toml'],
  ['go.mod'],
];
const shellDirectories = [
  '',
  'scripts',
  'script',
  'bin',
  'tools',
  '.github/scripts',
];
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function interpreter(
  content: string,
  name: string,
  platform: 'posix' | 'win32',
): string | null {
  const first = content.slice(0, 256).split(/\r?\n/)[0] ?? '';
  if (first.startsWith('#!')) {
    const match =
      /^#!\s*(?:\/usr\/bin\/env\s+|\/(?:[^\s/]+\/)*)(sh|bash|zsh|fish|pwsh)(?:\s|$)/.exec(
        first,
      );
    if (!match?.[1]) return null;
    // Interpreter options affect execution and cannot be silently discarded.
    if (first.slice(match[0].length).trim()) return null;
    return match[1];
  }
  const extension = name.split('.').pop();
  return extension === 'ps1'
    ? 'pwsh'
    : extension === 'bash'
      ? 'bash'
      : extension === 'zsh'
        ? 'zsh'
        : extension === 'sh'
          ? platform === 'win32'
            ? 'bash'
            : 'sh'
          : null;
}
export async function detectRepositoryScripts(input: {
  root: string;
  repoId: string;
  repoName: string;
  shell: ScriptTerminalShell;
  platform: 'posix' | 'win32';
}): Promise<DetectionResult> {
  const reader = new SourceReader(input.root);
  const actions: ScriptAction[] = [];
  if (!(await reader.requireRoot()))
    return {
      actions,
      diagnostics: reader.diagnostics,
      complete: false,
      watchedDirectories: [],
    };
  const packages = ['', ...(await workspacePackages(reader))];
  for (const pkg of packages) {
    if (!isScriptActionRelativePath(pkg)) continue;
    const prefix = pkg ? `${pkg}/` : '';
    const json = await reader.read(`${prefix}package.json`);
    const manager = await packageManager(reader, pkg, json?.content);
    for (const group of manifestGroups) {
      for (const file of group) {
        const relativeFile = `${prefix}${file}`;
        if (!(await reader.exists(relativeFile))) continue;
        const source = await reader.read(relativeFile);
        if (source)
          try {
            const entries = parseManifest(
              file,
              source.content,
              manager.manager,
              source.digest,
            );
            if (
              file === 'Cargo.toml' &&
              (/^\s*\[\[bin\]\]/m.test(source.content) ||
                (await reader.exists(`${prefix}src/main.rs`)))
            )
              entries.push({
                name: 'run',
                entry: 'run',
                words: ['cargo', 'run'],
                kind: 'cargo',
                line: null,
              });
            if (entries.length > DETECTION_LIMITS.sourceEntries)
              reader.diagnose(
                relativeFile,
                'truncated',
                'Source entry limit reached.',
              );
            for (const entry of entries.slice(
              0,
              DETECTION_LIMITS.sourceEntries,
            )) {
              const command = renderScriptCommand(entry.words, input.shell);
              // Review still shows unavailable entries; never guess quoting for another shell.
              const rendered = command ?? entry.words.join(' ');
              actions.push({
                id: JSON.stringify([
                  'detected',
                  input.repoId,
                  pkg,
                  entry.kind,
                  relativeFile,
                  entry.entry,
                ]),
                kind: 'detected',
                name: entry.name,
                command: rendered,
                multiline: /[\r\n]/.test(rendered),
                repoId: input.repoId,
                repoName: input.repoName,
                packagePath: pkg || null,
                target: { kind: 'repository', repoId: input.repoId },
                source: {
                  kind: entry.kind,
                  file: relativeFile,
                  entry: entry.entry,
                  line: entry.line,
                },
                revision: digest([
                  pkg,
                  entry,
                  source.digest,
                  entry.kind === 'package-json' ? manager.evidence : '',
                  input.shell,
                ]),
                status: 'pending',
                shortcut: null,
                pinned: false,
                ...(entry.unavailableReason ||
                (entry.kind === 'package-json' && manager.unavailableReason)
                  ? {
                      unavailableReason:
                        entry.unavailableReason ?? manager.unavailableReason,
                    }
                  : command === null
                    ? {
                        unavailableReason:
                          'Arguments cannot be safely represented in this terminal shell.',
                      }
                    : {}),
              });
            }
          } catch {
            reader.diagnose(
              relativeFile,
              'malformed',
              'Source could not be parsed.',
            );
          }
        break;
      }
    }
    // A root watch cannot observe creation of scripts/ inside an existing
    // .github directory. Keep that parent in the bounded watch allocation.
    await reader.directory(`${prefix}.github`);
    for (const directory of shellDirectories) {
      const dir = `${prefix}${directory}`.replace(/\/$/, '');
      const entries = (await reader.directory(dir)).filter(
        (entry) =>
          entry.file &&
          !entry.name.startsWith('.') &&
          (/\.(sh|bash|zsh|ps1)$/.test(entry.name) ||
            !entry.name.includes('.')),
      );
      if (entries.length > DETECTION_LIMITS.shellCandidates)
        reader.diagnose(dir, 'truncated', 'Shell candidate limit reached.');
      for (const entry of entries.slice(0, DETECTION_LIMITS.shellCandidates)) {
        if (manifestGroups.some((group) => group.includes(entry.name)))
          continue;
        const relativeFile = `${dir ? `${dir}/` : ''}${entry.name}`;
        const source = await reader.read(relativeFile);
        if (!source) continue;
        const runner = interpreter(source.head, entry.name, input.platform);
        if (!runner) continue;
        const localFile = `./${directory ? `${directory}/` : ''}${entry.name}`;
        const words =
          input.platform === 'posix' && source.executable
            ? [localFile]
            : runner === 'pwsh'
              ? ['pwsh', '-NoProfile', '-File', localFile]
              : [runner, localFile];
        const command = renderScriptCommand(words, input.shell);
        const rendered = command ?? words.join(' ');
        actions.push({
          id: JSON.stringify([
            'detected',
            input.repoId,
            pkg,
            'shell-script',
            relativeFile,
            entry.name,
          ]),
          kind: 'detected',
          name: entry.name,
          command: rendered,
          multiline: /[\r\n]/.test(rendered),
          repoId: input.repoId,
          repoName: input.repoName,
          packagePath: pkg || null,
          target: { kind: 'repository', repoId: input.repoId },
          source: {
            kind: 'shell-script',
            file: relativeFile,
            entry: entry.name,
            line: 1,
          },
          revision: digest([source, words, pkg, input.shell, input.platform]),
          status: 'pending',
          shortcut: null,
          pinned: false,
          ...(command === null
            ? {
                unavailableReason:
                  'Filename cannot be safely represented in this terminal shell.',
              }
            : {}),
        });
      }
    }
    if (actions.length > DETECTION_LIMITS.repositoryEntries) {
      reader.diagnose('.', 'truncated', 'Repository action limit reached.');
      break;
    }
  }
  return {
    actions: actions.slice(0, DETECTION_LIMITS.repositoryEntries),
    diagnostics: reader.diagnostics,
    complete: reader.diagnostics.length === 0,
    watchedDirectories: Array.from(reader.watchedDirectories).sort(),
  };
}
