const SVG_OPEN_TAG_PATTERN = /<svg\b([^>]*)>/i;
const SVG_SIZE_ATTR_PATTERN =
  /\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const SVG_PRESERVE_ASPECT_RATIO_ATTR_PATTERN = /\spreserveAspectRatio\s*=/i;
const SVG_STYLE_ATTR_PATTERN = /\sstyle\s*=\s*("[^"]*"|'[^']*')/i;

export function toCssLength(
  value: number | string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

function appendDisplayBlockStyle(attributes: string): string {
  if (!SVG_STYLE_ATTR_PATTERN.test(attributes)) {
    return `${attributes} style="display:block"`;
  }

  return attributes.replace(
    SVG_STYLE_ATTR_PATTERN,
    (_styleAttribute, quotedValue: string) => {
      const quote = quotedValue[0];
      const styleValue = quotedValue.slice(1, -1).trim();
      const separator =
        styleValue.length > 0 && !styleValue.endsWith(';') ? ';' : '';
      return ` style=${quote}${styleValue}${separator}display:block${quote}`;
    },
  );
}

export function fitSvgToWrapper(svgMarkup: string): string {
  return svgMarkup.replace(
    SVG_OPEN_TAG_PATTERN,
    (_svgTag, rawAttributes: string) => {
      let attributes = rawAttributes.replace(SVG_SIZE_ATTR_PATTERN, '');
      attributes = appendDisplayBlockStyle(attributes);

      if (!SVG_PRESERVE_ASPECT_RATIO_ATTR_PATTERN.test(attributes)) {
        attributes += ' preserveAspectRatio="xMidYMid meet"';
      }

      attributes += ' width="100%" height="100%"';
      return `<svg ${attributes.trim()}>`;
    },
  );
}
