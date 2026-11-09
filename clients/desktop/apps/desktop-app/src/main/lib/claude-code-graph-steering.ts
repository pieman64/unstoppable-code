import path from 'node:path';
import { statSync } from 'node:fs';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  getCanonicalCanopyToolKey,
  isCodeGraphInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { validateWorktreeCodeGraphLanguages } from '../code-graph/graph-reads';

const getContextToolName =
  CANOPY_INJECTED_TOOL_REGISTRY.get_code_graph_context.claudeToolName;
const queryToolName =
  CANOPY_INJECTED_TOOL_REGISTRY.query_code_graph.claudeToolName;
const searchToolName =
  CANOPY_INJECTED_TOOL_REGISTRY.search_code_graph.claudeToolName;

export const CLAUDE_CODE_GRAPH_STEERING_CONTEXT = `A code graph exists for this worktree. For structural codebase exploration, call ${getContextToolName}, then ${queryToolName} or ${searchToolName} before Grep, Glob, or broad Read. Use raw files only after graph orientation or for targeted editing/debugging. Apply this workflow in subagents too.`;

interface ClaudeCodeGraphPreToolUseInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  graphAvailable: boolean;
  customSourceExtensions?: readonly string[];
}

const SOURCE_FILE_PATTERN =
  /(?:\.(?:[cm]?[jt]sx?|mdx?)|(?:^|\/)package\.json|(?:^|\/)tsconfig(?:\.[^/]+)?\.json|(?:^|\/)(?:mcp|\.mcp)\.json|(?:^|\/)action\.ya?ml|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml)$/i;
const IGNORED_PATH_PATTERN =
  /(?:^|\/)(?:node_modules|vendor|dist|build|out|coverage|\.git|\.cache|\.next|\.playwright|\.playwright-cli|playwright-report|test-results)(?:\/|$)/;
const ARTIFACT_FILE_EXTENSIONS = new Set([
  '.log',
  '.txt',
  '.out',
  '.err',
  '.jsonl',
  '.ndjson',
  '.csv',
  '.tsv',
  '.har',
  '.snap',
]);
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ag', 'ack']);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CWD_CHANGING_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd']);
// `(` covers extglob `@(a|b)` and zsh `(a|b)` groups.
const SHELL_EXPANSION_CHARACTER = /[*?[{($`]/;
const SHELL_GLOB_CHARACTER = /[*?[{(]/;
const FIND_MUTATING_TOKENS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
]);
const SEARCH_PATTERN_OPTIONS = new Set(['-e', '--regexp', '-f', '--file']);
const SEARCH_NO_PATTERN_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> =
  {
    rg: new Set(['--files', '--type-list']),
  };
const SEARCH_OPTIONS_WITH_VALUES = new Set([
  '--after-context',
  '--before-context',
  '--binary-files',
  '--color',
  '--colors',
  '--context',
  '--context-separator',
  '--encoding',
  '--engine',
  '--exclude',
  '--exclude-dir',
  '--field-context-separator',
  '--glob',
  '--iglob',
  '--include',
  '--label',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--path-separator',
  '--pre',
  '--pre-glob',
  '--sort',
  '--sortr',
  '--type',
  '--type-add',
  '--type-clear',
]);
const SEARCH_SHORT_OPTIONS_WITH_VALUES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  rg: new Set(['-A', '-B', '-C', '-E', '-M', '-m', '-g', '-j', '-t', '-T']),
  grep: new Set(['-A', '-B', '-C', '-D', '-m']),
  fd: new Set(['-d', '-E', '-e', '-j', '-t']),
  ag: new Set(['-A', '-B', '-C', '-G', '-g', '-m']),
  ack: new Set(['-A', '-B', '-C', '-g', '-m']),
};

interface ShellCommand {
  command: string;
  pipelineStart: boolean;
  /** The `&&` or `||` joining it to the previous command, if any. */
  joinedBy: '&&' | '||' | undefined;
}

interface ShellWord {
  value: string;
  quoted: boolean;
  /** Has an unquoted glob, brace or `$`/backtick: the shell may split it. */
  expandable: boolean;
}

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveInWorktree(
  cwd: string,
  candidate: string | undefined,
): string | undefined {
  const pathApi =
    path.win32.isAbsolute(cwd) ||
    (candidate !== undefined && path.win32.isAbsolute(candidate))
      ? path.win32
      : path;
  const worktreeRoot = pathApi.resolve(cwd);
  const resolved = pathApi.resolve(worktreeRoot, candidate ?? '.');
  const relative = pathApi.relative(worktreeRoot, resolved);
  if (
    pathApi.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`)
  ) {
    return undefined;
  }
  return resolved;
}

function splitShellCommands(command: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let pipelineStart = true;
  let joinedBy: ShellCommand['joinedBy'];

  const push = (
    nextPipelineStart: boolean,
    nextJoinedBy?: ShellCommand['joinedBy'],
  ): void => {
    if (current.trim()) {
      commands.push({ command: current.trim(), pipelineStart, joinedBy });
      joinedBy = nextJoinedBy;
    }
    // An empty segment keeps the pending separator, so `&&` then a newline
    // still continues the chain.
    current = '';
    pipelineStart = nextPipelineStart;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (character === ';') {
      push(true);
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && command[index + 1] === '\n') {
        index += 1;
      }
      push(true);
      continue;
    }
    if (character === '|') {
      if (command[index + 1] === '|') {
        index += 1;
        push(true, '||');
      } else {
        push(false);
      }
      continue;
    }
    if (character === '&') {
      if (command[index + 1] === '&') {
        index += 1;
        push(true, '&&');
      } else if (command[index + 1] === '>' || command[index - 1] === '>') {
        current += character;
      } else {
        push(true);
      }
      continue;
    }
    current += character;
  }
  push(true);
  return commands;
}

function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let quoted = false;
  let expandable = false;
  let escaped = false;

  // An empty quoted word ('' or "") is still a shell argument; dropping it
  // would shift every later operand.
  const push = (): void => {
    if (current || quoted) {
      words.push({ value: current, quoted, expandable });
    }
    current = '';
    quoted = false;
    expandable = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      const nextCharacter = command[index + 1];
      if (
        nextCharacter === '\\' ||
        nextCharacter === '"' ||
        nextCharacter === "'" ||
        (nextCharacter !== undefined && /\s/.test(nextCharacter))
      ) {
        escaped = true;
      } else {
        current += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
    } else if (/\s/.test(character)) {
      push();
    } else {
      if (SHELL_EXPANSION_CHARACTER.test(character)) {
        expandable = true;
      }
      current += character;
    }
  }
  push();
  return words;
}

interface ParenBalance {
  /** Unquoted `(` minus `)`. */
  net: number;
  /** Lowest running balance, from 0 at the start. */
  lowest: number;
  closes: number;
}

function unquotedParenBalance(command: string): ParenBalance {
  let net = 0;
  let lowest = 0;
  let closes = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      net += 1;
    } else if (character === ')') {
      net -= 1;
      closes += 1;
      lowest = Math.min(lowest, net);
    }
  }
  return { net, lowest, closes };
}

function isExplicitOutsidePath(
  worktreeRoot: string,
  activeCwd: string,
  candidate: string,
): boolean {
  const pathApi =
    path.win32.isAbsolute(worktreeRoot) || path.win32.isAbsolute(candidate)
      ? path.win32
      : path;
  const resolved = pathApi.resolve(activeCwd, candidate);
  const root = pathApi.resolve(worktreeRoot);
  const escapes = (relative: string): boolean =>
    pathApi.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`);
  // An ancestor such as `..` or `/` contains the worktree.
  return (
    escapes(pathApi.relative(root, resolved)) &&
    escapes(pathApi.relative(resolved, root))
  );
}

/**
 * Whether a glob path can step outside the literal prefix it follows: a `..`
 * segment (through a symlinked match), a `(` group, or a glob segment that
 * starts with `.` or `[` (either can match `..`).
 */
function globSegmentsCanEscape(globPath: string): boolean {
  return globPath
    .split(/[\\/]/)
    .some(
      (segment) =>
        segment === '..' ||
        segment.includes('(') ||
        (/[*?[]/.test(segment) &&
          (segment.startsWith('.') || segment.startsWith('['))),
    );
}

/**
 * Whether a search scope stays outside the worktree. A `$` or backtick scope
 * can name anything; a glob or brace scope is judged by its literal directory
 * prefix.
 */
function isOutsideSearchScope(
  worktreeRoot: string,
  activeCwd: string,
  scope: ShellWord,
): boolean {
  if (/[$`]/.test(scope.value)) {
    return false;
  }
  if (!scope.expandable) {
    return isExplicitOutsidePath(worktreeRoot, activeCwd, scope.value);
  }
  const alternatives = expandSimpleBraceGlob(scope.value);
  return (
    alternatives !== undefined &&
    alternatives.every((alternative) => {
      if (/[{}]/.test(alternative)) {
        return false;
      }
      const globIndex = alternative.search(SHELL_GLOB_CHARACTER);
      if (globIndex === -1) {
        return isExplicitOutsidePath(worktreeRoot, activeCwd, alternative);
      }
      const literalEnd =
        Math.max(
          alternative.lastIndexOf('/', globIndex),
          alternative.lastIndexOf('\\', globIndex),
        ) + 1;
      return (
        !globSegmentsCanEscape(alternative.slice(literalEnd)) &&
        isExplicitOutsidePath(
          worktreeRoot,
          activeCwd,
          alternative.slice(0, literalEnd) || '.',
        )
      );
    })
  );
}

function relativeWorktreePath(
  worktreeRoot: string,
  absolutePath: string,
): string | undefined {
  const pathApi =
    path.win32.isAbsolute(worktreeRoot) || path.win32.isAbsolute(absolutePath)
      ? path.win32
      : path;
  const relative = pathApi.relative(
    pathApi.resolve(worktreeRoot),
    pathApi.resolve(absolutePath),
  );
  if (
    pathApi.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`)
  ) {
    return undefined;
  }
  return relative.replace(/\\/g, '/');
}

function resolveWorktreeRelativePath(
  worktreeRoot: string,
  activeCwd: string,
  candidate: string,
): string | undefined {
  const pathApi =
    path.win32.isAbsolute(worktreeRoot) ||
    path.win32.isAbsolute(activeCwd) ||
    path.win32.isAbsolute(candidate)
      ? path.win32
      : path;
  const absolutePath = pathApi.resolve(activeCwd, candidate);
  return relativeWorktreePath(worktreeRoot, absolutePath);
}

function isArtifactDirectoryPath(filePath: string): boolean {
  return IGNORED_PATH_PATTERN.test(filePath.replace(/\\/g, '/'));
}

function fileExtension(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('/')) {
    return undefined;
  }
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return undefined;
  }
  return basename.slice(dotIndex);
}

function isCustomSourceExtension(
  extension: string,
  customSourceExtensions: readonly string[],
): boolean {
  const normalizedExtension = extension.toLowerCase();
  return customSourceExtensions.some((sourceExtension) => {
    const normalizedSourceExtension = sourceExtension.toLowerCase();
    return (
      normalizedExtension ===
      (normalizedSourceExtension.startsWith('.')
        ? normalizedSourceExtension
        : `.${normalizedSourceExtension}`)
    );
  });
}

function isArtifactFileName(
  filePath: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  const extension = fileExtension(filePath);
  return (
    extension !== undefined &&
    !/[*?{}\[\]]/.test(extension) &&
    ARTIFACT_FILE_EXTENSIONS.has(extension.toLowerCase()) &&
    !isCustomSourceExtension(extension, customSourceExtensions)
  );
}

function isArtifactPath(
  filePath: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  return (
    isArtifactDirectoryPath(filePath) ||
    isArtifactFileName(filePath, customSourceExtensions)
  );
}

function expandSimpleBraceGlob(selector: string): string[] | undefined {
  const openIndex = selector.indexOf('{');
  if (openIndex === -1) {
    return [selector];
  }
  const closeIndex = selector.indexOf('}', openIndex + 1);
  if (
    closeIndex === -1 ||
    selector.indexOf('{', openIndex + 1) !== -1 ||
    selector.indexOf('}', closeIndex + 1) !== -1
  ) {
    return undefined;
  }
  const alternatives = selector.slice(openIndex + 1, closeIndex).split(',');
  if (
    alternatives.length < 2 ||
    alternatives.some((alternative) => !alternative)
  ) {
    return undefined;
  }
  return alternatives.map(
    (alternative) =>
      `${selector.slice(0, openIndex)}${alternative}${selector.slice(closeIndex + 1)}`,
  );
}

function isArtifactSelector(
  selector: string,
  worktreeRoot: string,
  searchCwd: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  if (selector.startsWith('!') || /[$`]/.test(selector)) {
    return false;
  }
  const relativeSelector = resolveWorktreeRelativePath(
    worktreeRoot,
    searchCwd,
    selector,
  );
  if (relativeSelector === undefined) {
    return false;
  }
  const alternatives = expandSimpleBraceGlob(relativeSelector);
  return (
    alternatives !== undefined &&
    alternatives.length > 0 &&
    alternatives.every((alternative) =>
      isArtifactPath(alternative, customSourceExtensions),
    )
  );
}

function isEligibleSourcePath(
  filePath: string,
  worktreeRoot: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  const normalized = relativeWorktreePath(worktreeRoot, filePath);
  return (
    normalized !== undefined &&
    !isArtifactDirectoryPath(normalized) &&
    (SOURCE_FILE_PATTERN.test(normalized) ||
      customSourceExtensions.some((extension) =>
        normalized.toLowerCase().endsWith(extension.toLowerCase()),
      ))
  );
}

/**
 * The custom source extensions the worktree's graph configuration adds, as the
 * worker validates them; none when the configuration is absent or invalid, or
 * the worker cannot answer.
 */
export async function loadConfiguredClaudeCodeGraphSourceExtensions(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<readonly string[]> {
  try {
    const validation = await validateWorktreeCodeGraphLanguages(scope);
    return validation.languages.flatMap((language) => language.extensions);
  } catch {
    return [];
  }
}

function optionConsumesValue(token: string, executable: string): boolean {
  return (
    (executable !== 'fd' && SEARCH_PATTERN_OPTIONS.has(token)) ||
    SEARCH_OPTIONS_WITH_VALUES.has(token) ||
    SEARCH_SHORT_OPTIONS_WITH_VALUES[executable]?.has(token) === true
  );
}

function optionProvidesPattern(token: string, executable: string): boolean {
  if (executable === 'fd') {
    return false;
  }
  return (
    SEARCH_PATTERN_OPTIONS.has(token) ||
    token.startsWith('--regexp=') ||
    token.startsWith('--file=') ||
    (/^-e.+/.test(token) && token !== '-encoding') ||
    /^-f.+/.test(token)
  );
}

function shellRedirect(token: string): { consumesNext: boolean } | undefined {
  const match = /^(?:&>|\d*(?:>>?|<<?|<>|>\|))(.*)$/.exec(token);
  if (!match) {
    return undefined;
  }
  return { consumesNext: match[1] === '' };
}

/** `find` words without shell redirections such as `2>/dev/null`. */
function withoutRedirects(words: ShellWord[]): ShellWord[] {
  const kept: ShellWord[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    if (token === undefined) continue;
    const redirect = token.quoted ? undefined : shellRedirect(token.value);
    if (redirect) {
      if (redirect.consumesNext) index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/** An unquoted `$` or backtick: the shell may split the word or drop it. */
function canWordSplit(word: ShellWord): boolean {
  return word.expandable && /[$`]/.test(word.value);
}

function isIncludeSelectorOption(option: string, executable: string): boolean {
  return executable === 'rg'
    ? option === '-g' || option === '--glob' || option === '--iglob'
    : executable === 'grep' && option === '--include';
}

/**
 * Search scopes, or `undefined` when an expandable pattern or option word may
 * split into several words and shift which operands are scopes.
 */
function searchTargetOperands(
  words: ShellWord[],
  operandStart: number,
  executable: string,
): ShellWord[] | undefined {
  if (executable === 'find') {
    const targets: ShellWord[] = [];
    for (const token of withoutRedirects(words.slice(operandStart))) {
      const word = token.value;
      if (word.startsWith('-') || word === '!' || word === '(') {
        break;
      }
      targets.push(token);
    }
    return targets;
  }

  const targets: ShellWord[] = [];
  let patternProvided = false;
  let noPatternMode = false;
  let optionsEnded = false;
  for (let index = operandStart; index < words.length; index += 1) {
    const token = words[index];
    const word = token?.value ?? '';
    const redirect = token?.quoted ? undefined : shellRedirect(word);
    if (redirect) {
      if (redirect.consumesNext) {
        index += 1;
      }
      continue;
    }
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith('-') && word !== '-') {
      if (token !== undefined && canWordSplit(token)) {
        return undefined;
      }
      if (SEARCH_NO_PATTERN_OPTIONS[executable]?.has(word) === true) {
        noPatternMode = true;
      }
      if (optionProvidesPattern(word, executable)) {
        patternProvided = true;
      }
      if (optionConsumesValue(word, executable)) {
        const value = words[index + 1];
        // An include glob expands only to names it matches, which stay
        // artifact-named wherever they land once the pattern is placed.
        if (
          value?.expandable === true &&
          (canWordSplit(value) ||
            !isIncludeSelectorOption(word, executable) ||
            !(patternProvided || noPatternMode))
        ) {
          return undefined;
        }
        index += 1;
      }
      continue;
    }
    if (token === undefined) {
      continue;
    }
    if (noPatternMode) {
      targets.push(token);
      continue;
    }
    if (!patternProvided) {
      if (token.expandable) {
        return undefined;
      }
      patternProvided = true;
      continue;
    }
    targets.push(token);
  }
  return targets;
}

function findExpressionStart(words: string[], operandStart: number): number {
  let index = operandStart;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (word.startsWith('-') || word === '!' || word === '(') {
      break;
    }
    index += 1;
  }
  return index;
}

function fdExtensionSelector(extension: string): string {
  return `*.${extension.startsWith('.') ? extension.slice(1) : extension}`;
}

function findFileSelectors(
  tokens: ShellWord[],
  operandStart: number,
): string[] {
  const words = withoutRedirects(tokens.slice(operandStart));
  const values = words.map(({ value }) => value);
  let index = findExpressionStart(values, 0);
  const selectors: string[] = [];
  while (index < words.length) {
    const option = values[index] ?? '';
    const value = values[index + 1];
    if (
      (option === '-print' || option === '-print0') &&
      index === words.length - 1
    ) {
      break;
    }
    if (
      option === '-name' ||
      option === '-iname' ||
      option === '-path' ||
      option === '-ipath' ||
      option === '-wholename' ||
      option === '-iwholename'
    ) {
      if (value === undefined) {
        return [];
      }
      selectors.push(value);
      index += 2;
      continue;
    }
    if (option === '-a' || option === '-and') {
      index += 1;
      continue;
    }
    if (
      option === '-type' ||
      option === '-maxdepth' ||
      option === '-mindepth'
    ) {
      if (value === undefined) {
        return [];
      }
      index += 2;
      continue;
    }
    return [];
  }
  return selectors;
}

interface ParsedFileSelectorOption {
  selector?: string;
  consumesNext: boolean;
}

function parseFileSelectorOption(
  words: ShellWord[],
  index: number,
  executable: string,
): ParsedFileSelectorOption | undefined {
  const word = words[index]?.value ?? '';
  if (executable === 'rg') {
    if (word === '-g' || word === '--glob' || word === '--iglob') {
      return { selector: words[index + 1]?.value, consumesNext: true };
    }
    if (word.startsWith('--glob=') || word.startsWith('--iglob=')) {
      return {
        selector: word.slice(word.indexOf('=') + 1),
        consumesNext: false,
      };
    }
    if (word.startsWith('-g') && word.length > 2) {
      return { selector: word.slice(2), consumesNext: false };
    }
  }
  if (executable === 'grep') {
    if (word === '--include') {
      return { selector: words[index + 1]?.value, consumesNext: true };
    }
    if (word.startsWith('--include=')) {
      return {
        selector: word.slice('--include='.length),
        consumesNext: false,
      };
    }
  }
  if (executable === 'fd') {
    if (word === '-e' || word === '--extension') {
      const extension = words[index + 1]?.value;
      return {
        selector:
          extension === undefined ? undefined : fdExtensionSelector(extension),
        consumesNext: true,
      };
    }
    if (word.startsWith('--extension=')) {
      return {
        selector: fdExtensionSelector(word.slice('--extension='.length)),
        consumesNext: false,
      };
    }
    if (word.startsWith('-e') && word.length > 2) {
      return {
        selector: fdExtensionSelector(word.slice(2)),
        consumesNext: false,
      };
    }
  }
  return undefined;
}

function commandFileSelectors(
  words: ShellWord[],
  operandStart: number,
  executable: string,
): string[] {
  const selectors: string[] = [];
  let optionsEnded = false;
  for (let index = operandStart; index < words.length; index += 1) {
    const token = words[index];
    const word = token?.value ?? '';
    const redirect = token?.quoted ? undefined : shellRedirect(word);
    if (redirect) {
      if (redirect.consumesNext) {
        index += 1;
      }
      continue;
    }
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      continue;
    }

    const parsedSelector = parseFileSelectorOption(words, index, executable);
    if (parsedSelector) {
      const { selector } = parsedSelector;
      if (selector !== undefined && !selector.startsWith('!')) {
        selectors.push(selector);
      }
      if (parsedSelector.consumesNext) {
        index += 1;
      }
      continue;
    }
    if (optionConsumesValue(word, executable)) {
      index += 1;
    }
  }
  return selectors;
}

function searchFileSelectors(
  words: ShellWord[],
  operandStart: number,
  executable: string,
): string[] {
  return executable === 'find'
    ? findFileSelectors(words, operandStart)
    : commandFileSelectors(words, operandStart, executable);
}

function isNegativeGitPathspec(pathspec: string): boolean {
  if (pathspec.startsWith(':!') || pathspec.startsWith(':^')) {
    return true;
  }
  if (!pathspec.startsWith(':(')) {
    return false;
  }
  const closeIndex = pathspec.indexOf(')');
  return (
    closeIndex !== -1 &&
    pathspec.slice(2, closeIndex).split(',').includes('exclude')
  );
}

function stripGitPathspecMagic(pathspec: string): string {
  if (!pathspec.startsWith(':(')) {
    return pathspec;
  }
  const closeIndex = pathspec.indexOf(')');
  return closeIndex === -1 ? pathspec : pathspec.slice(closeIndex + 1);
}

/**
 * An artifact-named path that is a directory may hold sources, and one that
 * cannot be stat-ed (EACCES, ELOOP) stays gated. Callers pass only paths the
 * search receives verbatim; the `statSync` runs only for an artifact name.
 */
function isArtifactFileTarget(
  rawPath: string,
  absolutePath: string,
  relativePath: string,
  customSourceExtensions: readonly string[],
): boolean {
  if (
    rawPath.replace(/\\/g, '/').endsWith('/') ||
    !isArtifactFileName(relativePath, customSourceExtensions)
  ) {
    return false;
  }
  try {
    return (
      statSync(absolutePath, { throwIfNoEntry: false })?.isDirectory() !== true
    );
  } catch {
    return false;
  }
}

/**
 * Whether every path a shell glob or brace scope can expand to stays inside an
 * artifact directory. Nested braces stay gated, as do segments that can step
 * upward (see `globSegmentsCanEscape`).
 */
function expandedScopeStaysInArtifactDirectory(
  scope: string,
  worktreeRoot: string,
  activeCwd: string,
): boolean {
  const alternatives = expandSimpleBraceGlob(scope);
  return (
    alternatives !== undefined &&
    alternatives.every((alternative) => {
      if (/[{}]/.test(alternative) || globSegmentsCanEscape(alternative)) {
        return false;
      }
      const relativePath = resolveWorktreeRelativePath(
        worktreeRoot,
        activeCwd,
        alternative,
      );
      return (
        relativePath !== undefined && isArtifactDirectoryPath(relativePath)
      );
    })
  );
}

/**
 * Whether a literal non-artifact scope can only be a directory, so file
 * selectors filter what the search reads. A named file is searched whatever
 * the selectors; a missing path reads nothing.
 */
function isSelectorFilteredScope(
  scope: string,
  relativePath: string | undefined,
  worktreeRoot: string,
): boolean {
  const normalized = scope.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  // Callers drop outside scopes, so an unresolved one is an ancestor.
  if (
    relativePath === undefined ||
    normalized.endsWith('/') ||
    basename === '.' ||
    basename === '..'
  ) {
    return true;
  }
  try {
    const stats = statSync(path.join(worktreeRoot, relativePath), {
      throwIfNoEntry: false,
    });
    return stats === undefined || stats.isDirectory();
  } catch {
    return false;
  }
}

function searchScopesAreArtifactOnly(
  targets: ShellWord[],
  worktreeRoot: string,
  activeCwd: string,
  selectors: string[],
  customSourceExtensions: readonly string[] = [],
): boolean {
  const scopes = targets.length > 0 ? targets : [undefined];
  const constrainedBySelectors =
    selectors.length > 0 &&
    selectors.every((selector) =>
      isArtifactSelector(
        selector,
        worktreeRoot,
        activeCwd,
        customSourceExtensions,
      ),
    );

  return scopes.every((token) => {
    if (token === undefined) {
      return (
        isArtifactDirectoryPath(
          relativeWorktreePath(worktreeRoot, activeCwd) ?? '',
        ) || constrainedBySelectors
      );
    }
    const scope = token.value;
    // The shell turns these into paths the search reads whatever its
    // selectors, so only a scope kept inside an artifact directory passes.
    if (/[$`]/.test(scope)) {
      return false;
    }
    if (token.expandable) {
      return expandedScopeStaysInArtifactDirectory(
        scope,
        worktreeRoot,
        activeCwd,
      );
    }
    const relativePath = resolveWorktreeRelativePath(
      worktreeRoot,
      activeCwd,
      scope,
    );
    if (
      relativePath !== undefined &&
      (isArtifactDirectoryPath(relativePath) ||
        isArtifactFileTarget(
          scope,
          path.join(worktreeRoot, relativePath),
          relativePath,
          customSourceExtensions,
        ))
    ) {
      return true;
    }
    if (fileExtension(scope) !== undefined) {
      return false;
    }
    return (
      constrainedBySelectors &&
      isSelectorFilteredScope(scope, relativePath, worktreeRoot)
    );
  });
}

function grepOrGlobTargetsWorktree(
  toolName: 'Grep' | 'Glob',
  toolInput: Record<string, unknown>,
  cwd: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  const pathValue = stringField(toolInput, 'path');
  const target = resolveInWorktree(cwd, pathValue);
  const relativeTarget = target ? relativeWorktreePath(cwd, target) : undefined;
  if (!target || relativeTarget === undefined) {
    return false;
  }
  const artifactTarget =
    isArtifactDirectoryPath(relativeTarget) ||
    (pathValue !== undefined &&
      isArtifactFileTarget(
        pathValue,
        path.join(cwd, relativeTarget),
        relativeTarget,
        customSourceExtensions,
      ));
  if (artifactTarget) {
    return false;
  }
  const filePattern =
    toolName === 'Glob'
      ? stringField(toolInput, 'pattern')
      : stringField(toolInput, 'glob');
  if (
    filePattern &&
    isArtifactSelector(filePattern, cwd, target, customSourceExtensions) &&
    (toolName === 'Glob' ||
      pathValue === undefined ||
      pathValue.replace(/\\/g, '/').endsWith('/') ||
      fileExtension(pathValue) === undefined)
  ) {
    return false;
  }
  return (
    !filePattern ||
    filePattern.includes('*') ||
    filePattern.includes('{') ||
    filePattern.includes('[') ||
    SOURCE_FILE_PATTERN.test(filePattern)
  );
}

function bashTargetsWorktreeSearch(
  command: string | undefined,
  cwd: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  if (!command) {
    return false;
  }
  const startCwd = path.win32.isAbsolute(cwd)
    ? path.win32.resolve(cwd)
    : path.resolve(cwd);
  let activeCwd: string | undefined = startCwd;
  // A literal `cd` carries only through `&&` at the subshell depth it ran in;
  // a later `;`, `||`, `|`, `&`, newline or closing `)` may skip or undo it.
  let cdDepth: number | undefined;
  let depth = 0;
  let lowestDepthSinceCd = 0;
  let forgetCwd = false;
  for (const shellCommand of splitShellCommands(command)) {
    if (
      forgetCwd ||
      (cdDepth !== undefined &&
        (shellCommand.joinedBy !== '&&' || lowestDepthSinceCd < cdDepth))
    ) {
      activeCwd = undefined;
    }
    const parens = unquotedParenBalance(shellCommand.command);
    lowestDepthSinceCd = Math.min(lowestDepthSinceCd, depth + parens.lowest);
    depth += parens.net;
    const wordTokens = shellWords(shellCommand.command);
    const words = wordTokens.map(({ value }) => value);
    let commandIndex = 0;
    while (ENV_ASSIGNMENT_PATTERN.test(words[commandIndex] ?? '')) {
      commandIndex += 1;
    }
    const executable = (words[commandIndex] ?? '').replace(/^\(+/, '');
    if (shellCommand.pipelineStart && executable === 'cd') {
      const cdOperands = withoutRedirects(wordTokens.slice(commandIndex + 1));
      const targetToken = cdOperands[0];
      // `||` skips the `cd` when its left side succeeds; zsh reads
      // `cd old new` as a substitution in $PWD.
      if (
        !activeCwd ||
        shellCommand.joinedBy === '||' ||
        cdOperands.length !== 1 ||
        !targetToken ||
        targetToken.expandable ||
        /[$`]/.test(targetToken.value) ||
        /^[-~]/.test(targetToken.value) ||
        parens.closes > 0
      ) {
        activeCwd = undefined;
      } else {
        activeCwd = path.win32.isAbsolute(activeCwd)
          ? path.win32.resolve(activeCwd, targetToken.value)
          : path.resolve(activeCwd, targetToken.value);
        cdDepth = depth;
        lowestDepthSinceCd = depth;
      }
      continue;
    }
    const isGitGrep =
      executable === 'git' && words[commandIndex + 1] === 'grep';
    // Any other directory changer (`pushd`, `builtin cd`, `{ cd`, a piped
    // `cd`) is not parsed: later commands run in an unknown directory. A
    // search's own arguments are not commands.
    forgetCwd ||=
      !SEARCH_COMMANDS.has(executable) &&
      !isGitGrep &&
      wordTokens.some(
        ({ value, quoted }, index) =>
          (index === commandIndex || !quoted) &&
          CWD_CHANGING_COMMANDS.has(value.replace(/^\(+/, '')),
      );
    if (!shellCommand.pipelineStart) {
      continue;
    }
    if (!SEARCH_COMMANDS.has(executable) && !isGitGrep) {
      continue;
    }
    if (
      executable === 'find' &&
      words.some((word) => FIND_MUTATING_TOKENS.has(word))
    ) {
      continue;
    }
    // The directory is unknown after an unproven directory change.
    if (!activeCwd) {
      return true;
    }
    const searchCwd = activeCwd;
    const operandStart = commandIndex + (isGitGrep ? 2 : 1);
    const operands = searchTargetOperands(
      wordTokens,
      operandStart,
      isGitGrep ? 'grep' : executable,
    );
    if (operands === undefined) {
      return true;
    }
    const scopes = isGitGrep
      ? operands
          .filter(({ value }) => !isNegativeGitPathspec(value))
          .map((operand) => ({
            ...operand,
            value: stripGitPathspecMagic(operand.value),
          }))
      : operands;
    // Outside scopes are not worktree exploration; any other scope still is.
    const targets = scopes.filter(
      (scope) => !isOutsideSearchScope(cwd, searchCwd, scope),
    );
    if (
      scopes.length > 0
        ? targets.length === 0
        : isExplicitOutsidePath(cwd, searchCwd, '.')
    ) {
      continue;
    }
    const selectors = isGitGrep
      ? []
      : searchFileSelectors(wordTokens, operandStart, executable);
    // A `cd` may fail or sit in a subshell, so the tracked directory is not
    // trusted for the artifact exemption.
    if (
      searchCwd !== startCwd ||
      !searchScopesAreArtifactOnly(
        targets,
        cwd,
        searchCwd,
        selectors,
        customSourceExtensions,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isClaudeCodeGraphToolName(toolName: string): boolean {
  const key = getCanonicalCanopyToolKey(toolName);
  return key !== null && isCodeGraphInjectedToolKey(key);
}

export function isClaudeCodeGraphBuildToolName(toolName: string): boolean {
  return getCanonicalCanopyToolKey(toolName) === 'build_or_update_code_graph';
}

export function isClaudeCodeGraphPostToolUse(
  hookEventName: string,
  toolName: unknown,
): boolean {
  return (
    hookEventName === 'PostToolUse' &&
    typeof toolName === 'string' &&
    isClaudeCodeGraphToolName(toolName)
  );
}

export function buildClaudeCodeGraphPreToolUseContext({
  toolName,
  toolInput,
  cwd,
  graphAvailable,
  customSourceExtensions,
}: ClaudeCodeGraphPreToolUseInput): string | undefined {
  if (!graphAvailable) {
    return undefined;
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    return grepOrGlobTargetsWorktree(
      toolName,
      toolInput,
      cwd,
      customSourceExtensions,
    )
      ? CLAUDE_CODE_GRAPH_STEERING_CONTEXT
      : undefined;
  }
  if (toolName === 'Read') {
    if (
      typeof toolInput.offset === 'number' ||
      typeof toolInput.limit === 'number'
    ) {
      return undefined;
    }
    const filePath = resolveInWorktree(
      cwd,
      stringField(toolInput, 'file_path') ?? stringField(toolInput, 'path'),
    );
    return filePath &&
      isEligibleSourcePath(filePath, cwd, customSourceExtensions)
      ? CLAUDE_CODE_GRAPH_STEERING_CONTEXT
      : undefined;
  }
  if (toolName === 'Bash') {
    return bashTargetsWorktreeSearch(
      stringField(toolInput, 'command'),
      cwd,
      customSourceExtensions,
    )
      ? CLAUDE_CODE_GRAPH_STEERING_CONTEXT
      : undefined;
  }
  return undefined;
}
