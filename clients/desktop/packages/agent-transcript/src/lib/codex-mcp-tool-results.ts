/**
 * Browser-safe normalization for Codex `mcp_tool_call` transcript items.
 *
 * MCP results can contain several content variants plus a potentially large
 * structured fallback. Persist only the existing text-based chat-block
 * contract: readable text stays readable, binary payloads become placeholders,
 * and structured content is used only when no content entry rendered.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IMAGE_OUTPUT_PLACEHOLDER = '[image output omitted]';
const AUDIO_OUTPUT_PLACEHOLDER = '[audio output omitted]';
const RESOURCE_OUTPUT_PLACEHOLDER = '[resource output omitted]';
export const CODEX_MCP_TOOL_RESULT_MAX_CHARS = 64 * 1024;
const CODEX_MCP_TOOL_RESULT_MAX_CONTENT_ITEMS = 100;
const CODEX_MCP_TOOL_RESULT_MAX_JSON_DEPTH = 12;
const CODEX_MCP_TOOL_RESULT_MAX_JSON_NODES = 2_000;

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
  if (depth >= CODEX_MCP_TOOL_RESULT_MAX_JSON_DEPTH) {
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
      CODEX_MCP_TOOL_RESULT_MAX_CONTENT_ITEMS,
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
      includedKeys >= CODEX_MCP_TOOL_RESULT_MAX_CONTENT_ITEMS ||
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
      chars: CODEX_MCP_TOOL_RESULT_MAX_CHARS,
      nodes: CODEX_MCP_TOOL_RESULT_MAX_JSON_NODES,
      seen: new WeakSet(),
    });
    const formatted = JSON.stringify(bounded, null, 2);
    return typeof formatted === 'string'
      ? truncateOutput(formatted, CODEX_MCP_TOOL_RESULT_MAX_CHARS)
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
    CODEX_MCP_TOOL_RESULT_MAX_CHARS - output.length - separator.length;
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
    CODEX_MCP_TOOL_RESULT_MAX_CONTENT_ITEMS,
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
      if (output.length >= CODEX_MCP_TOOL_RESULT_MAX_CHARS) {
        break;
      }
    }
  }
  if (
    itemLimit < contentItems.length &&
    output.length < CODEX_MCP_TOOL_RESULT_MAX_CHARS
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

export function flattenCodexMcpToolResult(options: {
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
        CODEX_MCP_TOOL_RESULT_MAX_CHARS,
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
