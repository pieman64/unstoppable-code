/** WCAG text contrast against composited ancestor backgrounds; runs in the page. */
export function textContrastRatio(element) {
  const context = document
    .createElement('canvas')
    .getContext('2d', { willReadFrequently: true });
  const paint = (color) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
  };
  paint('#ffffff');
  const layers = [];
  for (let node = element; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  let background = [];
  for (const layer of layers) background = paint(layer);
  const foreground = paint(getComputedStyle(element).color);
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}
