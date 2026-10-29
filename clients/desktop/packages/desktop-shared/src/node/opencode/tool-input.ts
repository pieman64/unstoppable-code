import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { resolve } from 'node:path';
import type { CopilotNativeOperation } from '../copilot/tool-input';

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

// V2 expands these before resolving a path. Reject them so policy and native
// execution always resolve the same target, including patch move destinations.
function nativePath(value: unknown): value is string {
  return (
    text(value) &&
    !/^~(?:$|[\\/])/.test(value) &&
    !(
      hostPlatformOperatingSystem() === 'win32' &&
      /^\/(?:[a-z](?::)?(?:[\\/]|$)|(?:cygdrive|mnt)\/[a-z](?:\/|$))/i.test(
        value,
      )
    )
  );
}

/** The pinned OpenCode schemas, normalized before consulting shared policy. */
export function openCodeNativeOperations(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): CopilotNativeOperation[] | undefined {
  if ((name === 'patch' || name === 'apply_patch') && text(input.patchText)) {
    const lines = input.patchText.trim().split('\n');
    if (
      lines[0]?.trim() !== '*** Begin Patch' ||
      lines[lines.length - 1]?.trim() !== '*** End Patch' ||
      lines.filter(
        (line) =>
          line.trim() === '*** Begin Patch' || line.trim() === '*** End Patch',
      ).length !== 2
    )
      return undefined;
    const paths: string[] = [];
    for (const line of lines) {
      const match =
        /^\*\*\* (?:Add File|Update File|Delete File|Move to):(.*)$/.exec(line);
      if (!match) continue;
      const destination = match[1].trim();
      if (!nativePath(destination)) return undefined;
      paths.push(resolve(cwd, destination));
    }
    if (!paths.length || paths.length > 512) return undefined;
    return Array.from(new Set(paths)).map((file_path) => ({
      tool: 'Write',
      input: { file_path, content: '' },
      mutates: true,
    }));
  }
  if (name === 'read' || name === 'write' || name === 'edit') {
    const target = input.path ?? input.filePath;
    if (!nativePath(target)) return undefined;
    const file_path = resolve(cwd, target);
    if (name === 'read')
      return [{ tool: 'Read', input: { file_path }, mutates: false }];
    if (name === 'write' && typeof input.content === 'string')
      return [
        {
          tool: 'Write',
          input: { file_path, content: input.content },
          mutates: true,
        },
      ];
    if (
      name === 'edit' &&
      typeof input.oldString === 'string' &&
      typeof input.newString === 'string'
    )
      return [
        {
          tool: 'Edit',
          input: {
            file_path,
            old_string: input.oldString,
            new_string: input.newString,
          },
          mutates: true,
        },
      ];
    return undefined;
  }
  if (name === 'grep' || name === 'glob') {
    if (
      !text(input.pattern) ||
      (input.path !== undefined && !nativePath(input.path))
    )
      return undefined;
    return [
      {
        tool: name === 'grep' ? 'Grep' : 'Glob',
        input: {
          pattern: input.pattern,
          path: text(input.path) ? resolve(cwd, input.path) : cwd,
        },
        mutates: false,
      },
    ];
  }
  if ((name === 'shell' || name === 'bash') && text(input.command)) {
    if (input.background === true) return undefined;
    if (input.workdir !== undefined && !nativePath(input.workdir))
      return undefined;
    return [
      {
        tool: 'Bash',
        input: {
          command: input.command,
          cwd: text(input.workdir) ? resolve(cwd, input.workdir) : cwd,
        },
        mutates: true,
      },
    ];
  }
  if (name === 'webfetch' && text(input.url)) {
    try {
      const url = new URL(input.url);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
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
        input: { url: input.url, prompt: '' },
        mutates: false,
      },
    ];
  }
  if (name === 'websearch' && text(input.query))
    return [
      { tool: 'WebSearch', input: { query: input.query }, mutates: false },
    ];
  // Native task/question/plan transitions and unknown/custom tools fail closed.
  // The host supplies its own managed delegation and user-question tools.
  return undefined;
}
