import { createHash } from 'node:crypto';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import { SourceReader, DETECTION_LIMITS } from './source-reader';
import type { ScriptTerminalShell } from './render-command';
export const SHELL_ALIAS_FILES = [
  '.bashrc',
  '.bash_aliases',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zsh_aliases',
  '.config/fish/config.fish',
] as const;
const allowed = new Set(
  'npm pnpm yarn bun npx pnpx bunx deno node make just task cargo go git gh docker docker-compose podman kubectl helm terraform python python3 pip uv poetry pdm poe pytest ruby bundle rails rake php composer mvn gradle ./gradlew dotnet swift xcodebuild flutter dart mix elixir'.split(
    ' ',
  ),
);
export interface DetectionResult {
  actions: ScriptAction[];
  diagnostics: SourceReader['diagnostics'];
  complete: boolean;
  watchedDirectories: string[];
}

/** Tracks literal multiline text without evaluating any shell syntax. */
function literalContext(): (line: string) => boolean {
  let quote: string | null = null;
  const documents: { delimiter: string; stripTabs: boolean }[] = [];
  let uncertain = false;
  return (line): boolean => {
    if (uncertain) return true;
    const document = documents[0];
    if (document) {
      const text = document.stripTabs ? line.replace(/^\t+/, '') : line;
      if (text === document.delimiter) documents.shift();
      return true;
    }
    let literal = quote !== null;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '\\' && quote !== "'") {
        i++;
        continue;
      }
      if (quote !== null) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '#' && (i === 0 || /[\s;]/.test(line[i - 1] ?? ''))) break;
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '<' && line[i + 1] === '<') {
        literal = true;
        // Here strings, expanded delimiters and unknown forms fail closed.
        const match =
          /^<<(-?)\s*(?:'([\w-]+)'|"([\w-]+)"|([\w-]+))(?=\s|;|$)/.exec(
            line.slice(i),
          );
        const delimiter = match?.[2] ?? match?.[3] ?? match?.[4];
        if (!match || !delimiter) {
          uncertain = true;
          return true;
        }
        documents.push({ delimiter, stripTabs: match[1] === '-' });
        i += match[0].length - 1;
      }
    }
    return literal || quote !== null;
  };
}
function eligible(value: string): boolean {
  const word = /^(?:'([^']+)'|"([^"\\]+)"|([^\s;&|]+))/.exec(value);
  const first = word?.[1] ?? word?.[2] ?? word?.[3] ?? '';
  return (
    allowed.has(first) || /^(?:\.\/|\.\.\/|~\/|\/)[^\s;|&]*\.sh$/.test(first)
  );
}
/** Conservative line parser: any uncertain block suppresses aliases until a known closing line. */
export function parseStaticAliases(
  content: string,
  fish: boolean,
): { name: string; command: string; line: number }[] {
  const entries: { name: string; command: string; line: number }[] = [];
  let depth = 0;
  let continuation = false;
  const inLiteral = literalContext();
  content.split(/\r?\n/).forEach((line, index) => {
    if (inLiteral(line)) return;
    const text = line.trim();
    const wasContinuation = continuation;
    continuation = /\\$/.test(line);
    if (continuation || wasContinuation || !text || text.startsWith('#'))
      return;
    if (/^(?:fi|done|esac|end|\}|\))(?:\s|;|$)/.test(text)) {
      depth = Math.max(0, depth - 1);
      return;
    }
    if (
      /^(?:if|for|while|until|case|select|function|begin|switch)\b/.test(
        text,
      ) ||
      /^[\w-]+\s*\(\)/.test(text) ||
      /^\(/.test(text) ||
      /[{}]/.test(text)
    ) {
      depth++;
      return;
    }
    if (depth || !text.startsWith('alias ')) return;
    let remaining = text;
    const found: { name: string; command: string; line: number }[] = [];
    while (remaining && !remaining.startsWith('#')) {
      const match = (
        fish
          ? /^alias\s+([A-Za-z_][\w-]*)\s+(['"])((?:\\.|[^\\])*?)\2\s*/
          : /^alias\s+([A-Za-z_][\w-]*)=(['"])((?:\\.|[^\\])*?)\2\s*/
      ).exec(remaining);
      if (!match?.[1] || match[3] === undefined || !match[2]) return;
      // Do not reinterpret shell escapes or transfer substitutions to a new shell.
      const raw = match[3];
      if (/[$`\\]|[<>]\(/.test(raw) || !eligible(raw)) return;
      found.push({ name: match[1], command: raw, line: index + 1 });
      remaining = remaining.slice(match[0].length).trimStart();
      if (remaining.startsWith(';')) remaining = remaining.slice(1).trimStart();
      else if (remaining && !remaining.startsWith('#')) return;
    }
    entries.push(...found);
  });
  return entries;
}
export async function detectShellAliases(input: {
  home: string;
  shell: ScriptTerminalShell;
}): Promise<DetectionResult> {
  const reader = new SourceReader(input.home);
  const actions: ScriptAction[] = [];
  if (!(await reader.requireRoot()))
    return {
      actions,
      diagnostics: reader.diagnostics,
      complete: false,
      watchedDirectories: [],
    };
  for (const file of SHELL_ALIAS_FILES) {
    const source = await reader.read(file);
    if (!source) continue;
    const found = parseStaticAliases(source.content, file.endsWith('.fish'));
    if (found.length > DETECTION_LIMITS.sourceEntries)
      reader.diagnose(`~/${file}`, 'truncated', 'Alias entry limit reached.');
    for (const entry of found.slice(0, DETECTION_LIMITS.sourceEntries)) {
      const fish = file.endsWith('.fish');
      const incompatible = fish
        ? input.shell !== 'fish'
        : input.shell === 'fish' ||
          input.shell === 'cmd' ||
          input.shell === 'powershell';
      const definition = {
        file,
        ...entry,
        digest: source.digest,
        shell: input.shell,
      };
      actions.push({
        id: JSON.stringify(['alias', file, entry.name]),
        kind: 'alias',
        name: entry.name,
        command: entry.command,
        multiline: /[\r\n]/.test(entry.command),
        repoId: null,
        repoName: null,
        packagePath: null,
        target: { kind: 'selected-repository' },
        source: {
          kind: 'shell-alias',
          file: `~/${file}`,
          entry: entry.name,
          line: entry.line,
        },
        revision: createHash('sha256')
          .update(JSON.stringify(definition))
          .digest('hex'),
        status: 'pending',
        pinned: false,
        shortcut: null,
        ...(incompatible
          ? {
              unavailableReason:
                'Alias syntax is incompatible with the terminal shell.',
            }
          : {}),
      });
    }
  }
  // A repeated declaration in one file has shell-specific precedence; retain only the last literal.
  const unique = new Map(actions.map((action) => [action.id, action]));
  return {
    actions: Array.from(unique.values()),
    diagnostics: reader.diagnostics,
    complete: reader.diagnostics.length === 0,
    watchedDirectories: Array.from(reader.watchedDirectories),
  };
}
