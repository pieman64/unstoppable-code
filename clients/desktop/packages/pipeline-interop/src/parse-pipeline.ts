import * as yaml from 'js-yaml';
import type { Pipeline } from './document';

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPipeline(value: unknown): value is Pipeline {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string') return false;
  if (typeof value.on !== 'string' && !isRecord(value.on)) return false;
  return isRecord(value.jobs);
}

function unwrapPipelineDocument(document: unknown): Pipeline {
  if (!isRecord(document)) {
    throw new Error('Pipeline definition must be an object');
  }

  const candidate = 'pipeline' in document ? document.pipeline : document;
  if (!isPipeline(candidate)) {
    throw new Error(
      'Pipeline definition must include string `name`, valid `on`, and object `jobs` fields',
    );
  }

  return candidate;
}

export function parsePipelineText(raw: string): Pipeline {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Pipeline definition is empty');
  }

  let parsed: unknown;
  if (looksLikeJson(raw)) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (parsed === undefined) {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  }

  return unwrapPipelineDocument(parsed);
}
