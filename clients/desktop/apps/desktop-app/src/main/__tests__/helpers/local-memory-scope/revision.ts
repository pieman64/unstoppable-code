/** The revision token one document write after `token`. */
export function nextMemoryRevision(token: string): string {
  const separator = token.lastIndexOf(':');
  return `${token.slice(0, separator)}:${Number(token.slice(separator + 1)) + 1}`;
}
