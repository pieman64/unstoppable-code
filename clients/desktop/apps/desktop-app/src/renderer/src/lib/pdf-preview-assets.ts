import type { PdfPreviewAssets } from '@canopy/ui-rich/pdf';

export function resolveDesktopPdfPreviewAssets(): PdfPreviewAssets {
  const base = new URL('pdf-worker/', document.baseURI);
  return {
    workerSrc: new URL('pdf.worker.min.mjs', base).href,
    assetBaseUrl: base.href,
  };
}
