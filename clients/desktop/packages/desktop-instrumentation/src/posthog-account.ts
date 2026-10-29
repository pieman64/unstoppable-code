/** Only domain metadata crosses this boundary; never pass an account or email. */
export interface PostHogAccountSource {
  getSnapshot(): Promise<string | null>;
  onSnapshotChanged(listener: (domain: string | null) => void): () => void;
}

export interface PostHogAccountTracker {
  readonly domain: string | null | undefined;
  readonly ready: Promise<void>;
  dispose(): void;
}

/** ASCII DNS names (including punycode), excluding IP literals and prose. */
export function normalizePostHogEmailDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase();
  if (domain.length > 253) return null;
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) ||
    !/[a-z]/.test(labels[labels.length - 1] ?? '')
  )
    return null;
  return domain;
}

export function getPostHogEmailDomain(email?: string): string | null {
  const normalized = email?.trim();
  if (!normalized || !/^[^@\s]+@[^@\s]+$/.test(normalized)) return null;
  return normalizePostHogEmailDomain(
    normalized.slice(normalized.indexOf('@') + 1),
  );
}

/** Subscribe before reading so a delayed snapshot cannot restore an old account. */
export function createPostHogAccountTracker(
  source: PostHogAccountSource | undefined,
  onChanged: () => void,
): PostHogAccountTracker {
  let domain: string | null | undefined;
  let revision = 0;
  let disposed = false;
  const update = (value: string | null): void => {
    if (disposed) return;
    const next = normalizePostHogEmailDomain(value);
    if (next === domain) return;
    domain = next;
    try {
      onChanged();
    } catch {
      /* Telemetry must not affect account changes. */
    }
  };
  const unsubscribe = source?.onSnapshotChanged((next) => {
    revision++;
    update(next);
  });
  const ready = source
    ? Promise.resolve()
        .then(() => source.getSnapshot())
        .then(
          (snapshot): void => {
            if (revision === 0) update(snapshot);
          },
          (): void => {
            if (revision === 0) update(null);
          },
        )
    : Promise.resolve();
  return {
    get domain(): string | null | undefined {
      return domain;
    },
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        /* Disposal remains best-effort. */
      }
    },
  };
}
