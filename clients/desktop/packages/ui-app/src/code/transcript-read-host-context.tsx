'use client';
import { createContext, type ReactNode } from 'react';
import type { TranscriptReadSource } from '@canopy/app-core';
import type { DelegationBlockRenderer } from './DelegationRowBlocks';
import type { DelegationChildRowEntry } from './delegation-child-rows';

export interface TranscriptReadHost {
  readonly source: TranscriptReadSource;
  /** Return one keyed element for each entry, including notices/empty rows. */
  readonly renderRows: (
    entries: readonly DelegationChildRowEntry[],
  ) => ReactNode;
  readonly epoch: number;
  readonly v2Available?: boolean;
  readonly renderBlock?: DelegationBlockRenderer;
}

/**
 * Supplied by the owning chat, never selected navigation. Nested delegation
 * cards retain that owner's source rather than changing it to the child chat.
 * Null means this view has no transcript-read provenance/renderer.
 */
export const TranscriptReadHostContext =
  createContext<TranscriptReadHost | null>(null);
