/**
 * Memory panel rows carry an opaque `data-memory-id` instead of their file
 * name, which can hold the memory's words. Same 32-bit FNV-1a hash as
 * `memoryRowId` in packages/ui-app/src/local-memory/memory-model.ts.
 *
 * @param {string} fileKey
 * @returns {string}
 */
export function memoryRowId(fileKey) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fileKey.length; index += 1) {
    hash ^= fileKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** CSS selector for the memory row of a file. */
export function memoryRowSelector(fileKey) {
  return `[data-testid="memory-row"][data-memory-id="${memoryRowId(fileKey)}"]`;
}
