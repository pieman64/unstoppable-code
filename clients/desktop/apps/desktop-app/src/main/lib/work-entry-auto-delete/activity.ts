const listeners = new Set<(keys: ReadonlySet<string>) => void>();
const previousBySource = new Map<string, ReadonlySet<string>>();

export function publishAutoDeleteActivity(
  source: string,
  keys: ReadonlySet<string>,
): void {
  const changed = new Set([...(previousBySource.get(source) ?? []), ...keys]);
  previousBySource.set(source, keys);
  for (const listener of listeners) listener(changed);
}

export function subscribeAutoDeleteActivity(
  listener: (keys: ReadonlySet<string>) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
