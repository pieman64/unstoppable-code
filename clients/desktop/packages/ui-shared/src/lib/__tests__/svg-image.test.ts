/** @jest-environment jsdom */
// jsdom omits the WHATWG encoding globals the sanitizer uses.
/* eslint-disable no-restricted-imports */
import { TextDecoder, TextEncoder } from 'node:util';
import {
  isSvgImageMediaType,
  SVG_IMAGE_MAX_BYTES,
  svgImageDataUrl,
} from '../svg-image';

Reflect.set(globalThis, 'TextEncoder', TextEncoder);
Reflect.set(globalThis, 'TextDecoder', TextDecoder);

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
}

function decode(url: string | null): string {
  expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
  const binary = atob((url ?? '').slice(url?.indexOf(',') ?? 0).slice(1));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

describe('isSvgImageMediaType', () => {
  it.each(['image/svg+xml', 'IMAGE/SVG+XML; charset=utf-8', ' image/svg+xml '])(
    'accepts %s',
    (mediaType) => expect(isSvgImageMediaType(mediaType)).toBe(true),
  );

  it.each([undefined, '', 'image/png', 'text/html', 'image/svg'])(
    'rejects %s',
    (mediaType) => expect(isSvgImageMediaType(mediaType)).toBe(false),
  );
});

describe('svgImageDataUrl', () => {
  it('keeps drawing markup and writes the SVG namespace', () => {
    const svg = decode(
      svgImageDataUrl(
        bytes(
          '<?xml version="1.0"?><!DOCTYPE svg><svg viewBox="0 0 10 10"><rect width="10" height="10" fill="green"/></svg>',
        ),
      ),
    );
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 10 10"');
    expect(svg).toContain('<rect width="10" height="10" fill="green"');
  });

  it('preserves non-ASCII text', () => {
    const svg = decode(
      svgImageDataUrl(
        bytes(
          '<svg xmlns="http://www.w3.org/2000/svg"><text>Grüße ✓</text></svg>',
        ),
      ),
    );
    expect(svg).toContain('Grüße ✓');
  });

  it('strips script, handlers, links, and embedded HTML', () => {
    const svg = decode(
      svgImageDataUrl(
        bytes(
          '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
            '<script>alert(2)</script>' +
            '<a href="javascript:alert(3)"><rect width="1" height="1"/></a>' +
            '<foreignObject><div>html</div></foreignObject>' +
            '<circle r="1" onclick="alert(4)"/></svg>',
        ),
      ),
    );
    expect(svg).not.toMatch(/script|onload|onclick|javascript|foreignObject/i);
    expect(svg).toContain('<circle r="1"');
  });

  it.each([
    ['href', 'href="#dot"'],
    ['xlink:href', 'xlink:href="#dot"'],
  ])(
    'keeps a <use> that references a local fragment through %s',
    (_label, ref) => {
      const svg = decode(
        svgImageDataUrl(
          bytes(
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
              '<defs><circle id="dot" r="2"/></defs>' +
              `<use ${ref} x="4"/></svg>`,
          ),
        ),
      );
      expect(svg).toMatch(/<use [^>]*href="#dot"/);
      expect(svg).toContain('<circle id="dot" r="2"');
    },
  );

  it.each([
    ['an external file', 'href="https://example.com/sprite.svg#dot"'],
    ['a data URL', 'href="data:image/svg+xml;base64,PHN2Zy8+"'],
    ['a javascript URL', 'xlink:href="javascript:alert(1)"'],
    ['no reference', 'x="1"'],
  ])('drops a <use> that points at %s', (_label, ref) => {
    const svg = decode(
      svgImageDataUrl(
        bytes(
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
            `<circle r="1"/><use ${ref}/></svg>`,
        ),
      ),
    );
    expect(svg).not.toContain('<use');
    expect(svg).toContain('<circle r="1"');
  });

  it.each([
    ['an empty file', ''],
    ['HTML', '<html><body><p>hi</p></body></html>'],
    ['text', 'not markup at all'],
    [
      'two roots',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ],
  ])('returns null for %s', (_label, text) => {
    expect(svgImageDataUrl(bytes(text))).toBeNull();
  });

  it('returns null for invalid UTF-8 and oversized input', () => {
    expect(svgImageDataUrl(new Uint8Array([0xff, 0xfe, 0x3c]).buffer)).toBe(
      null,
    );
    expect(svgImageDataUrl(new ArrayBuffer(SVG_IMAGE_MAX_BYTES + 1))).toBe(
      null,
    );
  });
});
