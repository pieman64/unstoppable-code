import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve only explicitly imported settings, once, using the launch environment. */
export async function resolveOpenCodeProviderConfig(
  config: Record<string, unknown> | undefined,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (!config) return undefined;
  const env = { ...environment };
  const files = new Map<string, string>();
  const limit = 1024 * 1024;
  let bytes = 0;
  let fileBytes = 0;
  let nodes = 0;
  const bound = (value: string): string => {
    bytes += Buffer.byteLength(value);
    if (bytes > limit)
      throw new Error('OpenCode provider settings are too large.');
    return value;
  };
  const load = async (file: string): Promise<string> => {
    const target = file.startsWith('~/')
      ? join(homedir(), file.slice(2))
      : resolve(cwd, file);
    const cached = files.get(target);
    if (cached !== undefined) return cached;
    try {
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        if (!(await handle.stat()).isFile())
          throw new Error('Expected a file.');
        const chunks: Buffer[] = [];
        for await (const chunk of handle.createReadStream({
          signal,
          highWaterMark: 64 * 1024,
          autoClose: false,
        })) {
          const data: unknown = chunk;
          if (!Buffer.isBuffer(data)) throw new Error('Expected file bytes.');
          fileBytes += data.byteLength;
          if (fileBytes > limit) throw new Error('Files are too large.');
          chunks.push(data);
        }
        const value = Buffer.concat(chunks).toString('utf8').trim();
        files.set(target, value);
        return value;
      } finally {
        await handle.close();
      }
    } catch {
      signal.throwIfAborted();
      // Paths and referenced values can contain credentials.
      throw new Error(
        'OpenCode provider settings contain an unreadable file reference.',
      );
    }
  };
  const text = async (value: string): Promise<string> => {
    // Match the pinned CLI's single env pass followed by a single file pass.
    const expanded = value.replace(
      /\{env:([^}]+)\}/g,
      (_match: string, key: string) =>
        Object.prototype.hasOwnProperty.call(env, key) ? (env[key] ?? '') : '',
    );
    const parts: string[] = [];
    let cursor = 0;
    for (const match of Array.from(expanded.matchAll(/\{file:([^}]+)\}/g))) {
      signal.throwIfAborted();
      parts.push(
        bound(expanded.slice(cursor, match.index)),
        bound(await load(match[1])),
      );
      cursor = match.index + match[0].length;
    }
    parts.push(bound(expanded.slice(cursor)));
    return parts.join('');
  };
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    signal.throwIfAborted();
    if (depth > 64 || ++nodes > 10000)
      throw new Error('OpenCode provider settings are too deeply nested.');
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await visit(item, depth + 1));
      return result;
    }
    if (!isRecord(value)) return value;
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value))
      entries.push([await text(key), await visit(item, depth + 1)]);
    return Object.fromEntries(entries);
  };
  const result = await visit(config, 0);
  if (!isRecord(result))
    throw new Error('OpenCode provider settings are invalid.');
  if (Buffer.byteLength(JSON.stringify(result)) > limit)
    throw new Error('OpenCode provider settings are too large.');
  return result;
}

/** The CLI substitutes raw JSON text before parsing; protect already resolved strings. */
export function serializeOpenCodeRuntimeConfig(
  config: Record<string, unknown>,
): string {
  return JSON.stringify(config).replace(/\{(?=(?:env|file):)/g, '\\u007b');
}
