function unwrapShellWrappedCommand(command: string): string {
  const trimmed = command.trim();
  const singleQuotedShellWrapMatch = trimmed.match(
    /^\/bin\/\S+\s+-\S+\s+'((?:[^'\\]|\\.)*)'$/,
  );
  if (singleQuotedShellWrapMatch) {
    return singleQuotedShellWrapMatch[1].replace(/\\(['"\\])/g, '$1');
  }

  const doubleQuotedShellWrapMatch = trimmed.match(
    /^\/bin\/\S+\s+-\S+\s+"((?:[^"\\]|\\.)*)"$/,
  );
  if (doubleQuotedShellWrapMatch) {
    return doubleQuotedShellWrapMatch[1].replace(/\\(['"\\])/g, '$1');
  }

  const windowsCommandPrefixMatch = trimmed.match(
    /^["'][^"']*\\(?:pwsh|powershell)\.exe["']\s+-Command\b\s*/i,
  );
  if (windowsCommandPrefixMatch) {
    const payload = trimmed.slice(windowsCommandPrefixMatch[0].length).trim();
    const unwrappedPayload = unwrapWholeQuotedPayload(payload) ?? payload;
    return unwrappedPayload.replace(/\\(['"\\])/g, '$1');
  }

  return trimmed;
}

function isWindowsPowerShellWrappedCommand(command: string): boolean {
  return /^["'][^"']*\\(?:pwsh|powershell)\.exe["']\s+-Command\b\s*/i.test(
    command.trim(),
  );
}

function unwrapWholeQuotedPayload(payload: string): string | null {
  const quote = payload[0];
  if (quote !== "'" && quote !== '"') {
    return payload.length > 0 ? payload : null;
  }

  let escaped = false;
  for (let index = 1; index < payload.length; index += 1) {
    const char = payload[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote && payload.slice(index + 1).trim().length === 0) {
      return payload.slice(1, index);
    }
  }

  return null;
}

const POWERSHELL_FILE_ARGUMENT_PATTERN = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;]+))`;
const POWERSHELL_GET_CONTENT_COMMAND_PATTERN = String.raw`(?:Get-Content|gc|cat|type)`;
const POWERSHELL_GET_CONTENT_NAMES = new Set([
  'get-content',
  'gc',
  'cat',
  'type',
]);
const POWERSHELL_GET_CONTENT_ALIASES = new Set(['gc', 'cat', 'type']);
const POWERSHELL_SELECT_OBJECT_NAMES = new Set(['select-object', 'select']);
const POWERSHELL_IGNORED_SWITCHES = new Set(['force']);
const POWERSHELL_IGNORED_VALUE_OPTIONS = new Set([
  'encoding',
  'erroraction',
  'readcount',
]);

type ParsedPowerShellGetContent = {
  filePath: string;
  first?: string;
  last?: string;
  raw?: boolean;
};

type ParsedCodexReadLinesCommand =
  | { filePath: string; start: string; end: string }
  | { filePath: string; last: string };

function getMatchedFileArgument(
  match: RegExpMatchArray,
  startIndex: number,
): string {
  return (
    match[startIndex] ?? match[startIndex + 1] ?? match[startIndex + 2] ?? ''
  );
}

function tokenizePowerShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '`' && quote === '"') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === '|') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function incrementDecimalString(value: string): string {
  const digits = value.split('');

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== '9') {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join('');
    }

    digits[index] = '0';
  }

  return `1${digits.join('')}`;
}

function normalizePowerShellOption(token: string): string | null {
  return token.startsWith('-') && token.length > 1
    ? token.slice(1).toLowerCase()
    : null;
}

function isPositiveIntegerToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^\d+$/.test(token);
}

function parsePowerShellGetContentTokens(
  tokens: string[],
  options?: { allowAliases?: boolean },
): ParsedPowerShellGetContent | null {
  const commandName = tokens[0]?.toLowerCase();
  if (!commandName || !POWERSHELL_GET_CONTENT_NAMES.has(commandName)) {
    return null;
  }
  if (
    !options?.allowAliases &&
    POWERSHELL_GET_CONTENT_ALIASES.has(commandName)
  ) {
    return null;
  }

  let filePath = '';
  let first: string | undefined;
  let last: string | undefined;
  let raw = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const option = normalizePowerShellOption(token);
    if (!option) {
      if (filePath.length > 0) {
        return null;
      }
      filePath = token;
      continue;
    }

    if (option === 'path' || option === 'literalpath') {
      const value = tokens[index + 1];
      if (!value || filePath.length > 0) {
        return null;
      }
      filePath = value;
      index += 1;
      continue;
    }

    if (option === 'totalcount' || option === 'head' || option === 'first') {
      const value = tokens[index + 1];
      if (!isPositiveIntegerToken(value) || first || last) {
        return null;
      }
      first = value;
      index += 1;
      continue;
    }

    if (option === 'tail') {
      const value = tokens[index + 1];
      if (!isPositiveIntegerToken(value) || first || last) {
        return null;
      }
      last = value;
      index += 1;
      continue;
    }

    if (option === 'raw') {
      raw = true;
      continue;
    }

    if (POWERSHELL_IGNORED_SWITCHES.has(option)) {
      continue;
    }

    if (POWERSHELL_IGNORED_VALUE_OPTIONS.has(option)) {
      const value = tokens[index + 1];
      if (!value || normalizePowerShellOption(value)) {
        return null;
      }
      index += 1;
      continue;
    }

    return null;
  }

  if (filePath.length === 0) {
    return null;
  }

  return {
    filePath,
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(raw ? { raw } : {}),
  };
}

function parsePowerShellSelectObjectTokens(tokens: string[]): {
  first?: string;
  last?: string;
  skip?: string;
} | null {
  const commandName = tokens[0]?.toLowerCase();
  if (!commandName || !POWERSHELL_SELECT_OBJECT_NAMES.has(commandName)) {
    return null;
  }

  let first: string | undefined;
  let last: string | undefined;
  let skip: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const option = normalizePowerShellOption(tokens[index] ?? '');
    const value = tokens[index + 1];
    if (!option || !isPositiveIntegerToken(value)) {
      return null;
    }

    if (option === 'first') {
      first = value;
    } else if (option === 'last') {
      last = value;
    } else if (option === 'skip') {
      skip = value;
    } else {
      return null;
    }
    index += 1;
  }

  if ((first && last) || (!first && !last)) {
    return null;
  }

  return {
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(skip ? { skip } : {}),
  };
}

function parsePowerShellGetContentCommand(
  command: string,
  options?: { allowAliases?: boolean },
): ParsedPowerShellGetContent | null {
  const tokens = tokenizePowerShellCommand(command);
  if (!tokens || tokens.includes('|')) {
    return null;
  }
  return parsePowerShellGetContentTokens(tokens, options);
}

function parsePowerShellGetContentPipeline(
  command: string,
  options?: { allowAliases?: boolean },
): ParsedCodexReadLinesCommand | null {
  const tokens = tokenizePowerShellCommand(command);
  if (!tokens) {
    return null;
  }

  const pipeIndex = tokens.indexOf('|');
  if (pipeIndex <= 0 || tokens.indexOf('|', pipeIndex + 1) !== -1) {
    return null;
  }

  const getContent = parsePowerShellGetContentTokens(
    tokens.slice(0, pipeIndex),
    options,
  );
  const selectObject = parsePowerShellSelectObjectTokens(
    tokens.slice(pipeIndex + 1),
  );
  if (
    !getContent ||
    !selectObject ||
    getContent.first ||
    getContent.last ||
    getContent.raw
  ) {
    return null;
  }

  if (selectObject.last && !selectObject.skip) {
    return { filePath: getContent.filePath, last: selectObject.last };
  }

  if (!selectObject.first || selectObject.last) {
    return null;
  }

  const skip = Number(selectObject.skip ?? '0');
  const first = Number(selectObject.first);
  return {
    filePath: getContent.filePath,
    start: String(skip + 1),
    end: String(skip + first),
  };
}

function parseCodexCatCommand(command: string): string | null {
  const innerCommand = unwrapShellWrappedCommand(command).trim();
  const allowPowerShellAliases = isWindowsPowerShellWrappedCommand(command);
  const catMatch = innerCommand.match(
    /^cat\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/,
  );
  const filePath = catMatch?.[1] ?? catMatch?.[2] ?? catMatch?.[3] ?? '';
  if (filePath.length > 0) {
    return filePath;
  }

  const getContent = parsePowerShellGetContentCommand(innerCommand, {
    allowAliases: allowPowerShellAliases,
  });
  if (getContent && !getContent.first && !getContent.last) {
    return getContent.filePath;
  }

  return null;
}

function parseCodexReadLinesCommand(
  command: string,
): ParsedCodexReadLinesCommand | null {
  const innerCommand = unwrapShellWrappedCommand(command).trim();
  const allowPowerShellAliases = isWindowsPowerShellWrappedCommand(command);
  const rangePattern = String.raw`(\d+),(\d+)p`;
  const filePattern = String.raw`(?:"([^"]+)"|'([^']+)'|(\S+))`;
  const directSedMatch = innerCommand.match(
    new RegExp(
      String.raw`^sed\s+-n\s+(?:"${rangePattern}"|'${rangePattern}'|${rangePattern})\s+${filePattern}\s*$`,
    ),
  );
  if (directSedMatch) {
    const start = directSedMatch[1] ?? directSedMatch[3] ?? directSedMatch[5];
    const end = directSedMatch[2] ?? directSedMatch[4] ?? directSedMatch[6];
    const filePath =
      directSedMatch[7] ?? directSedMatch[8] ?? directSedMatch[9] ?? '';
    return filePath.length > 0 && start && end
      ? { filePath, start, end }
      : null;
  }

  const pipedSedMatch = innerCommand.match(
    new RegExp(
      String.raw`^cat\s+(?:--\s+)?${filePattern}\s+\|\s+sed\s+-n\s+(?:"${rangePattern}"|'${rangePattern}'|${rangePattern})\s*$`,
    ),
  );
  if (pipedSedMatch) {
    const filePath =
      pipedSedMatch[1] ?? pipedSedMatch[2] ?? pipedSedMatch[3] ?? '';
    const start = pipedSedMatch[4] ?? pipedSedMatch[6] ?? pipedSedMatch[8];
    const end = pipedSedMatch[5] ?? pipedSedMatch[7] ?? pipedSedMatch[9];
    return filePath.length > 0 && start && end
      ? { filePath, start, end }
      : null;
  }

  const getContentPipeline = parsePowerShellGetContentPipeline(innerCommand, {
    allowAliases: allowPowerShellAliases,
  });
  if (getContentPipeline) {
    return getContentPipeline;
  }

  const getContent = parsePowerShellGetContentCommand(innerCommand, {
    allowAliases: allowPowerShellAliases,
  });
  if (getContent?.first && !getContent.raw) {
    return { filePath: getContent.filePath, start: '1', end: getContent.first };
  }
  if (getContent?.last && !getContent.raw) {
    return { filePath: getContent.filePath, last: getContent.last };
  }

  const getContentCommandPattern = allowPowerShellAliases
    ? POWERSHELL_GET_CONTENT_COMMAND_PATTERN
    : 'Get-Content';
  const getContentAssignmentMatch = innerCommand.match(
    new RegExp(
      String.raw`^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*${getContentCommandPattern}(?:\s+-(?:Path|LiteralPath))?\s+${POWERSHELL_FILE_ARGUMENT_PATTERN}\s*;\s*\$\1\s*\[(\d+)\.\.(\d+)\]\s*$`,
      'i',
    ),
  );
  if (getContentAssignmentMatch) {
    const filePath = getMatchedFileArgument(getContentAssignmentMatch, 2);
    const start = getContentAssignmentMatch[5]
      ? incrementDecimalString(getContentAssignmentMatch[5])
      : undefined;
    const end = getContentAssignmentMatch[6]
      ? incrementDecimalString(getContentAssignmentMatch[6])
      : undefined;
    return filePath.length > 0 && start && end
      ? { filePath, start, end }
      : null;
  }

  const getContentIndexMatch = innerCommand.match(
    new RegExp(
      String.raw`^\(\s*${getContentCommandPattern}(?:\s+-(?:Path|LiteralPath))?\s+${POWERSHELL_FILE_ARGUMENT_PATTERN}\s*\)\s*\[(\d+)\.\.(\d+)\]\s*$`,
      'i',
    ),
  );
  if (getContentIndexMatch) {
    const filePath = getMatchedFileArgument(getContentIndexMatch, 1);
    const start = getContentIndexMatch[4]
      ? incrementDecimalString(getContentIndexMatch[4])
      : undefined;
    const end = getContentIndexMatch[5]
      ? incrementDecimalString(getContentIndexMatch[5])
      : undefined;
    return filePath.length > 0 && start && end
      ? { filePath, start, end }
      : null;
  }

  return null;
}

function getSkillNameFromSkillPath(skillPath: string): string | null {
  if (
    skillPath !== 'SKILL.md' &&
    !skillPath.endsWith('/SKILL.md') &&
    !skillPath.endsWith('\\SKILL.md')
  ) {
    return null;
  }
  const skillDir = skillPath
    .slice(0, -'SKILL.md'.length)
    .replace(/[\\/]+$/, '');
  const skillName = skillDir.split(/[\\/]/).pop()?.trim();
  return skillName && skillName.length > 0 ? skillName : 'skill';
}

export function normalizeCommandReadToolBlock<
  T extends {
    toolName: string;
    input: string;
    display?: { toolName: string; input: string };
  },
>(block: T, options?: { literalPathsOnly?: boolean }): T {
  if (block.display) block = { ...block, ...block.display };
  if (block.toolName !== 'command') {
    return block;
  }

  if (options?.literalPathsOnly && /[$`;&<>]/.test(block.input)) return block;

  const readLines = parseCodexReadLinesCommand(block.input);
  if (readLines) {
    if (
      options?.literalPathsOnly &&
      (/[$`;&|<>*?\[\]{}]/.test(readLines.filePath) ||
        readLines.filePath.startsWith('-'))
    )
      return block;
    const skillName = getSkillNameFromSkillPath(readLines.filePath);
    const lineRangeInput =
      'last' in readLines
        ? { last: readLines.last }
        : { start: readLines.start, end: readLines.end };
    if (skillName) {
      return {
        ...block,
        toolName: 'Skill',
        input: JSON.stringify({
          skill: skillName,
          file_path: readLines.filePath,
          ...lineRangeInput,
          raw_command: block.input,
        }),
      };
    }

    return {
      ...block,
      toolName: 'ReadLines',
      input: JSON.stringify({
        file_path: readLines.filePath,
        ...lineRangeInput,
        raw_command: block.input,
      }),
    };
  }

  const filePath = parseCodexCatCommand(block.input);
  if (
    !filePath ||
    (options?.literalPathsOnly &&
      (/[$`;&|<>*?\[\]{}]/.test(filePath) || filePath.startsWith('-')))
  ) {
    return block;
  }

  const skillName = getSkillNameFromSkillPath(filePath);
  if (skillName) {
    return {
      ...block,
      toolName: 'Skill',
      input: JSON.stringify({ skill: skillName, raw_command: block.input }),
    };
  }

  return {
    ...block,
    toolName: 'Read',
    input: JSON.stringify({ file_path: filePath, raw_command: block.input }),
  };
}
