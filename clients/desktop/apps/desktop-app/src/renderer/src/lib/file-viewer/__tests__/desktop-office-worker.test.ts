/** @jest-environment jsdom */
import {
  createDesktopOfficeWorker,
  createModuleWorker,
} from '../desktop-office-worker';

class FakeWorker {
  static constructed: Array<{ url: string; options?: WorkerOptions }> = [];
  constructor(url: string | URL, options?: WorkerOptions) {
    const href = String(url);
    FakeWorker.constructed.push({ url: href, options });
  }
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Expected a text Blob result.'));
    };
    reader.onerror = (): void =>
      reject(reader.error ?? new Error('Could not read worker wrapper.'));
    reader.readAsText(blob);
  });
}

describe('desktop office worker factory', () => {
  const createdBlobs: Blob[] = [];
  const workerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'Worker',
  );
  const urlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  afterEach(() => {
    if (workerDescriptor)
      Object.defineProperty(globalThis, 'Worker', workerDescriptor);
    else Reflect.deleteProperty(globalThis, 'Worker');
    if (urlDescriptor)
      Object.defineProperty(URL, 'createObjectURL', urlDescriptor);
    else Reflect.deleteProperty(URL, 'createObjectURL');
  });
  beforeEach(() => {
    FakeWorker.constructed = [];
    createdBlobs.length = 0;
    Object.assign(globalThis, { Worker: FakeWorker });
    Object.assign(URL, {
      createObjectURL: (blob: Blob): string => {
        createdBlobs.push(blob);
        return `blob:mock/${createdBlobs.length}`;
      },
    });
  });

  it('constructs a module worker from the built asset URL resolved against the document', () => {
    createDesktopOfficeWorker();
    expect(FakeWorker.constructed).toEqual([
      {
        url: new URL('./assets/office-parse.worker-mock.js', document.baseURI)
          .href,
        options: { type: 'module' },
      },
    ]);
  });

  it('selects one cached blob module wrapper for file URLs without attempting a direct worker', async () => {
    createModuleWorker('file:///app/assets/office.js');
    createModuleWorker('file:///app/assets/office.js');
    expect(FakeWorker.constructed.map((entry) => entry.url)).toEqual([
      'blob:mock/1',
      'blob:mock/1',
    ]);
    const blob = createdBlobs[0];
    if (!blob) throw new Error('Expected a worker wrapper Blob.');
    const source = await readBlobText(blob);
    expect(source).toBe('import "file:///app/assets/office.js";');
    expect(FakeWorker.constructed[0]?.options).toEqual({ type: 'module' });
  });

  it('resolves a relative asset for a packaged renderer path containing spaces and Unicode', async () => {
    const base = document.createElement('base');
    base.href =
      'file:///Applications/Office Preview/Документи.app/Contents/Resources/app/out/renderer/index.html';
    document.head.appendChild(base);
    try {
      createDesktopOfficeWorker();
      const blob = createdBlobs[createdBlobs.length - 1];
      if (!blob) throw new Error('Expected a worker wrapper Blob.');
      const source = await readBlobText(blob);
      expect(source).toBe(
        'import "file:///Applications/Office%20Preview/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B8.app/Contents/Resources/app/out/renderer/assets/office-parse.worker-mock.js";',
      );
      expect(FakeWorker.constructed[0]?.url).toMatch(/^blob:mock\//);
      expect(FakeWorker.constructed[0]?.options).toEqual({ type: 'module' });
    } finally {
      base.remove();
    }
  });

  it('propagates worker construction failures to the parse client', () => {
    Object.assign(globalThis, {
      Worker: class {
        constructor() {
          throw new DOMException('blocked', 'SecurityError');
        }
      },
    });
    expect(() =>
      createModuleWorker('file:///app/assets/blocked-office.js'),
    ).toThrow('blocked');
  });
});
