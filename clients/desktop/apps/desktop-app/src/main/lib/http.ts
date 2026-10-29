import * as https from 'node:https';

interface HttpsRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Make an HTTPS GET request and return the response as a Buffer.
 * Handles redirects (stripping auth headers on cross-origin redirects).
 */
export function httpsGetBuffer(
  url: string,
  options: HttpsRequestOptions = {},
): Promise<Buffer> {
  const { headers = {}, timeoutMs = 15000, maxRedirects = 5 } = options;
  return doRequest(url, headers, timeoutMs, maxRedirects);
}

/**
 * Make an HTTPS GET request and return the response as a string.
 * Handles redirects (stripping auth headers on cross-origin redirects).
 */
export async function httpsGet(
  url: string,
  options: HttpsRequestOptions = {},
): Promise<string> {
  const buf = await httpsGetBuffer(url, options);
  return buf.toString('utf-8');
}

function doRequest(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectsLeft: number,
): Promise<Buffer> {
  if (redirectsLeft <= 0) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.get(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'canopy-skills',
          ...headers,
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location);
          // Strip auth header on cross-origin redirect to avoid token leakage
          const redirectHeaders =
            redirectUrl.hostname !== parsedUrl.hostname
              ? Object.fromEntries(
                  Object.entries(headers).filter(
                    ([k]) => k.toLowerCase() !== 'authorization',
                  ),
                )
              : headers;
          doRequest(
            res.headers.location,
            redirectHeaders,
            timeoutMs,
            redirectsLeft - 1,
          ).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}
