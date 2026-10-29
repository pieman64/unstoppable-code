import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  getCanonicalCanopyToolKey,
  isCodeGraphInjectedToolKey,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
  customLanguagesConfigPath,
  parseCustomLanguagesConfig,
  readBoundedCodeGraphCustomLanguageFile,
  validateCustomLanguageEntries,
} from '@canopy/desktop-shared/node/code-graph/languages/custom-config';

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
  graphOriented: boolean;
  customSourceExtensions?: readonly string[];
}

const SOURCE_FILE_PATTERN =
  /(?:\.(?:[cm]?[jt]sx?|mdx?)|(?:^|\/)package\.json|(?:^|\/)tsconfig(?:\.[^/]+)?\.json|(?:^|\/)(?:mcp|\.mcp)\.json|(?:^|\/)action\.ya?ml|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml)$/i;
const IGNORED_PATH_PATTERN =
  /(?:^|\/)(?:node_modules|vendor|dist|build|out|coverage|\.git|\.cache|\.next)(?:\/|$)/;
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ag', 'ack']);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
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
}

interface ShellWord {
  value: string;
  quoted: boolean;
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

  const push = (nextPipelineStart: boolean): void => {
    if (current.trim()) {
      commands.push({ command: current.trim(), pipelineStart });
    }
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
        push(true);
      } else {
        push(false);
      }
      continue;
    }
    if (character === '&') {
      if (command[index + 1] === '&') {
        index += 1;
        push(true);
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
  let escaped = false;

  const push = (): void => {
    if (current) {
      words.push({ value: current, quoted });
      current = '';
      quoted = false;
    }
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
      current += character;
    }
  }
  push();
  return words;
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
  const relative = pathApi.relative(pathApi.resolve(worktreeRoot), resolved);
  return (
    pathApi.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`)
  );
}

function isEligibleSourcePath(
  filePath: string,
  customSourceExtensions: readonly string[] = [],
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    !IGNORED_PATH_PATTERN.test(normalized) &&
    (SOURCE_FILE_PATTERN.test(normalized) ||
      customSourceExtensions.some((extension) =>
        normalized.toLowerCase().endsWith(extension.toLowerCase()),
      ))
  );
}

export async function loadConfiguredClaudeCodeGraphSourceExtensions(
  cwd: string,
): Promise<readonly string[]> {
  try {
    const configPath = customLanguagesConfigPath(cwd);
    const configRealPath = await realpath(configPath);
    const config = await readBoundedCodeGraphCustomLanguageFile(
      configPath,
      configRealPath,
      CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
    );
    if (config.kind !== 'present') {
      return [];
    }
    const parsed = parseCustomLanguagesConfig(config.bytes.toString('utf8'));
    if (!parsed.ok) {
      return [];
    }
    return validateCustomLanguageEntries(parsed.rawEntries).entries.flatMap(
      (entry) => entry.extensions,
    );
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

function searchTargetOperands(
  words: ShellWord[],
  operandStart: number,
  executable: string,
): string[] {
  if (executable === 'find') {
    const targets: string[] = [];
    for (const { value: word } of words.slice(operandStart)) {
      if (word.startsWith('-') || word === '!' || word === '(') {
        break;
      }
      targets.push(word);
    }
    return targets;
  }

  const targets: string[] = [];
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
      if (SEARCH_NO_PATTERN_OPTIONS[executable]?.has(word) === true) {
        noPatternMode = true;
      }
      if (optionProvidesPattern(word, executable)) {
        patternProvided = true;
      }
      if (optionConsumesValue(word, executable)) {
        index += 1;
      }
      continue;
    }
    if (noPatternMode) {
      targets.push(word);
      continue;
    }
    if (!patternProvided) {
      patternProvided = true;
      continue;
    }
    targets.push(word);
  }
  return targets;
}

function grepOrGlobTargetsWorktree(
  toolName: 'Grep' | 'Glob',
  toolInput: Record<string, unknown>,
  cwd: string,
): boolean {
  const target = resolveInWorktree(cwd, stringField(toolInput, 'path'));
  if (!target || IGNORED_PATH_PATTERN.test(target.replace(/\\/g, '/'))) {
    return false;
  }
  const filePattern =
    toolName === 'Glob'
      ? stringField(toolInput, 'pattern')
      : stringField(toolInput, 'glob');
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
): boolean {
  if (!command) {
    return false;
  }
  let activeCwd: string | undefined = path.win32.isAbsolute(cwd)
    ? path.win32.resolve(cwd)
    : path.resolve(cwd);
  for (const shellCommand of splitShellCommands(command)) {
    if (!shellCommand.pipelineStart) {
      continue;
    }
    const wordTokens = shellWords(shellCommand.command);
    const words = wordTokens.map(({ value }) => value);
    let commandIndex = 0;
    while (ENV_ASSIGNMENT_PATTERN.test(words[commandIndex] ?? '')) {
      commandIndex += 1;
    }
    const executable = (words[commandIndex] ?? '').replace(/^\(+/, '');
    if (executable === 'cd') {
      const target = words[commandIndex + 1];
      if (!activeCwd || !target || /[$`]/.test(target)) {
        activeCwd = undefined;
      } else {
        activeCwd = path.win32.isAbsolute(activeCwd)
          ? path.win32.resolve(activeCwd, target)
          : path.resolve(activeCwd, target);
      }
      continue;
    }
    const isGitGrep =
      executable === 'git' && words[commandIndex + 1] === 'grep';
    if (!SEARCH_COMMANDS.has(executable) && !isGitGrep) {
      continue;
    }
    if (!activeCwd || !resolveInWorktree(cwd, activeCwd)) {
      continue;
    }
    const searchCwd = activeCwd;
    if (
      executable === 'find' &&
      words.some((word) => FIND_MUTATING_TOKENS.has(word))
    ) {
      continue;
    }
    const operandStart = commandIndex + (isGitGrep ? 2 : 1);
    const hasOutsideTarget = searchTargetOperands(
      wordTokens,
      operandStart,
      isGitGrep ? 'grep' : executable,
    ).some((word) => isExplicitOutsidePath(cwd, searchCwd, word));
    if (!hasOutsideTarget) {
      return true;
    }
  }
  return false;
}

export function isClaudeCodeGraphToolName(toolName: string): boolean {
  const key = getCanonicalCanopyToolKey(toolName);
  return key !== null && isCodeGraphInjectedToolKey(key);
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
  graphOriented,
  customSourceExtensions,
}: ClaudeCodeGraphPreToolUseInput): string | undefined {
  if (!graphAvailable || graphOriented) {
    return undefined;
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    return grepOrGlobTargetsWorktree(toolName, toolInput, cwd)
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
    return filePath && isEligibleSourcePath(filePath, customSourceExtensions)
      ? CLAUDE_CODE_GRAPH_STEERING_CONTEXT
      : undefined;
  }
  if (toolName === 'Bash') {
    return bashTargetsWorktreeSearch(stringField(toolInput, 'command'), cwd)
      ? CLAUDE_CODE_GRAPH_STEERING_CONTEXT
      : undefined;
  }
  return undefined;
}
