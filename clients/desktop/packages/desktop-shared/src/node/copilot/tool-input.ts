import { resolve } from 'node:path';

export interface CopilotNativeOperation {
  tool:
    | 'Read'
    | 'Write'
    | 'Edit'
    | 'Glob'
    | 'Grep'
    | 'Bash'
    | 'WebFetch'
    | 'WebSearch';
  input: Record<string, unknown>;
  mutates: boolean;
}

export function isCopilotRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

/** Read/stop/list never write stdin and address only this native session's shells. */
export function isCopilotShellControl(name: string, value: unknown): boolean {
  if (
    !/^(read|stop|list)_(bash|powershell)$/.test(name) ||
    !isCopilotRecord(value)
  )
    return false;
  const input = value;
  if (name.startsWith('list_')) return Object.keys(input).length === 0;
  const read = name.startsWith('read_');
  const keys = read ? ['shellId', 'delay'] : ['shellId'];
  return (
    Object.keys(input).every((key) => keys.includes(key)) &&
    text(input.shellId) &&
    input.shellId.length <= 1024 &&
    (!read ||
      (typeof input.delay === 'number' &&
        Number.isFinite(input.delay) &&
        input.delay >= 0 &&
        input.delay <= 120))
  );
}

/** Pinned native schemas, shared by interactive, pipeline and child policy. */
export function copilotNativeOperations(
  name: string,
  value: unknown,
  cwd: string,
): CopilotNativeOperation[] | undefined {
  if (!isCopilotRecord(value)) return undefined;
  const input = value;
  if (name === 'view' || name === 'create' || name === 'edit') {
    if (!text(input.path)) return undefined;
    const file_path = resolve(cwd, input.path);
    if (name === 'view')
      return [{ tool: 'Read', input: { file_path }, mutates: false }];
    if (name === 'create' && typeof input.file_text === 'string')
      return [
        {
          tool: 'Write',
          input: { file_path, content: input.file_text },
          mutates: true,
        },
      ];
    if (
      name === 'edit' &&
      typeof input.old_str === 'string' &&
      typeof input.new_str === 'string'
    )
      return [
        {
          tool: 'Edit',
          input: {
            file_path,
            old_string: input.old_str,
            new_string: input.new_str,
          },
          mutates: true,
        },
      ];
    return undefined;
  }
  if (name === 'grep' || name === 'glob') {
    if (!text(input.pattern)) return undefined;
    const paths =
      input.paths === undefined
        ? [cwd]
        : Array.isArray(input.paths)
          ? input.paths
          : [input.paths];
    if (!paths.length || paths.length > 64 || !paths.every(text))
      return undefined;
    return paths.map((path: string) => ({
      tool: name === 'grep' ? 'Grep' : 'Glob',
      input: { ...input, path: resolve(cwd, path) },
      mutates: false,
    }));
  }
  if (name === 'bash' || name === 'powershell') {
    // Detached tools would outlive cancellation and the owning grant.
    if (
      !text(input.command) ||
      (input.detach !== undefined && input.detach !== false)
    )
      return undefined;
    return [{ tool: 'Bash', input: { command: input.command }, mutates: true }];
  }
  if (name === 'web_fetch') {
    if (!text(input.url)) return undefined;
    try {
      const url = new URL(input.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return undefined;
    } catch {
      return undefined;
    }
    return [
      {
        tool: 'WebFetch',
        input: { url: input.url, prompt: input.prompt ?? '' },
        mutates: false,
      },
    ];
  }
  if (name === 'web_search' && text(input.query))
    // Copilot does not expose enforceable domain filters on this tool.
    return [
      { tool: 'WebSearch', input: { query: input.query }, mutates: false },
    ];
  return undefined;
}
