import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isThinkingLevel } from '@canopy/protocol/thinking';
import { JSON_SCHEMA, load } from 'js-yaml';

export interface ReviewTrack {
  id: string;
  name: string;
  file: string;
  model: string;
  prompt: string;
  thinking_effort: string;
  fast_mode: string;
  max_turns: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readModels(metadata: Record<string, unknown>, file: string): string[] {
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`);
  };
  const supported = new Set([
    'name',
    'model',
    'models',
    'thinking_effort',
    'fast_mode',
    'max_turns',
  ]);
  for (const key of Object.keys(metadata)) {
    if (!supported.has(key))
      return fail(`Unsupported reviewer argument "${key}"`);
  }
  if ('model' in metadata === 'models' in metadata) {
    return fail('Specify exactly one of model or models');
  }
  const models: unknown =
    'model' in metadata ? [metadata.model] : metadata.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every(nonemptyString)
  ) {
    return fail(
      'model must be a non-empty string; models must be a non-empty array of strings',
    );
  }
  if (
    models.some(
      (model) => /[\r\n]/.test(model) || model.startsWith('agent_model_'),
    )
  ) {
    return fail(
      'Use single-line provider models or workflow aliases, not raw agent_model_ IDs',
    );
  }
  return models.map((model) => model.trim());
}

function readOptions(
  metadata: Record<string, unknown>,
  file: string,
): Pick<ReviewTrack, 'name' | 'thinking_effort' | 'fast_mode' | 'max_turns'> {
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`);
  };
  if (
    'name' in metadata &&
    (!nonemptyString(metadata.name) || /[\r\n]/.test(metadata.name))
  ) {
    return fail('name must be a non-empty single-line string');
  }
  const effort = metadata.thinking_effort;
  if (
    effort !== undefined &&
    (!isThinkingLevel(effort) || effort === 'ultra')
  ) {
    return fail(
      'thinking_effort must be off, low, medium, high, xhigh, or max',
    );
  }
  if ('fast_mode' in metadata && typeof metadata.fast_mode !== 'boolean') {
    return fail('fast_mode must be a boolean');
  }
  if (
    'max_turns' in metadata &&
    (typeof metadata.max_turns !== 'number' ||
      !Number.isSafeInteger(metadata.max_turns) ||
      metadata.max_turns < 1)
  ) {
    return fail('max_turns must be a positive safe integer');
  }
  return {
    name: typeof metadata.name === 'string' ? metadata.name.trim() : file,
    thinking_effort: typeof effort === 'string' ? effort : 'high',
    fast_mode:
      typeof metadata.fast_mode === 'boolean' ? String(metadata.fast_mode) : '',
    max_turns:
      typeof metadata.max_turns === 'number' ? String(metadata.max_turns) : '',
  };
}

/** Strict by design: the general skill parser tolerates invalid YAML. */
export function parseReviewTrack(
  content: string,
  file: string,
): Omit<ReviewTrack, 'id' | 'model'> & { models: string[] } {
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`);
  };
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return fail('Expected YAML front matter delimited by --- lines');
  let metadata: unknown;
  try {
    metadata = load(match[1] ?? '', { schema: JSON_SCHEMA });
  } catch (error) {
    return fail(
      `Invalid YAML front matter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(metadata)) return fail('Front matter must be a mapping');
  const models = readModels(metadata, file);
  const options = readOptions(metadata, file);
  const prompt = content.slice(match[0].length).trim();
  if (!prompt) return fail('Markdown reviewer prompt must not be empty');
  return { ...options, file, models, prompt };
}

export async function discoverReviewTracks(
  repositoryRoot: string,
  tracksDirectory: string,
): Promise<{ include: ReviewTrack[] }> {
  const root = await realpath(repositoryRoot);
  const directory = resolve(root, tracksDirectory);
  const assertContained = (target: string): void => {
    const rel = relative(root, target);
    if (
      rel === '..' ||
      rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(rel)
    ) {
      throw new Error(
        `Review tracks must stay inside the reviewed repository: ${target}`,
      );
    }
  };
  assertContained(directory);
  try {
    assertContained(await realpath(directory));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { include: [] };
    throw error;
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const include: ReviewTrack[] = [];
  for (const entry of entries) {
    const file = relative(root, resolve(directory, entry.name));
    if (!entry.isFile())
      throw new Error(
        `${file}: Review tracks must be regular Markdown files, not directories or symlinks`,
      );
    const filePath = resolve(directory, entry.name);
    if ((await stat(filePath)).size > 1024 * 1024)
      throw new Error(`${file}: Review track exceeds 1 MiB`);
    const { models, ...track } = parseReviewTrack(
      await readFile(filePath, 'utf8'),
      file,
    );
    for (const model of models) {
      include.push({
        ...track,
        model,
        id: `custom-track-${include.length + 1}`,
      });
      if (include.length > 256)
        throw new Error(
          'Custom review tracks exceed the engine limit of 256 matrix variants',
        );
    }
  }
  return { include };
}
