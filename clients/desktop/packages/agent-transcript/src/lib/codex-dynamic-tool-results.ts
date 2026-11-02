/**
 * Helpers that turn Codex `dynamic_tool_call` `contentItems`
 * into a single text string for canonical transcripts or bounded previews.
 *
 * Rules (Frontend plan §F1.1):
 *   - join all `inputText.text` values with blank lines
 *   - each `inputImage` becomes the literal `[image output omitted]`
 *   - no content items: return `Done` on success, `Failed` otherwise
 *
 * Raster images are projected separately. Keep unsupported media placeholders
 * while never exposing encrypted content. Only preview output is bounded.
 */

import {
  codexOutputChunks,
  codexOutputSequence,
  codexOutputText,
  type CodexOutputPiece,
  type CodexOutputSource,
} from './codex-mcp-tool-results';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IMAGE_OUTPUT_PLACEHOLDER = '[image output omitted]';
export const CODEX_DYNAMIC_TOOL_PREVIEW_MAX_CHARS = 64 * 1024;
const ADDITIONAL_OUTPUT_OMITTED = '\n\n[additional output omitted]';

export function previewCodexDynamicToolOutput(
  value: string,
  alreadyTruncated = false,
): string {
  if (
    !alreadyTruncated &&
    value.length <= CODEX_DYNAMIC_TOOL_PREVIEW_MAX_CHARS
  ) {
    return value;
  }
  return `${value.slice(
    0,
    CODEX_DYNAMIC_TOOL_PREVIEW_MAX_CHARS - ADDITIONAL_OUTPUT_OMITTED.length,
  )}${ADDITIONAL_OUTPUT_OMITTED}`;
}

export function previewCodexDynamicToolContent(options: {
  contentItems: unknown;
  success: boolean | null;
}): string {
  const { contentItems, success } = options;

  if (!Array.isArray(contentItems) || contentItems.length === 0) {
    return success === false ? 'Failed' : 'Done';
  }

  const parts: string[] = [];
  let itemWasTruncated = false;
  const itemLimit = Math.min(contentItems.length, 100);
  for (const item of contentItems.slice(0, itemLimit)) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'inputText' || item.type === 'input_text') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text.length > CODEX_DYNAMIC_TOOL_PREVIEW_MAX_CHARS) {
        itemWasTruncated = true;
      }
      parts.push(text.slice(0, CODEX_DYNAMIC_TOOL_PREVIEW_MAX_CHARS));
      continue;
    }
    if (item.type === 'inputImage' || item.type === 'input_image') {
      parts.push(IMAGE_OUTPUT_PLACEHOLDER);
      continue;
    }
    if (item.type === 'inputAudio' || item.type === 'input_audio') {
      parts.push('[audio output omitted]');
      continue;
    }
    parts.push(
      item.type === 'encrypted_content'
        ? '[encrypted output omitted]'
        : '[unsupported output omitted]',
    );
  }
  if (itemLimit < contentItems.length) {
    parts.push(
      `[${String(contentItems.length - itemLimit)} additional content items omitted]`,
    );
  }

  if (parts.length === 0) {
    return success === false ? 'Failed' : 'Done';
  }

  const output = parts.join('\n\n');
  return previewCodexDynamicToolOutput(output, itemWasTruncated);
}

/** Lossless transcript text; media and encrypted content remain placeholders. */
export function codexDynamicToolOutput(options: {
  contentItems: unknown;
  success: boolean | null;
}): string {
  const { contentItems, success } = options;
  if (!Array.isArray(contentItems) || contentItems.length === 0) {
    return success === false ? 'Failed' : 'Done';
  }
  const parts: string[] = [];
  for (const item of contentItems) {
    if (!isRecord(item)) continue;
    if (item.type === 'inputText' || item.type === 'input_text') {
      parts.push(typeof item.text === 'string' ? item.text : '');
    } else if (item.type === 'inputImage' || item.type === 'input_image') {
      parts.push(IMAGE_OUTPUT_PLACEHOLDER);
    } else if (item.type === 'inputAudio' || item.type === 'input_audio') {
      parts.push('[audio output omitted]');
    } else {
      parts.push(
        item.type === 'encrypted_content'
          ? '[encrypted output omitted]'
          : '[unsupported output omitted]',
      );
    }
  }
  return parts.length > 0
    ? parts.join('\n\n')
    : success === false
      ? 'Failed'
      : 'Done';
}

/** The pieces of {@link codexDynamicToolOutput}'s text. */
export function codexDynamicToolOutputSource(options: {
  contentItems: unknown;
  success: boolean | null;
}): CodexOutputSource {
  const { contentItems, success } = options;
  if (
    !Array.isArray(contentItems) ||
    contentItems.length === 0 ||
    !contentItems.some(isRecord)
  )
    return codexOutputSequence([success === false ? 'Failed' : 'Done']);
  const items: unknown[] = contentItems;
  const pieces: CodexOutputPiece[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (pieces.length > 0) pieces.push('\n\n');
    if (item.type === 'inputText' || item.type === 'input_text') {
      pieces.push(
        typeof item.text === 'string' ? codexOutputText(item.text) : '',
      );
    } else if (item.type === 'inputImage' || item.type === 'input_image') {
      pieces.push(IMAGE_OUTPUT_PLACEHOLDER);
    } else if (item.type === 'inputAudio' || item.type === 'input_audio') {
      pieces.push('[audio output omitted]');
    } else {
      pieces.push(
        item.type === 'encrypted_content'
          ? '[encrypted output omitted]'
          : '[unsupported output omitted]',
      );
    }
  }
  return codexOutputSequence(pieces);
}

/**
 * {@link codexDynamicToolOutput} as bounded chunks that join to the same
 * text, so a host can stream a large result without building it whole.
 */
export function codexDynamicToolOutputChunks(options: {
  contentItems: unknown;
  success: boolean | null;
}): Iterable<string> {
  return codexOutputChunks(() => codexDynamicToolOutputSource(options));
}
