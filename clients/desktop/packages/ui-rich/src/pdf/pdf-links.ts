export interface PdfExternalLink {
  readonly url: string;
  readonly rect: readonly number[];
}

export function isPdfRectangle(
  value: unknown,
): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (coordinate: unknown) =>
        typeof coordinate === 'number' && Number.isFinite(coordinate),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function pdfExternalLinks(annotations: unknown): PdfExternalLink[] {
  if (!Array.isArray(annotations)) return [];
  const links: PdfExternalLink[] = [];
  for (const annotation of annotations) {
    if (!isRecord(annotation)) continue;
    const candidate = annotation;
    if (candidate.subtype !== 'Link' || typeof candidate.url !== 'string')
      continue;
    const rect = candidate.rect;
    if (!isPdfRectangle(rect)) continue;
    try {
      const url = new URL(candidate.url);
      // Use PDF.js sanitized URLs, never unsafeUrl or executable/local schemes.
      // No PDF actions run; navigation requires an explicit link click.
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) continue;
      links.push({ url: url.href, rect });
    } catch {
      /* Invalid annotations do not prevent previewing the page. */
    }
  }
  return links;
}
