export const HTML_FILE_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "navigate-to 'none'",
  "worker-src 'none'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_FILE_PREVIEW_CSP}">`;
const LEADING_DOCTYPE_PATTERN = /^\s*<!doctype[^>]*>/i;
const HTTP_EQUIV_PATTERN =
  /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

function findTagEnd(content: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function tagName(tag: string): string | null {
  const match = tag.match(/^<\s*\/?\s*([a-zA-Z][^\s/>]*)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function findRawTextClosingTag(
  content: string,
  start: number,
  name: string,
): number {
  const lowerContent = content.toLowerCase();
  const needle = `</${name}`;
  let index = lowerContent.indexOf(needle, start);
  while (index !== -1) {
    const nextCharacter = lowerContent[index + needle.length];
    if (
      nextCharacter === undefined ||
      nextCharacter === '>' ||
      /\s/.test(nextCharacter)
    ) {
      return index;
    }
    index = lowerContent.indexOf(needle, index + needle.length);
  }
  return -1;
}

function removeMetaRefresh(content: string): string {
  let output = '';
  let index = 0;
  let rawElement: string | null = null;
  while (index < content.length) {
    if (rawElement) {
      const closeStart = findRawTextClosingTag(content, index, rawElement);
      if (closeStart === -1) return output + content.slice(index);
      const closeEnd = findTagEnd(content, closeStart);
      if (closeEnd === -1) return output + content.slice(index);
      output += content.slice(index, closeEnd + 1);
      index = closeEnd + 1;
      rawElement = null;
      continue;
    }
    const start = content.indexOf('<', index);
    if (start === -1) return output + content.slice(index);
    const end = findTagEnd(content, start);
    if (end === -1) return output + content.slice(index);
    output += content.slice(index, start);
    const tag = content.slice(start, end + 1);
    const name = tagName(tag);
    const httpEquiv = tag.match(HTTP_EQUIV_PATTERN);
    const value = httpEquiv?.[1] ?? httpEquiv?.[2] ?? httpEquiv?.[3] ?? '';
    if (name !== 'meta' || value.trim().toLowerCase() !== 'refresh') {
      output += tag;
    }
    if (
      name &&
      !/^<\s*\//.test(tag) &&
      !/\/\s*>$/.test(tag) &&
      RAW_TEXT_ELEMENTS.has(name)
    ) {
      rawElement = name;
    }
    index = end + 1;
  }
  return output;
}

/** Build an opaque-origin preview document with navigation and network access disabled. */
export function buildSandboxedHtmlSrcDoc(content: string): string {
  const body = removeMetaRefresh(content)
    .replace(LEADING_DOCTYPE_PATTERN, '')
    .trimStart();
  return `<!doctype html>\n${CSP_META}\n${body}`;
}
