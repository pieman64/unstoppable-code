/** Inclusive run of consecutive request ids. */
interface IdRange {
  start: number;
  end: number;
}

/**
 * Exact set of abandoned request ids still owed a late reply, kept as sorted
 * disjoint, non-adjacent ranges so contiguous cancellations share one entry.
 * The owner bounds memory through `rangeCount`.
 */
export class AbandonedIds {
  private readonly ranges: IdRange[] = [];

  get rangeCount(): number {
    return this.ranges.length;
  }

  add(id: number): void {
    const index = this.firstEndingAtOrAfter(id);
    const previous = this.rangeAt(index - 1);
    const next = this.rangeAt(index);
    if (next && next.start <= id) return;
    const joinsNext = next?.start === id + 1;
    if (previous?.end === id - 1) {
      if (next && joinsNext) {
        previous.end = next.end;
        this.ranges.splice(index, 1);
      } else {
        previous.end = id;
      }
    } else if (next && joinsNext) {
      next.start = id;
    } else {
      this.ranges.splice(index, 0, { start: id, end: id });
    }
  }

  /** Removes `id`; true only if it was present. An interior id splits its range. */
  take(id: number): boolean {
    const index = this.firstEndingAtOrAfter(id);
    const range = this.rangeAt(index);
    if (!range || range.start > id) return false;
    if (range.start === range.end) {
      this.ranges.splice(index, 1);
    } else if (id === range.start) {
      range.start = id + 1;
    } else if (id === range.end) {
      range.end = id - 1;
    } else {
      this.ranges.splice(index + 1, 0, { start: id + 1, end: range.end });
      range.end = id - 1;
    }
    return true;
  }

  private rangeAt(index: number): IdRange | undefined {
    return index >= 0 && index < this.ranges.length
      ? this.ranges[index]
      : undefined;
  }

  /** Binary search for the first range with `end >= id`. */
  private firstEndingAtOrAfter(id: number): number {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.ranges[middle].end < id) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
