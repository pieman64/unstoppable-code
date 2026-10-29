/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/common/arrays.ts
 *  (commit c4632cac, 2026-06-30). Minimal subset required by the Canopy panels
 *  primitives (sash / splitview / gridview), adapted to Canopy lint rules.
 *--------------------------------------------------------------------------------------------*/

/**
 * Returns a range of numbers `[0, to)` (one argument) or `[from, to)` (two
 * arguments). When `from > to`, the range is descending: `[from, to)` counting
 * down, e.g. `range(3, -1)` is `[3, 2, 1, 0]`.
 */
export function range(to: number): number[];
export function range(from: number, to: number): number[];
export function range(arg: number, to?: number): number[] {
  let from = typeof to === 'number' ? arg : 0;

  if (typeof to === 'number') {
    from = arg;
  } else {
    from = 0;
    to = arg;
  }

  const result: number[] = [];

  if (from <= to) {
    for (let i = from; i < to; i++) {
      result.push(i);
    }
  } else {
    for (let i = from; i > to; i--) {
      result.push(i);
    }
  }

  return result;
}

/**
 * Pushes an element to the start of the array, if found.
 */
export function pushToStart<T>(arr: T[], value: T): void {
  const index = arr.indexOf(value);

  if (index > -1) {
    arr.splice(index, 1);
    arr.unshift(value);
  }
}

/**
 * Pushes an element to the end of the array, if found.
 */
export function pushToEnd<T>(arr: T[], value: T): void {
  const index = arr.indexOf(value);

  if (index > -1) {
    arr.splice(index, 1);
    arr.push(value);
  }
}
