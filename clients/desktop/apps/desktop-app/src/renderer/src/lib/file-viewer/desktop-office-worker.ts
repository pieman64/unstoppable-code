import officeWorkerUrl from './office-parse.worker?worker&url';

const wrapperUrlByModule = new Map<string, string>();

function blobWrapperUrl(moduleUrl: string): string {
  const cached = wrapperUrlByModule.get(moduleUrl);
  if (cached !== undefined) return cached;
  // Built renderers load from file:, an opaque origin that Chromium may refuse
  // to spawn workers from directly. A same-origin blob that imports the exact
  // module URL keeps the real asset (and its CDP-observable request) intact,
  // the same technique pdf.js uses for cross-origin workerSrc. The wrapper is
  // tiny and constant per module, so it is cached for the renderer's lifetime
  // instead of revoked while a worker may still be fetching it.
  const wrapper = URL.createObjectURL(
    new Blob([`import ${JSON.stringify(moduleUrl)};`], {
      type: 'text/javascript',
    }),
  );
  wrapperUrlByModule.set(moduleUrl, wrapper);
  return wrapper;
}

/** Construct a module worker for `url`, wrapping opaque-origin URLs in a blob. */
export function createModuleWorker(url: string): Worker {
  const moduleUrl = new URL(url, document.baseURI).href;
  const workerUrl =
    new URL(moduleUrl).protocol === 'file:'
      ? blobWrapperUrl(moduleUrl)
      : moduleUrl;
  return new Worker(workerUrl, { type: 'module' });
}

/** Host factory handed to `@canopy/ui-rich/office`; one worker per parse. */
export function createDesktopOfficeWorker(): Worker {
  return createModuleWorker(officeWorkerUrl);
}
