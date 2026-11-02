'use client';

import { useSyncExternalStore } from 'react';
import {
  isSingleDollarMathEnabled,
  subscribeSingleDollarMath,
} from './markdown-math-settings';

/** Re-renders the caller when the `$...$` math setting changes. */
export function useSingleDollarMathEnabled(): boolean {
  return useSyncExternalStore(
    subscribeSingleDollarMath,
    isSingleDollarMathEnabled,
    isSingleDollarMathEnabled,
  );
}
