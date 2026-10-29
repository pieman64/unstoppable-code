/** @jest-environment jsdom */

import type { OfficeParseRequest, OfficeParseResponse } from '../office-parse';
import {
  OFFICE_PARSE_TIMEOUT_MS,
  OfficeParseError,
  parseOfficeDocument,
} from '../office-parse-client';

type WorkerBehaviour =
  | 'ok'
  | 'parse-error'
  | 'crash'
  | 'message-error'
  | 'hang';

class FakeWorker extends EventTarget implements Worker {
  onmessage:
    | ((this: Worker, event: MessageEvent<OfficeParseResponse>) => void)
    | null = null;
  onmessageerror: ((this: Worker, event: MessageEvent) => void) | null = null;
  onerror: ((this: AbstractWorker, event: ErrorEvent) => unknown) | null = null;
  readonly terminate = jest.fn<void, []>();
  readonly posts: {
    readonly message: OfficeParseRequest;
    readonly transfer: readonly Transferable[];
  }[] = [];

  constructor(private readonly behaviour: WorkerBehaviour) {
    super();
  }

  postMessage(message: OfficeParseRequest, transfer: Transferable[]): void;
  postMessage(
    message: OfficeParseRequest,
    options?: StructuredSerializeOptions,
  ): void;
  postMessage(
    message: OfficeParseRequest,
    transferOrOptions: Transferable[] | StructuredSerializeOptions = [],
  ): void {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : (transferOrOptions.transfer ?? []);
    this.posts.push({ message, transfer });
    queueMicrotask(() => {
      if (this.behaviour === 'ok') {
        this.onmessage?.call(
          this,
          new MessageEvent<OfficeParseResponse>('message', {
            data: {
              ok: true,
              result: { kind: 'docx', html: '<p>x</p>', warnings: [] },
            },
          }),
        );
      } else if (this.behaviour === 'parse-error') {
        this.onmessage?.call(
          this,
          new MessageEvent<OfficeParseResponse>('message', {
            data: { ok: false, error: 'bad zip' },
          }),
        );
      } else if (this.behaviour === 'crash') {
        this.onerror?.call(
          this,
          new ErrorEvent('error', { message: 'worker exploded' }),
        );
      } else if (this.behaviour === 'message-error') {
        this.onmessageerror?.call(this, new MessageEvent('messageerror'));
      }
    });
  }
}

function docxRequest(): OfficeParseRequest {
  return { kind: 'docx', bytes: new Uint8Array([1, 2, 3]).buffer };
}

describe('parseOfficeDocument', () => {
  afterEach(() => jest.useRealTimers());

  it('resolves the worker result, transfers an equal copy, preserves input, and terminates', async () => {
    const worker = new FakeWorker('ok');
    const request = docxRequest();
    const result = await parseOfficeDocument(request, {
      createWorker: () => worker,
    });
    expect(result).toEqual({ kind: 'docx', html: '<p>x</p>', warnings: [] });
    expect(request.bytes.byteLength).toBe(3);
    expect(worker.posts).toHaveLength(1);
    expect(worker.posts[0].message.bytes).not.toBe(request.bytes);
    expect([...new Uint8Array(worker.posts[0].message.bytes)]).toEqual([
      1, 2, 3,
    ]);
    expect(worker.posts[0].transfer).toEqual([worker.posts[0].message.bytes]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  it.each([
    ['parse-error', 'parse-error'],
    ['crash', 'worker-error'],
    ['message-error', 'worker-error'],
  ] as const)(
    'maps %s to %s and terminates once',
    async (behaviour, reason) => {
      const worker = new FakeWorker(behaviour);
      await expect(
        parseOfficeDocument(docxRequest(), { createWorker: () => worker }),
      ).rejects.toMatchObject({ name: 'OfficeParseError', reason });
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    },
  );

  it('times out a hung worker and ignores its late success', async () => {
    jest.useFakeTimers();
    const worker = new FakeWorker('hang');
    const pending = parseOfficeDocument(docxRequest(), {
      createWorker: () => worker,
      timeoutMs: 50,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      reason: 'timeout',
    });
    jest.advanceTimersByTime(50);
    await assertion;
    worker.onmessage?.call(
      worker,
      new MessageEvent<OfficeParseResponse>('message', {
        data: {
          ok: true,
          result: { kind: 'docx', html: 'late', warnings: [] },
        },
      }),
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('aborts an active worker and ignores late events', async () => {
    const worker = new FakeWorker('hang');
    const controller = new AbortController();
    const pending = parseOfficeDocument(docxRequest(), {
      createWorker: () => worker,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-aborted request without creating a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const createWorker = jest.fn<Worker, []>();
    await expect(
      parseOfficeDocument(docxRequest(), {
        createWorker,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: 'aborted' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it.each(['factory', 'postMessage'] as const)(
    'maps a throwing %s to worker-error',
    async (stage) => {
      const worker = new FakeWorker('hang');
      if (stage === 'postMessage')
        worker.postMessage = (): never => {
          throw new Error('transfer failed');
        };
      const createWorker = (): Worker => {
        if (stage === 'factory') throw new Error('creation failed');
        return worker;
      };
      await expect(
        parseOfficeDocument(docxRequest(), { createWorker }),
      ).rejects.toMatchObject({ reason: 'worker-error' });
      expect(worker.terminate).toHaveBeenCalledTimes(
        stage === 'factory' ? 0 : 1,
      );
    },
  );

  it('rejects a result whose kind differs from the request', async () => {
    const worker = new FakeWorker('hang');
    const pending = parseOfficeDocument(docxRequest(), {
      createWorker: () => worker,
    });
    worker.onmessage?.call(
      worker,
      new MessageEvent<OfficeParseResponse>('message', {
        data: { ok: true, result: { kind: 'xlsx', sheets: [] } },
      }),
    );
    await expect(pending).rejects.toMatchObject({ reason: 'worker-error' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('uses a 30 second default and gives errors a stable name', () => {
    expect(OFFICE_PARSE_TIMEOUT_MS).toBe(30_000);
    expect(new OfficeParseError('timeout', 'x').name).toBe('OfficeParseError');
  });
});
