import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetRunDir } from '../_lib/output';
import { runHttpRequestAction } from '../http-request/runner';
import { runNotifyAction } from '../notify/runner';

interface OutputMap {
  [key: string]: string;
}

function readOutputs(filePath: string): OutputMap {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('outbound builtin actions', () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-outbound-actions-'),
    );
    outputFile = path.join(tempDir, 'canopy-output.txt');
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('http-request emits response outputs and injects auth header from env', async () => {
    const mockFetch = jest.fn<
      Promise<Response>,
      [string | URL | Request, RequestInit?]
    >();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      configurable: true,
    });

    await runHttpRequestAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_URL: 'https://example.test/api',
      INPUT_METHOD: 'post',
      INPUT_HEADERS: '{"X-Test":"yes"}',
      INPUT_BODY: '{"hello":"world"}',
      INPUT_CONTENT_TYPE: 'application/json',
      INPUT_AUTH_HEADER_ENV: 'WEB_TOKEN',
      WEB_TOKEN: 'Bearer secret-token',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toEqual({
      'X-Test': 'yes',
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-token',
    });
    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('201');
    expect(outputs.ok).toBe('true');
    expect(outputs.json_file).toBeTruthy();
  });

  it('http-request retries failed network attempts and enforces expected_status', async () => {
    const mockFetch = jest.fn<
      Promise<Response>,
      [string | URL | Request, RequestInit?]
    >();
    mockFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      configurable: true,
    });

    await expect(
      runHttpRequestAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_URL: 'https://example.test/api',
        INPUT_RETRIES: '1',
        INPUT_EXPECTED_STATUS: '200',
      }),
    ).rejects.toThrow('Expected HTTP status 200, received 404');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('http-request skips json_file for non-JSON text bodies', async () => {
    const mockFetch = jest.fn<
      Promise<Response>,
      [string | URL | Request, RequestInit?]
    >();
    mockFetch.mockResolvedValue(
      new Response('plain text response', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      configurable: true,
    });

    await runHttpRequestAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_URL: 'https://example.test/text',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.ok).toBe('true');
    expect(outputs.json_file).toBeUndefined();
    expect(outputs.body_file).toBeTruthy();
  });

  it('notify rejects non-desktop channels', async () => {
    await expect(
      runNotifyAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_CHANNEL: 'email',
      }),
    ).rejects.toThrow('notify requires channel "desktop"');
  });

  it('notify desktop emits the reserved notification output', async () => {
    await runNotifyAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_CHANNEL: 'desktop',
      INPUT_TITLE: 'Pipeline done',
      INPUT_BODY: 'Everything passed',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.CANOPY_NOTIFICATION).toBe(
      JSON.stringify({ title: 'Pipeline done', body: 'Everything passed' }),
    );
    expect(outputs.sent).toBe('true');
  });

  it('notify defaults omitted channel to desktop', async () => {
    await runNotifyAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_TITLE: 'Pipeline done',
      INPUT_BODY: 'Everything passed',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.CANOPY_NOTIFICATION).toBe(
      JSON.stringify({ title: 'Pipeline done', body: 'Everything passed' }),
    );
    expect(outputs.sent).toBe('true');
  });
});
