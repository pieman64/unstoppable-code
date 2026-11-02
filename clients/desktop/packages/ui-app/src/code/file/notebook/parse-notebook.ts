import { selectNotebookOutputRendering } from './notebook-mime';
import type {
  NotebookCell,
  NotebookMimeBundle,
  NotebookOutput,
  NotebookParseResult,
  ParsedNotebook,
} from './notebook-types';

const ESC = 0x1b;
const BEL = 0x07;
const NOTEBOOK_CACHE_LIMIT = 4;
const notebookCache = new Map<string, NotebookParseResult>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;

  const items: unknown[] = value;
  for (const item of items) {
    if (typeof item !== 'string') return false;
  }
  return true;
}

function normalizeMultiline(value: unknown): string {
  if (typeof value === 'string') return value;
  return isStringArray(value) ? value.join('') : '';
}

function normalizeTraceback(value: unknown): string {
  return isStringArray(value) ? value.join('\n') : '';
}

function parseExecutionCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value)
    ? value
    : null;
}

function parseLanguage(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;

  const languageInfo = metadata.language_info;
  if (isRecord(languageInfo)) {
    const languageName = languageInfo.name;
    if (typeof languageName === 'string' && languageName.length > 0) {
      return languageName;
    }
  }

  const kernelspec = metadata.kernelspec;
  if (isRecord(kernelspec)) {
    const language = kernelspec.language;
    if (typeof language === 'string' && language.length > 0) {
      return language;
    }
  }

  return null;
}

function parseMimeBundle(value: unknown): NotebookMimeBundle {
  if (!isRecord(value)) return {};

  const entries: Array<[string, string]> = [];
  for (const [mimeType, mimeValue] of Object.entries(value)) {
    if (typeof mimeValue === 'string') {
      entries.push([mimeType, mimeValue]);
    } else if (isStringArray(mimeValue)) {
      entries.push([mimeType, mimeValue.join('')]);
    }
  }

  return Object.fromEntries(entries);
}

function parseOutput(value: unknown): NotebookOutput | null {
  if (!isRecord(value)) return null;

  switch (value.output_type) {
    case 'stream':
      return {
        outputType: 'stream',
        name: value.name === 'stderr' ? 'stderr' : 'stdout',
        text: stripAnsi(normalizeMultiline(value.text)),
      };
    case 'error':
      return {
        outputType: 'error',
        ename: stripAnsi(typeof value.ename === 'string' ? value.ename : ''),
        evalue: stripAnsi(typeof value.evalue === 'string' ? value.evalue : ''),
        traceback: stripAnsi(normalizeTraceback(value.traceback)),
      };
    case 'execute_result':
      return {
        outputType: 'execute_result',
        executionCount: parseExecutionCount(value.execution_count),
        data: parseMimeBundle(value.data),
      };
    case 'display_data':
      return {
        outputType: 'display_data',
        data: parseMimeBundle(value.data),
      };
    default:
      return null;
  }
}

function parseOutputs(value: unknown): NotebookOutput[] {
  if (!Array.isArray(value)) return [];

  const entries: unknown[] = value;
  const outputs: NotebookOutput[] = [];
  for (const entry of entries) {
    const output = parseOutput(entry);
    if (output !== null) outputs.push(output);
  }
  return outputs;
}

/** Image attachments only, validated like image outputs; other MIME types drop. */
function parseAttachments(value: unknown): ReadonlyMap<string, string> {
  const attachments = new Map<string, string>();
  if (!isRecord(value)) return attachments;

  for (const [name, bundle] of Object.entries(value)) {
    const rendering = selectNotebookOutputRendering(parseMimeBundle(bundle));
    if (rendering?.kind === 'image') attachments.set(name, rendering.src);
  }
  return attachments;
}

function parseCells(value: unknown[]): NotebookCell[] {
  const cells: NotebookCell[] = [];
  for (const valueCell of value) {
    if (!isRecord(valueCell)) continue;

    const source = normalizeMultiline(valueCell.source);
    switch (valueCell.cell_type) {
      case 'markdown': {
        const attachments = parseAttachments(valueCell.attachments);
        cells.push(
          attachments.size > 0
            ? { cellType: 'markdown', source, attachments }
            : { cellType: 'markdown', source },
        );
        break;
      }
      case 'raw':
        cells.push({ cellType: 'raw', source });
        break;
      case 'code':
        cells.push({
          cellType: 'code',
          source,
          executionCount: parseExecutionCount(valueCell.execution_count),
          outputs: parseOutputs(valueCell.outputs),
        });
        break;
      default:
        break;
    }
  }
  return cells;
}

/** Parse untrusted nbformat v4 JSON into a display-ready notebook model. */
export function parseNotebook(content: string): NotebookParseResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { status: 'failed', reason: 'invalid-json' };
  }

  if (!isRecord(value)) {
    return { status: 'failed', reason: 'invalid-structure' };
  }
  if (value.nbformat !== 4) {
    return { status: 'failed', reason: 'unsupported-version' };
  }
  if (!Array.isArray(value.cells)) {
    return { status: 'failed', reason: 'invalid-structure' };
  }

  const notebook: ParsedNotebook = {
    language: parseLanguage(value.metadata),
    cells: parseCells(value.cells),
  };
  return { status: 'ok', notebook };
}

/**
 * Same result as parseNotebook; caches the most recent few inputs (by string
 * equality) so repeated renders of the same content parse once.
 */
export function parseNotebookCached(content: string): NotebookParseResult {
  const cached = notebookCache.get(content);
  if (cached !== undefined) {
    notebookCache.delete(content);
    notebookCache.set(content, cached);
    return cached;
  }

  const result = parseNotebook(content);
  notebookCache.set(content, result);
  if (notebookCache.size > NOTEBOOK_CACHE_LIMIT) {
    const oldestKey = notebookCache.keys().next().value;
    if (oldestKey !== undefined) notebookCache.delete(oldestKey);
  }
  return result;
}

/**
 * Removes ANSI escape sequences (CSI like ESC[0;31m / ESC[38;5;241m / ESC[K,
 * and OSC like ESC]8;;url ESC\ or BEL-terminated).
 */
export function stripAnsi(text: string): string {
  // Single forward pass: notebook output is untrusted, so an unterminated
  // sequence must never trigger a rescan of the remaining text.
  if (!text.includes('\u001b')) return text;
  let output = '';
  let index = 0;
  while (index < text.length) {
    const escape = text.indexOf('\u001b', index);
    if (escape === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, escape);
    const kind = text[escape + 1];
    let cursor = escape + 2;
    if (kind === '[') {
      // CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
      while (cursor < text.length && isInRange(text, cursor, 0x30, 0x3f)) {
        cursor += 1;
      }
      while (cursor < text.length && isInRange(text, cursor, 0x20, 0x2f)) {
        cursor += 1;
      }
      index = isInRange(text, cursor, 0x40, 0x7e) ? cursor + 1 : escape + 1;
    } else if (kind === ']') {
      // OSC ends at BEL or ESC \; an unterminated one drops the rest.
      while (cursor < text.length) {
        const code = text.charCodeAt(cursor);
        if (code === BEL) {
          cursor += 1;
          break;
        }
        if (code === ESC && text[cursor + 1] === '\\') {
          cursor += 2;
          break;
        }
        cursor += 1;
      }
      index = cursor;
    } else {
      index = escape + 1;
    }
  }
  return output;
}

function isInRange(
  text: string,
  index: number,
  min: number,
  max: number,
): boolean {
  const code = text.charCodeAt(index);
  return code >= min && code <= max;
}
