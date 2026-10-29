import {
  parseDocxToHtml,
  parseXlsxWorkbook,
  type OfficeParseRequest,
  type OfficeParseResponse,
} from './office-parse';
import { parsePptxPresentation } from './pptx-parse';

export interface OfficeWorkerScope {
  onmessage: ((event: MessageEvent<OfficeParseRequest>) => void) | null;
  postMessage(message: OfficeParseResponse): void;
}

export function installOfficeParseWorker(scope: OfficeWorkerScope): void {
  scope.onmessage = (event: MessageEvent<OfficeParseRequest>): void => {
    const { kind, bytes } = event.data;
    void (async (): Promise<void> => {
      try {
        const result =
          kind === 'docx'
            ? await parseDocxToHtml(bytes)
            : kind === 'pptx'
              ? parsePptxPresentation(bytes)
              : parseXlsxWorkbook(bytes);
        scope.postMessage({ ok: true, result });
      } catch (error) {
        scope.postMessage({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Unable to parse document.',
        });
      }
    })();
  };
}
