const UNSAFE_CHAT_TAB_METADATA_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function isSafeChatTabMetadataKey(key: string): boolean {
  return !UNSAFE_CHAT_TAB_METADATA_KEYS.has(key);
}

/** Define an enumerable own data property without invoking prototype setters. */
export function defineChatTabMetadataProperty(
  target: object,
  key: string,
  value: unknown,
): boolean {
  if (!isSafeChatTabMetadataKey(key)) return false;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return true;
}
