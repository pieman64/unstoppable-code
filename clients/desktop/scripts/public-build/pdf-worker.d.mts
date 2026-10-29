export interface PreparedPdfWorker {
  readonly version: string;
  readonly destination: string;
}

export function preparePdfWorker(options: {
  readonly destinationDir: string;
  readonly packageDir?: string;
}): PreparedPdfWorker;
