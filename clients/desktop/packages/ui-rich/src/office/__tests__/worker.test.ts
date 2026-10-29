import {
  buildPptxFixture,
  buildReg2902DocxFixture,
  buildReg2902DenseDocxFixture,
} from '../../../test/ooxml-fixtures.js';
import type { OfficeParseRequest, OfficeParseResponse } from '../office-parse';
import { installOfficeParseWorker, type OfficeWorkerScope } from '../worker';

interface RecordingScope extends OfficeWorkerScope {
  readonly response: Promise<OfficeParseResponse>;
}

function scope(): RecordingScope {
  let resolveResponse: (message: OfficeParseResponse) => void = () => undefined;
  const response = new Promise<OfficeParseResponse>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    response,
    onmessage: null,
    postMessage(message: OfficeParseResponse): void {
      resolveResponse(message);
    },
  };
}

// Await the posted response instead of polling against a fixed wall-clock
// deadline: dense and 4 MiB parses legitimately exceed one second on loaded
// CI runners. The heavy cases carry an explicit Jest timeout instead.
function dispatch(
  target: RecordingScope,
  request: OfficeParseRequest,
): Promise<OfficeParseResponse> {
  target.onmessage?.(new MessageEvent('message', { data: request }));
  return target.response;
}

const HEAVY_PARSE_TIMEOUT_MS = 30_000;

describe('installOfficeParseWorker', () => {
  it('parses a DOCX request and posts the semantic HTML', async () => {
    const target = scope();
    installOfficeParseWorker(target);
    const response = await dispatch(target, {
      kind: 'docx',
      bytes: Uint8Array.from(buildReg2902DocxFixture()).buffer,
    });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result.kind).toBe('docx');
  });

  it('parses a PPTX request and posts the slide model', async () => {
    const target = scope();
    installOfficeParseWorker(target);
    const response = await dispatch(target, {
      kind: 'pptx',
      bytes: Uint8Array.from(buildPptxFixture()).buffer,
    });
    expect(response.ok).toBe(true);
    if (response.ok && response.result.kind === 'pptx') {
      expect(response.result.slides).toHaveLength(2);
    } else {
      throw new Error('Expected a PPTX result.');
    }
  });

  it('keeps a bounded formatted DOCX preview available', async () => {
    const target = scope();
    installOfficeParseWorker(target);
    const response = await dispatch(target, {
      kind: 'docx',
      bytes: Uint8Array.from(
        buildReg2902DenseDocxFixture({ paragraphs: 100, tableRows: 20 }),
      ).buffer,
    });
    expect(response.ok).toBe(true);
    if (response.ok && response.result.kind === 'docx') {
      expect(response.result.html).toContain('t19 c3');
    }
  });

  it(
    'preserves dense DOCX output within the established parser budgets',
    async () => {
      const target = scope();
      installOfficeParseWorker(target);
      const response = await dispatch(target, {
        kind: 'docx',
        bytes: Uint8Array.from(buildReg2902DenseDocxFixture()).buffer,
      });
      expect(response.ok).toBe(true);
      if (response.ok && response.result.kind === 'docx') {
        expect(response.result.html).toContain('REG-2902 dense end');
      }
    },
    HEAVY_PARSE_TIMEOUT_MS,
  );

  it(
    'posts inline images at the full 4 MiB conversion budget',
    async () => {
      const target = scope();
      installOfficeParseWorker(target);
      const imageBytes = new Uint8Array(4 * 1024 * 1024);
      const response = await dispatch(target, {
        kind: 'docx',
        bytes: Uint8Array.from(buildReg2902DocxFixture({ imageBytes })).buffer,
      });
      expect(response.ok).toBe(true);
      if (response.ok && response.result.kind === 'docx') {
        expect(response.result.html).toContain(
          Buffer.from(imageBytes).toString('base64'),
        );
      }
    },
    HEAVY_PARSE_TIMEOUT_MS,
  );

  it('posts a failure message instead of throwing on garbage bytes', async () => {
    const target = scope();
    installOfficeParseWorker(target);
    const response = await dispatch(target, {
      kind: 'xlsx',
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(response).toEqual({
      ok: false,
      error: 'Office file is not a supported ZIP archive.',
    });
  });
});
