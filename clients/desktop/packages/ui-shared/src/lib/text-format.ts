/** Capitalize the first Unicode code point without splitting surrogate pairs. */
export function capitalizeFirstLetter(text: string): string {
  const [first, ...rest] = Array.from(text);
  return first === undefined ? text : first.toUpperCase() + rest.join('');
}
