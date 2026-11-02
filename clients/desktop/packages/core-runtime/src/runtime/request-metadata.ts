function isTransform(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'def' in schema &&
    typeof schema.def === 'object' &&
    schema.def !== null &&
    'type' in schema.def &&
    schema.def.type === 'transform'
  );
}

/**
 * Whether a params schema declares `_meta` itself: an object with `_meta`, a
 * union whose branches all declare it, or a pipe whose input side does (the
 * output side after a preprocess, as the Ledger's keyed instructions use). A
 * host that splits request metadata off the wire params must keep it there for
 * such a schema. A union where only some branches declare it is treated as not
 * declaring, so those branches cannot be served.
 */
export function paramsDeclareMeta(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  if ('shape' in params)
    return (
      typeof params.shape === 'object' &&
      params.shape !== null &&
      '_meta' in params.shape
    );
  if ('options' in params && Array.isArray(params.options))
    return (
      params.options.length > 0 &&
      params.options.every((option) => paramsDeclareMeta(option))
    );
  if ('in' in params && 'out' in params)
    return paramsDeclareMeta(isTransform(params.in) ? params.out : params.in);
  return false;
}
