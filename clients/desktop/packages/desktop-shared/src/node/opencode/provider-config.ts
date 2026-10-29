import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeReferences(
  value: unknown,
  directory: string,
  depth = 0,
): unknown {
  if (depth > 64)
    throw new Error('OpenCode provider settings are too deeply nested.');
  if (typeof value === 'string')
    return value.replace(
      /\{file:([^}]+)\}/g,
      (_match: string, file: string) =>
        `{file:${file.startsWith('~/') ? join(homedir(), file.slice(2)) : resolve(directory, file)}}`,
    );
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map((item) => normalizeReferences(item, directory, depth + 1));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeReferences(item, directory, depth + 1),
    ]),
  );
}

function mergeSettings(previous: unknown, next: unknown): unknown {
  if (!isRecord(previous) || !isRecord(next)) return next;
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(previous), ...Object.keys(next)])).map(
      (key) => [
        key,
        Object.prototype.hasOwnProperty.call(next, key)
          ? mergeSettings(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
}

/** Read provider settings only; native plugins/MCP/agents never escape host selection. */
export async function readOpenCodeProviderConfig(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const directory = join(
    env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  );
  const result: Record<string, unknown> = {};
  for (const file of [
    join(directory, 'config.json'),
    join(directory, 'opencode.json'),
    join(directory, 'opencode.jsonc'),
  ]) {
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') continue;
      throw new Error('OpenCode provider settings could not be read.');
    }
    if (Buffer.byteLength(source) > 1024 * 1024)
      throw new Error('OpenCode provider settings are too large.');
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !isRecord(parsed))
      throw new Error('OpenCode provider settings contain invalid JSON.');
    for (const key of [
      'provider',
      'providers',
      'enabled_providers',
      'disabled_providers',
      'model',
      'small_model',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const normalized = normalizeReferences(parsed[key], directory);
      result[key] =
        key === 'provider' || key === 'providers'
          ? mergeSettings(result[key], normalized)
          : normalized;
    }
    // Native v2 provider restrictions belong to model discovery. Tool and
    // integration policy remains owned by the host's selected capabilities.
    if (Array.isArray(parsed.policies)) {
      const entries: unknown[] = parsed.policies;
      const policies = entries.filter(
        (entry) => isRecord(entry) && entry.action === 'provider.use',
      );
      const previous: unknown[] = Array.isArray(result.policies)
        ? result.policies
        : [];
      if (policies.length) result.policies = [...previous, ...policies];
    }
  }
  return result;
}
