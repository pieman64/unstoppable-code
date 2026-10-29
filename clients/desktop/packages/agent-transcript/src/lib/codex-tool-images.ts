import type { PersistedChatBlock } from '../types';

// Bound the encoded, persisted payload. Never fetch a tool's
// remote URL, read its arbitrary local path, or embed executable SVG/HTML.
export const CODEX_INLINE_IMAGE_MAX_CHARS = 512 * 1024;
const MAX_IMAGES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageSource(item: Record<string, unknown>): unknown {
  if (item.type === 'inputImage') return item.imageUrl;
  if (item.type === 'input_image') return item.image_url;
  if (
    item.type === 'image' &&
    typeof item.mimeType === 'string' &&
    typeof item.data === 'string' &&
    item.data.length <= CODEX_INLINE_IMAGE_MAX_CHARS
  )
    return `data:${item.mimeType};base64,${item.data}`;
  return undefined;
}

/** Keep text placeholders accurate for exactly the previews we can display. */
export function withCodexImagePreviewNotices(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let displayed = 0;
  return content.map((value: unknown) => {
    if (!isRecord(value)) return value;
    const item = value;
    if (displayed < MAX_IMAGES && isSafeCodexInlineImage(imageSource(item))) {
      displayed++;
      return {
        type: item.type === 'image' ? 'text' : 'inputText',
        text: '[Image displayed below]',
      };
    }
    return item;
  });
}

export function isSafeCodexInlineImage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CODEX_INLINE_IMAGE_MAX_CHARS &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      value,
    )
  );
}

export function codexToolImageBlocks(content: unknown): PersistedChatBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: PersistedChatBlock[] = [];
  for (const value of content.slice(0, 100)) {
    if (!isRecord(value)) continue;
    const source = imageSource(value);
    if (isSafeCodexInlineImage(source)) {
      blocks.push({
        type: 'image',
        path: '',
        dataUrl: source,
        alt: 'Tool output image',
      });
      if (blocks.length === MAX_IMAGES) break;
    }
  }
  return blocks;
}

/** Replay guard for the preview tool's provider-native rollout log. */
export function withoutPreviewVisualImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const nestedSource = isRecord(value.source) ? value.source.data : undefined;
    const source = imageSource(value) ?? nestedSource;
    if (typeof source !== 'string') return value;
    const encoded = source.split(';base64,')[1] ?? source;
    return {
      type: 'inputText',
      text: `Preview screenshot, ${Math.floor((encoded.length * 3) / 4)} bytes, not stored`,
    };
  });
}

/** Readable fallback only; async questions are not synchronous tool requests. */
const ASYNC_QUESTION_LIMIT = 3;
const ASYNC_OPTION_LIMIT = 20;
const ASYNC_TITLE_MAX_CHARS = 8192;
const ASYNC_OPTION_MAX_CHARS = 2048;

function boundedAsyncText(
  value: string,
  maxChars: number,
  label: 'title' | 'option',
): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n[${String(omitted)} ${label} char${
    omitted === 1 ? '' : 's'
  } omitted]`;
}

function omittedCount(count: number, label: string): string {
  return `[${String(count)} additional ${label}${count === 1 ? '' : 's'} omitted]`;
}

export function codexAsyncQuestionText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const questions = value.slice(0, ASYNC_QUESTION_LIMIT);
  const rendered = questions.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const question = entry;
    if (
      !question ||
      typeof question !== 'object' ||
      typeof question.title !== 'string'
    )
      return [];
    const allOptions: string[] = Array.isArray(question.options)
      ? question.options.filter(
          (option): option is string => typeof option === 'string',
        )
      : [];
    const options = allOptions.slice(0, ASYNC_OPTION_LIMIT);
    const optionLines = options.map(
      (option: string) =>
        `- ${boundedAsyncText(option, ASYNC_OPTION_MAX_CHARS, 'option')}`,
    );
    if (options.length < allOptions.length) {
      optionLines.push(
        `- ${omittedCount(allOptions.length - options.length, 'option')}`,
      );
    }
    return [
      [
        boundedAsyncText(question.title, ASYNC_TITLE_MAX_CHARS, 'title'),
        ...optionLines,
      ].join('\n'),
    ];
  });
  if (questions.length < value.length) {
    rendered.push(omittedCount(value.length - questions.length, 'question'));
  }
  return rendered.join('\n\n');
}

/** Preserve the complete ordered form, or use the textual fallback for malformed data. */
export function readCodexAsyncQuestions(
  value: unknown,
): Array<{ title: string; options: string[] | null }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const questions: Array<{ title: string; options: string[] | null }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.title !== 'string' ||
      !entry.title.trim()
    )
      return undefined;
    if (
      entry.options !== null &&
      (!Array.isArray(entry.options) ||
        !entry.options.every(
          (option: unknown): option is string => typeof option === 'string',
        ))
    )
      return undefined;
    questions.push({
      title: entry.title,
      options: entry.options === null ? null : [...entry.options],
    });
  }
  return questions;
}
