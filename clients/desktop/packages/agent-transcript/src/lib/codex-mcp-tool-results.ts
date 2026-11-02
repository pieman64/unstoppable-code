/**
 * Browser-safe normalization for Codex `mcp_tool_call` transcript items.
 *
 * MCP results can contain several content variants plus a potentially large
 * structured fallback. Canonical output retains all readable text while
 * preview output stays bounded; binary payloads become placeholders.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IMAGE_OUTPUT_PLACEHOLDER = '[image output omitted]';
const AUDIO_OUTPUT_PLACEHOLDER = '[audio output omitted]';
const RESOURCE_OUTPUT_PLACEHOLDER = '[resource output omitted]';
export const CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS = 64 * 1024;
const CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CONTENT_ITEMS = 100;
const CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_JSON_DEPTH = 12;
const CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_JSON_NODES = 2_000;

interface JsonBudget {
  chars: number;
  nodes: number;
  seen: WeakSet<object>;
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
  if (suffix.length >= maxChars) {
    return suffix.slice(0, maxChars);
  }
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function boundedWithoutMeta(
  value: unknown,
  budget: JsonBudget,
  depth = 0,
): unknown {
  if (budget.nodes <= 0) {
    return '[additional output omitted]';
  }
  budget.nodes -= 1;

  if (typeof value === 'string') {
    const bounded = truncateOutput(value, Math.max(0, budget.chars));
    budget.chars = Math.max(0, budget.chars - bounded.length);
    return bounded;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_JSON_DEPTH) {
    return '[nested output omitted]';
  }
  if (typeof value !== 'object') {
    return `[unsupported ${typeof value} output omitted]`;
  }
  if (budget.seen.has(value)) {
    return '[circular output omitted]';
  }
  budget.seen.add(value);

  if (Array.isArray(value)) {
    const arrayValue: unknown[] = value;
    const sanitized: unknown[] = [];
    const itemLimit = Math.min(
      arrayValue.length,
      CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CONTENT_ITEMS,
    );
    for (let index = 0; index < itemLimit && budget.nodes > 0; index += 1) {
      sanitized.push(boundedWithoutMeta(arrayValue[index], budget, depth + 1));
    }
    if (itemLimit < arrayValue.length) {
      sanitized.push(
        `[${arrayValue.length - itemLimit} additional items omitted]`,
      );
    }
    return sanitized;
  }

  if (!isRecord(value)) {
    return '[unsupported object output omitted]';
  }

  const sanitized: Record<string, unknown> = {};
  let includedKeys = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (key === '_meta') {
      continue;
    }
    if (
      includedKeys >= CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CONTENT_ITEMS ||
      budget.nodes <= 0
    ) {
      sanitized._truncated = 'additional fields omitted';
      break;
    }
    includedKeys += 1;
    const boundedKey = truncateOutput(key, 256);
    sanitized[boundedKey] = boundedWithoutMeta(value[key], budget, depth + 1);
  }
  return sanitized;
}

function prettyJson(value: unknown): string | null {
  try {
    const bounded = boundedWithoutMeta(value, {
      chars: CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS,
      nodes: CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_JSON_NODES,
      seen: new WeakSet(),
    });
    const formatted = JSON.stringify(bounded, null, 2);
    return typeof formatted === 'string'
      ? truncateOutput(formatted, CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS)
      : null;
  } catch {
    // Normalized app-server values are JSON, but an invalid caller-provided
    // value must not break transcript reduction.
    return null;
  }
}

function appendOutput(output: string, part: string): string {
  const separator = output.length > 0 ? '\n\n' : '';
  const available =
    CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS - output.length - separator.length;
  if (available <= 0) {
    return output;
  }
  const boundedPart = truncateOutput(part, available);
  return `${output}${separator}${boundedPart}`;
}

function flattenContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const contentItems: unknown[] = content;

  let output = '';
  const itemLimit = Math.min(
    contentItems.length,
    CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CONTENT_ITEMS,
  );
  for (let index = 0; index < itemLimit; index += 1) {
    const item = contentItems[index];
    let part: string | null = null;
    if (isRecord(item)) {
      if (item.type === 'text') {
        if (typeof item.text === 'string' && item.text.length > 0) {
          part = item.text;
        } else {
          // An empty text item is a known-but-non-renderable content variant.
          // Skip it so structuredContent can still provide the useful fallback
          // instead of persisting the text item's wrapper JSON.
          continue;
        }
      } else if (item.type === 'resource') {
        const resource = isRecord(item.resource) ? item.resource : null;
        if (
          resource &&
          typeof resource.text === 'string' &&
          resource.text.length > 0
        ) {
          part = resource.text;
        } else {
          part = RESOURCE_OUTPUT_PLACEHOLDER;
        }
      } else if (item.type === 'image') {
        part = IMAGE_OUTPUT_PLACEHOLDER;
      } else if (item.type === 'audio') {
        part = AUDIO_OUTPUT_PLACEHOLDER;
      }
    }

    if (part === null) {
      part = prettyJson(item);
    }
    if (part !== null && part.length > 0) {
      output = appendOutput(output, part);
      if (output.length >= CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS) {
        break;
      }
    }
  }
  if (
    itemLimit < contentItems.length &&
    output.length < CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS
  ) {
    output = appendOutput(
      output,
      `[${contentItems.length - itemLimit} additional content items omitted]`,
    );
  }
  return output.length > 0 ? output : null;
}

export function codexMcpToolName(server: string, tool: string): string {
  return `mcp__${server.length > 0 ? server : 'unknown'}__${
    tool.length > 0 ? tool : 'unknown'
  }`;
}

export function previewCodexMcpToolResult(options: {
  status: string;
  result: unknown;
  error: unknown;
}): {
  output: string;
  isError: boolean;
} {
  const { status, result, error } = options;
  const resultRecord = isRecord(result) ? result : null;
  const errorRecord = isRecord(error) ? error : null;
  const isError =
    status === 'failed' ||
    (error !== null && error !== undefined) ||
    resultRecord?.isError === true;

  if (
    errorRecord &&
    typeof errorRecord.message === 'string' &&
    errorRecord.message.length > 0
  ) {
    return {
      output: truncateOutput(
        errorRecord.message,
        CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS,
      ),
      isError,
    };
  }

  const contentOutput = flattenContent(resultRecord?.content);
  if (contentOutput !== null) {
    return { output: contentOutput, isError };
  }

  if (
    resultRecord &&
    resultRecord.structuredContent !== null &&
    resultRecord.structuredContent !== undefined
  ) {
    const structured = prettyJson(resultRecord.structuredContent);
    if (structured !== null) {
      return { output: structured, isError };
    }
  }

  return { output: isError ? 'Failed' : 'Done', isError };
}

// Deeper levels share this indent so output size stays linear in the input.
const CANONICAL_JSON_MAX_INDENT_DEPTH = 32;

function indent(depth: number): string {
  return '  '.repeat(Math.min(depth, CANONICAL_JSON_MAX_INDENT_DEPTH));
}

/** Iterative JSON rendering avoids recursion limits and never invokes toJSON. */
function canonicalPrettyJson(value: unknown): string | null {
  type Task =
    | { kind: 'value'; value: unknown; depth: number }
    | { kind: 'text'; value: string }
    | { kind: 'exit'; value: object };
  const tasks: Task[] = [{ kind: 'value', value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  const chunks: string[] = [];
  try {
    while (tasks.length > 0) {
      const task = tasks.pop();
      if (!task) continue;
      if (task.kind === 'text') {
        chunks.push(task.value);
        continue;
      }
      if (task.kind === 'exit') {
        ancestors.delete(task.value);
        continue;
      }
      const current = task.value;
      if (current === null || typeof current !== 'object') {
        const safe =
          current === null ||
          ['string', 'number', 'boolean'].includes(typeof current)
            ? current
            : `[unsupported ${typeof current} output omitted]`;
        chunks.push(JSON.stringify(safe));
        continue;
      }
      if (ancestors.has(current)) {
        chunks.push(JSON.stringify('[circular output omitted]'));
        continue;
      }
      ancestors.add(current);
      const array = Array.isArray(current);
      const keys = array
        ? []
        : Object.keys(current).filter((key) => key !== '_meta');
      const length = array ? current.length : keys.length;
      const open = array ? '[' : '{';
      const close = array ? ']' : '}';
      if (length === 0) {
        chunks.push(open + close);
        ancestors.delete(current);
        continue;
      }
      chunks.push(open);
      tasks.push({ kind: 'exit', value: current });
      tasks.push({
        kind: 'text',
        value: `\n${indent(task.depth)}${close}`,
      });
      for (let index = length - 1; index >= 0; index -= 1) {
        if (index < length - 1) tasks.push({ kind: 'text', value: ',' });
        const key = keys[index];
        const member: unknown = Reflect.get(current, array ? index : key);
        tasks.push({ kind: 'value', value: member, depth: task.depth + 1 });
        tasks.push({
          kind: 'text',
          value: array
            ? `\n${indent(task.depth + 1)}`
            : `\n${indent(task.depth + 1)}${JSON.stringify(key)}: `,
        });
      }
    }
    return chunks.join('');
  } catch {
    return null;
  }
}

/** Reads only the status fields, never the result body. */
export function codexMcpToolResultIsError(options: {
  status: string;
  result: unknown;
  error: unknown;
}): boolean {
  const { status, result, error } = options;
  return (
    status === 'failed' ||
    (error !== null && error !== undefined) ||
    (isRecord(result) && result.isError === true)
  );
}

export function codexMcpToolResult(options: {
  status: string;
  result: unknown;
  error: unknown;
}): { output: string; isError: boolean } {
  const { status, result, error } = options;
  const resultRecord = isRecord(result) ? result : null;
  const errorRecord = isRecord(error) ? error : null;
  const isError =
    status === 'failed' ||
    (error !== null && error !== undefined) ||
    resultRecord?.isError === true;
  if (
    errorRecord &&
    typeof errorRecord.message === 'string' &&
    errorRecord.message.length > 0
  ) {
    return { output: errorRecord.message, isError };
  }
  if (Array.isArray(resultRecord?.content)) {
    const parts: string[] = [];
    for (const item of resultRecord.content) {
      let part: string | null = null;
      if (isRecord(item)) {
        if (item.type === 'text') {
          if (typeof item.text !== 'string' || item.text.length === 0) continue;
          part = item.text;
        } else if (item.type === 'resource') {
          const resource = isRecord(item.resource) ? item.resource : null;
          part =
            resource &&
            typeof resource.text === 'string' &&
            resource.text.length > 0
              ? resource.text
              : RESOURCE_OUTPUT_PLACEHOLDER;
        } else if (item.type === 'image') {
          part = IMAGE_OUTPUT_PLACEHOLDER;
        } else if (item.type === 'audio') {
          part = AUDIO_OUTPUT_PLACEHOLDER;
        }
      }
      if (part === null) part = canonicalPrettyJson(item) ?? prettyJson(item);
      if (part !== null && part.length > 0) parts.push(part);
    }
    if (parts.length > 0) return { output: parts.join('\n\n'), isError };
  }
  if (
    resultRecord &&
    resultRecord.structuredContent !== null &&
    resultRecord.structuredContent !== undefined
  ) {
    const structured =
      canonicalPrettyJson(resultRecord.structuredContent) ??
      prettyJson(resultRecord.structuredContent);
    if (structured !== null) return { output: structured, isError };
  }
  return { output: isError ? 'Failed' : 'Done', isError };
}

/*
 * Chunked canonical output. These sources produce exactly the text of the
 * synchronous canonical functions, in bounded pieces, so a host can stream a
 * large result into storage without building or joining the whole body. The
 * synchronous exports above stay the legacy path and are not derived from
 * these, so their bytes cannot drift. Sources are pull-based state machines:
 * this package targets ES5 and uses no generators.
 */

/** Pull-based text pieces; `undefined` means done. Pieces may be empty. */
export interface CodexOutputSource {
  next(): string | undefined;
}

/** A source, or a literal piece, in a {@link codexOutputSequence}. */
export type CodexOutputPiece = string | CodexOutputSource;

/** A yielded chunk never exceeds this many UTF-16 code units. */
export const CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS = 64 * 1024;
const CHUNK_TARGET_CHARS = 16 * 1024;
const TEXT_SLICE_CHARS = 16 * 1024;
// JSON escaping grows a code unit to at most six characters.
const ESCAPE_SLICE_CHARS = 8 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Slices of at most `maxChars` code units that never split a surrogate pair. */
export function codexOutputText(
  value: string,
  maxChars: number = TEXT_SLICE_CHARS,
): CodexOutputSource {
  const size = Math.max(2, Math.floor(maxChars));
  let start = 0;
  return {
    next: (): string | undefined => {
      if (start >= value.length) return undefined;
      let end = Math.min(value.length, start + size);
      if (
        end < value.length &&
        isHighSurrogate(value.charCodeAt(end - 1)) &&
        isLowSurrogate(value.charCodeAt(end))
      )
        end -= 1;
      const slice = value.slice(start, end);
      start = end;
      return slice;
    },
  };
}

/**
 * Pieces from `refill`, expanding nested sources in order. `refill` returns
 * the next pieces, or undefined when there are none.
 */
function refilledSource(
  refill: () => CodexOutputPiece[] | undefined,
): CodexOutputSource {
  let queue: CodexOutputPiece[] = [];
  let head = 0;
  let current: CodexOutputSource | undefined;
  return {
    next: (): string | undefined => {
      for (;;) {
        if (current) {
          const value = current.next();
          if (value !== undefined) return value;
          current = undefined;
        }
        if (head < queue.length) {
          const piece = queue[head];
          head += 1;
          if (typeof piece === 'string') return piece;
          current = piece;
          continue;
        }
        const more = refill();
        if (more === undefined) return undefined;
        queue = more;
        head = 0;
      }
    },
  };
}

/** The given pieces in order. */
export function codexOutputSequence(
  pieces: CodexOutputPiece[],
): CodexOutputSource {
  let done = false;
  return refilledSource(() => {
    if (done) return undefined;
    done = true;
    return pieces;
  });
}

/**
 * `JSON.stringify(value)` in pieces. Escaping is per code unit except for
 * surrogate pairs, which the slices never split, so the pieces join to the
 * same text without one giant stringify.
 */
function jsonStringSource(value: string): CodexOutputSource {
  if (value.length <= ESCAPE_SLICE_CHARS)
    return codexOutputSequence([JSON.stringify(value)]);
  const slices = codexOutputText(value, ESCAPE_SLICE_CHARS);
  const escaped: CodexOutputSource = {
    next: () => {
      const slice = slices.next();
      return slice === undefined
        ? undefined
        : JSON.stringify(slice).slice(1, -1);
    },
  };
  return codexOutputSequence(['"', escaped, '"']);
}

/** Joins small pieces into chunks of about 16 KiB, each at most 64 KiB. */
function coalescedSource(pieces: CodexOutputSource): CodexOutputSource {
  let oversized: CodexOutputSource | undefined;
  let carry: string | undefined;
  let finished = false;
  return {
    next: (): string | undefined => {
      if (oversized) {
        const slice = oversized.next();
        if (slice !== undefined) return slice;
        oversized = undefined;
      }
      const buffer: string[] = [];
      let length = 0;
      if (carry !== undefined) {
        buffer.push(carry);
        length = carry.length;
        carry = undefined;
      }
      while (!finished && length < CHUNK_TARGET_CHARS) {
        const piece = pieces.next();
        if (piece === undefined) {
          finished = true;
          break;
        }
        if (piece.length === 0) continue;
        if (piece.length > CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS) {
          oversized = codexOutputText(piece, CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS);
          if (length > 0) break;
          return oversized.next();
        }
        if (length + piece.length > CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS) {
          carry = piece;
          break;
        }
        buffer.push(piece);
        length += piece.length;
      }
      return length > 0 ? buffer.join('') : undefined;
    },
  };
}

/** Bounded chunks of a source, as a re-iterable that restarts the source. */
export function codexOutputChunks(
  source: () => CodexOutputSource,
): Iterable<string> {
  return {
    [Symbol.iterator]: (): Iterator<string, undefined> => {
      const chunks = coalescedSource(source());
      return {
        next: (): IteratorResult<string, undefined> => {
          const value = chunks.next();
          return value === undefined
            ? { done: true, value: undefined }
            : { done: false, value };
        },
      };
    },
  };
}

/**
 * The pieces of {@link canonicalPrettyJson}. Members are visited one at a
 * time, so a wide object or array never queues all of its members at once.
 * Throws where the synchronous form falls back to its bounded preview.
 */
function canonicalPrettyJsonSource(value: unknown): CodexOutputSource {
  interface Frame {
    container: object;
    keys: string[] | null;
    length: number;
    index: number;
    depth: number;
  }
  const ancestors = new WeakSet<object>();
  const frames: Frame[] = [];
  let pending: { value: unknown; depth: number } | null = { value, depth: 0 };
  return refilledSource(() => {
    if (pending !== null) {
      const { value: current, depth } = pending;
      pending = null;
      if (typeof current === 'string') return [jsonStringSource(current)];
      if (
        current === null ||
        typeof current === 'number' ||
        typeof current === 'boolean'
      )
        return [JSON.stringify(current)];
      if (typeof current !== 'object')
        return [
          JSON.stringify(`[unsupported ${typeof current} output omitted]`),
        ];
      if (ancestors.has(current))
        return [JSON.stringify('[circular output omitted]')];
      ancestors.add(current);
      const keys = Array.isArray(current)
        ? null
        : Object.keys(current).filter((key) => key !== '_meta');
      const length = Array.isArray(current)
        ? current.length
        : (keys?.length ?? 0);
      if (length === 0) {
        ancestors.delete(current);
        return [keys === null ? '[]' : '{}'];
      }
      frames.push({ container: current, keys, length, index: 0, depth });
      return [keys === null ? '[' : '{'];
    }
    const frame = frames[frames.length - 1];
    if (frame === undefined) return undefined;
    if (frame.index >= frame.length) {
      frames.pop();
      ancestors.delete(frame.container);
      return [`\n${indent(frame.depth)}${frame.keys === null ? ']' : '}'}`];
    }
    const index = frame.index;
    frame.index += 1;
    const prefix = `${index > 0 ? ',' : ''}\n${indent(frame.depth + 1)}`;
    if (frame.keys === null) {
      pending = {
        value: Reflect.get(frame.container, index),
        depth: frame.depth + 1,
      };
      return [prefix];
    }
    const key = frame.keys[index];
    pending = {
      value: Reflect.get(frame.container, key),
      depth: frame.depth + 1,
    };
    return [prefix, jsonStringSource(key), ': '];
  });
}

function emitsMcpContentPart(item: unknown): boolean {
  return !(
    isRecord(item) &&
    item.type === 'text' &&
    (typeof item.text !== 'string' || item.text.length === 0)
  );
}

function mcpContentItemSource(item: unknown): CodexOutputPiece {
  if (isRecord(item)) {
    if (item.type === 'text' && typeof item.text === 'string')
      return codexOutputText(item.text);
    if (item.type === 'resource') {
      const resource = isRecord(item.resource) ? item.resource : null;
      return resource &&
        typeof resource.text === 'string' &&
        resource.text.length > 0
        ? codexOutputText(resource.text)
        : RESOURCE_OUTPUT_PLACEHOLDER;
    }
    if (item.type === 'image') return IMAGE_OUTPUT_PLACEHOLDER;
    if (item.type === 'audio') return AUDIO_OUTPUT_PLACEHOLDER;
  }
  return canonicalPrettyJsonSource(item);
}

/** The pieces of {@link codexMcpToolResult}'s output. */
function mcpToolResultSource(options: {
  status: string;
  result: unknown;
  error: unknown;
}): CodexOutputSource {
  const resultRecord = isRecord(options.result) ? options.result : null;
  const errorRecord = isRecord(options.error) ? options.error : null;
  if (
    errorRecord &&
    typeof errorRecord.message === 'string' &&
    errorRecord.message.length > 0
  )
    return codexOutputText(errorRecord.message);
  const content: unknown = resultRecord?.content;
  if (Array.isArray(content) && content.some(emitsMcpContentPart)) {
    const items: unknown[] = content;
    let index = 0;
    let emitted = false;
    return refilledSource(() => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (!emitsMcpContentPart(item)) continue;
        const separator = emitted ? '\n\n' : '';
        emitted = true;
        return [separator, mcpContentItemSource(item)];
      }
      return undefined;
    });
  }
  if (
    resultRecord &&
    resultRecord.structuredContent !== null &&
    resultRecord.structuredContent !== undefined
  )
    return canonicalPrettyJsonSource(resultRecord.structuredContent);
  return codexOutputSequence([
    codexMcpToolResultIsError(options) ? 'Failed' : 'Done',
  ]);
}

/**
 * {@link codexMcpToolResult} as bounded chunks that join to the same output,
 * with the same `_meta`, media and cycle handling. Iterating can throw where
 * the synchronous form falls back to its bounded preview (an unreadable
 * value, such as a throwing getter); callers then use the synchronous form.
 */
export function codexMcpToolResultChunks(options: {
  status: string;
  result: unknown;
  error: unknown;
}): { isError: boolean; chunks: Iterable<string> } {
  return {
    isError: codexMcpToolResultIsError(options),
    chunks: codexOutputChunks(() => mcpToolResultSource(options)),
  };
}
