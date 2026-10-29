interface RetryDynamicImportOptions {
  delaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [150, 500, 1_000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export async function retryDynamicImport<T>(
  load: () => Promise<T>,
  options: RetryDynamicImportOptions = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await load();
    } catch (err: unknown) {
      lastError = err;

      const delayMs = delaysMs[attempt];
      if (delayMs === undefined) {
        break;
      }

      await delay(delayMs);
    }
  }

  throw lastError;
}
