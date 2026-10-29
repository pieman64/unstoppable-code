import { isAbsolute } from 'node:path';

/**
 * Well-formedness checks for a native Cursor tool's input, shared by the
 * interactive approval policy (`apps/desktop-app/src/main/cursor/tool-approval.ts`)
 * and the headless pipeline policy (`headless-policy.ts`).
 *
 * The two gates answer different questions — the interactive one normalizes
 * into Canopy's approval engine and prompts, the headless one resolves against
 * the step's declared `permission_preset` — and that divergence is deliberate.
 * What they must NOT diverge on is whether a payload is well-formed enough to
 * reason about at all: a relative single-file path, an embedded NUL, or a
 * missing body are rejected identically by both. Searches may be cwd-relative.
 * Keeping only that first step shared means a
 * hardening change lands in both gates or neither, rather than in whichever one
 * the next author happened to be reading.
 *
 * Each helper returns the narrowed value, or `undefined` for "not well formed";
 * neither gate may infer anything else from `undefined`.
 */
function isUsablePath(value: unknown): value is string {
  return (
    typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
  );
}

/** `Read`: an absolute, NUL-free path. */
export function readToolPath(
  input: Record<string, unknown>,
): string | undefined {
  return isUsablePath(input.file_path) ? input.file_path : undefined;
}

/** `Write`: an absolute, NUL-free path AND a string body. */
export function writeToolInput(
  input: Record<string, unknown>,
): { filePath: string; content: string } | undefined {
  if (!isUsablePath(input.file_path)) return undefined;
  if (typeof input.content !== 'string') return undefined;
  return { filePath: input.file_path, content: input.content };
}

/** `Shell`: a non-blank command string. Never only its first executable. */
export function shellToolCommand(
  input: Record<string, unknown>,
): string | undefined {
  return typeof input.command === 'string' && input.command.trim()
    ? input.command
    : undefined;
}

/** Accept the native hook and server-forwarded spellings, never conflicting scopes. */
function stringInput(
  input: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): string | undefined {
  let result: string | undefined;
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0')) return undefined;
    if (result !== undefined && result !== value) return undefined;
    result = value;
  }
  return result ?? (optional ? '' : undefined);
}

export interface CursorReadToolInput {
  toolName: 'Read' | 'Grep' | 'Glob';
  input: Record<string, unknown>;
  summary: string;
}

/**
 * Native file discovery normalized for the existing approval and child-grant
 * policies. The pinned Grep wrapper uses file_path; the server's Glob uses
 * glob_pattern/target_directory. ACP display inputs use pattern/path instead.
 * This is approval normalization only: it never rewrites the executed input.
 */
export function cursorReadToolInput(
  tool: unknown,
  input: Record<string, unknown>,
): CursorReadToolInput | undefined {
  if (tool === 'List' || tool === 'ReadLints') {
    const filePath = readToolPath(input);
    if (filePath === undefined) return undefined;
    return {
      toolName: 'Read',
      input: { file_path: filePath },
      summary: filePath,
    };
  }
  if (tool !== 'Grep' && tool !== 'Glob') return undefined;
  const pattern = stringInput(
    input,
    tool === 'Glob' ? ['glob_pattern', 'globPattern', 'pattern'] : ['pattern'],
  );
  const searchPath = stringInput(
    input,
    ['file_path', 'path', 'target_directory', 'targetDirectory'],
    true,
  );
  if (
    pattern === undefined ||
    searchPath === undefined ||
    (tool === 'Glob' && !pattern.trim())
  )
    return undefined;
  if (
    tool === 'Grep' &&
    (stringInput(input, ['glob'], true) === undefined ||
      stringInput(input, ['output_mode', 'outputMode'], true) === undefined)
  )
    return undefined;
  return {
    toolName: tool,
    input: {
      ...input,
      pattern,
      path: searchPath || '.',
      file_path: searchPath || '.',
    },
    summary: `${pattern} (${searchPath || '.'})`,
  };
}

/** Network tools must name an HTTP(S) resource before a host can approve it. */
export function cursorFetchUrl(
  input: Record<string, unknown>,
): string | undefined {
  const value = stringInput(input, ['url']);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function cursorWebSearchQuery(
  input: Record<string, unknown>,
): string | undefined {
  const query = stringInput(input, ['search_term', 'searchTerm', 'query']);
  return query?.trim() ? query : undefined;
}
