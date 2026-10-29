import DOMPurify from 'dompurify';
import { buildSandboxedHtmlSrcDoc } from '@canopy/ui-shared/lib/sandboxed-html';

export const DOCX_PREVIEW_MAX_ELEMENTS = 200_000;

export class DocxElementBudgetError extends Error {
  constructor() {
    super('DOCX preview exceeds its element budget.');
    this.name = 'DocxElementBudgetError';
  }
}

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'div',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];
const ALLOWED_ATTR = [
  'alt',
  'colspan',
  'href',
  'id',
  'rowspan',
  'src',
  'start',
  'title',
  'type',
];

function decodedBase64Length(value: string): number {
  return (
    (value.length / 4) * 3 -
    (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  );
}

export function sanitizeDocxHtml(html: string): string {
  const purifier = DOMPurify(window);
  let elements = 0;
  purifier.addHook('uponSanitizeElement', (node) => {
    if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== 'BODY') {
      elements += 1;
      if (elements > DOCX_PREVIEW_MAX_ELEMENTS)
        throw new DocxElementBudgetError();
    }
  });
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'href' && !data.attrValue.startsWith('#'))
      data.keepAttr = false;
    if (data.attrName === 'colspan' || data.attrName === 'rowspan') {
      data.keepAttr = /^\d+$/.test(data.attrValue);
    }
    if (data.attrName === 'src') {
      const match =
        /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
          data.attrValue,
        );
      const encoded = match?.[1] ?? '';
      const size = decodedBase64Length(encoded);
      data.keepAttr =
        node.nodeName === 'IMG' &&
        match !== null &&
        encoded.length % 4 === 0 &&
        size > 0 &&
        size <= 4 * 1024 * 1024;
    }
  });
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style',
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['style', 'class'],
    WHOLE_DOCUMENT: false,
  });
}

const DOCX_PREVIEW_BASE_STYLE =
  '<style>' +
  'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;margin:24px auto;max-width:800px;padding:0 16px;color:#1f2328;background:#fff}' +
  'table{border-collapse:collapse;margin:12px 0}td,th{border:0.5px solid #d0d7de;padding:4px 8px;vertical-align:top}' +
  'img{max-width:100%;height:auto}pre{white-space:pre-wrap}' +
  '</style>';

export function buildDocxPreviewSrcDoc(sanitizedHtml: string): string {
  return buildSandboxedHtmlSrcDoc(
    `${DOCX_PREVIEW_BASE_STYLE}\n${sanitizedHtml}`,
  );
}
