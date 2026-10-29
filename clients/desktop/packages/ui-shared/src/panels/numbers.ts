/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/common/numbers.ts
 *  (commit c4632cac, 2026-06-30). Minimal subset required by the Canopy panels
 *  primitives (sash / splitview / gridview), adapted to Canopy lint rules.
 *--------------------------------------------------------------------------------------------*/

/**
 * Clamps `value` between `min` and `max`, inclusive.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Positive euclidean modulo. `rot(-1, 3)` is `2`.
 */
export function rot(index: number, modulo: number): number {
  return ((index % modulo) + modulo) % modulo;
}
