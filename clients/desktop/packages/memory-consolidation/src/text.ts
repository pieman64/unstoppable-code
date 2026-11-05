const encoder = new TextEncoder();

/** UTF-8 length of a string, counting a lone surrogate as its 3-byte U+FFFD. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** LF line endings, no NUL bytes, no surrounding whitespace. */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
}
