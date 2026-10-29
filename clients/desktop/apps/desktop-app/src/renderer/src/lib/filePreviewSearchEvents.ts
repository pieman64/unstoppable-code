export const FILE_PREVIEW_SEARCH_EVENT = 'canopy:file-preview-search';

export interface FilePreviewSearchEventDetail {
  operation: 'open' | 'close';
  acknowledge: () => void;
}

export function isFilePreviewSearchEventDetail(
  value: unknown,
): value is FilePreviewSearchEventDetail {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'operation' in value &&
    (value.operation === 'open' || value.operation === 'close') &&
    'acknowledge' in value &&
    typeof value.acknowledge === 'function'
  );
}
