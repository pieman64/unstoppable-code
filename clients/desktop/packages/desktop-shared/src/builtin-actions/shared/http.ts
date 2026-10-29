export interface HttpRequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutSeconds: number;
  retries: number;
}

export interface HttpResponseSnapshot {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface HttpRequestResult {
  response: HttpResponseSnapshot;
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function normalizeRetryCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export async function requestWithRetry(
  options: HttpRequestOptions,
): Promise<HttpRequestResult> {
  const retries = normalizeRetryCount(options.retries);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeoutSeconds * 1000);

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal,
      });
      const body = await response.text();
      clearTimeout(timeout);
      const result: HttpRequestResult = {
        response: {
          status: response.status,
          ok: response.ok,
          headers: responseHeadersToRecord(response.headers),
          body,
        },
        attempts: attempt + 1,
      };
      return result;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt >= retries) {
        break;
      }
      await sleep(250 * 2 ** attempt);
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `HTTP request failed after ${String(retries + 1)} attempt(s): ${message}`,
  );
}
