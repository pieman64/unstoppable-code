import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

interface PinnedRequestOptions {
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  lookup: LookupFunction;
  autoSelectFamily: boolean;
}

export interface PinnedHttpAddress {
  address: string;
  family: 4 | 6;
}

function requestPinnedHttpResponse(
  url: URL,
  addresses: PinnedHttpAddress[],
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (addresses.length === 0) {
      reject(new Error('HTTP endpoint has no validated network address'));
      return;
    }
    const lookup: LookupFunction = (_hostname, options, callback): void => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const address =
        addresses.find((candidate) => candidate.family === options.family) ??
        addresses[0];
      callback(null, address.address, address.family);
    };
    const requestOptions: PinnedRequestOptions = {
      method,
      headers,
      signal,
      lookup,
      autoSelectFamily: true,
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      requestOptions,
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const responseBody = new ReadableStream<Uint8Array>({
          start(controller): void {
            incoming.on('data', (chunk: Buffer): void => {
              controller.enqueue(chunk);
            });
            incoming.on('end', (): void => controller.close());
            incoming.on('error', (error): void => controller.error(error));
          },
          cancel(): void {
            incoming.destroy();
          },
        });
        resolve(
          new Response(responseBody, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * Send an HTTP request while forcing DNS lookup to use an already validated
 * address. The URL hostname remains intact so Host headers and TLS SNI still
 * identify the configured MCP origin.
 */
export function fetchPinnedHttpResponse(
  url: URL,
  addresses: PinnedHttpAddress[],
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  return requestPinnedHttpResponse(
    url,
    addresses,
    'POST',
    headers,
    body,
    signal,
  );
}

/** Fetch a validated URL with GET while preserving its Host header and TLS SNI. */
export function fetchPinnedHttpGetResponse(
  url: URL,
  addresses: PinnedHttpAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return requestPinnedHttpResponse(
    url,
    addresses,
    'GET',
    headers,
    undefined,
    signal,
  );
}
