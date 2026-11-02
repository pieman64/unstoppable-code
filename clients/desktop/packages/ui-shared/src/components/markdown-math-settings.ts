/**
 * Whether shared Markdown renders single-dollar `$...$` inline math
 * (CAN-5124). Hosts set it from their own preference; it defaults to on, and
 * `\(...\)`, `\[...\]`, `$$...$$` and math fences render either way.
 */
let singleDollarMath = true;
const listeners = new Set<() => void>();

export function isSingleDollarMathEnabled(): boolean {
  return singleDollarMath;
}

export function setSingleDollarMathEnabled(enabled: boolean): void {
  if (enabled === singleDollarMath) return;
  singleDollarMath = enabled;
  for (const listener of listeners) listener();
}

export function subscribeSingleDollarMath(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
