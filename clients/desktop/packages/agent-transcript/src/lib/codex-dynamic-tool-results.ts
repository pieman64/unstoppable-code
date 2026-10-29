/**
 * Renderer-side helper that turns Codex `dynamic_tool_call` `contentItems`
 * into a single text string used for transcript `tool_result.output` and
 * the activity timeline.
 *
 * Rules (Frontend plan §F1.1):
 *   - join all `inputText.text` values with blank lines
 *   - each `inputImage` becomes the literal `[image output omitted]`
 *   - no content items: return `Done` on success, `Failed` otherwise
 *
 * Raster images are projected separately. Keep unsupported media placeholders
 * while bounding text and never exposing encrypted content.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IMAGE_OUTPUT_PLACEHOLDER = '[image output omitted]';
export const CODEX_DYNAMIC_TOOL_OUTPUT_MAX_CHARS = 64 * 1024;
const ADDITIONAL_OUTPUT_OMITTED = '\n\n[additional output omitted]';

export function boundCodexDynamicToolOutput(
  value: string,
  alreadyTruncated = false,
): string {
  if (
    !alreadyTruncated &&
    value.length <= CODEX_DYNAMIC_TOOL_OUTPUT_MAX_CHARS
  ) {
    return value;
  }
  return `${value.slice(
    0,
    CODEX_DYNAMIC_TOOL_OUTPUT_MAX_CHARS - ADDITIONAL_OUTPUT_OMITTED.length,
  )}${ADDITIONAL_OUTPUT_OMITTED}`;
}

export function flattenCodexDynamicToolContent(options: {
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
      if (text.length > CODEX_DYNAMIC_TOOL_OUTPUT_MAX_CHARS) {
        itemWasTruncated = true;
      }
      parts.push(text.slice(0, CODEX_DYNAMIC_TOOL_OUTPUT_MAX_CHARS));
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
  return boundCodexDynamicToolOutput(output, itemWasTruncated);
}
