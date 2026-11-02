'use client';

import {
  createContext,
  useContext,
  useEffect,
  type JSX,
  type ReactNode,
} from 'react';
import { prefersReducedMotion } from '../lib/reduced-motion';
import type { compiler, RuleType } from 'markdown-to-jsx';
import type { MarkdownProps, prepareMarkdownRender } from './markdown-render';

/**
 * Smooth streaming: a streaming reply's
 * text is revealed in whole words on a steady 30 Hz beat that trails the
 * stream slightly, and each newly revealed stretch fades in. Half-typed
 * markdown (an unclosed `**` or backtick) stays hidden until it closes.
 * Hosts provide the choice once at their root; `Markdown` reads it while a
 * document streams. Reduced motion turns the beat and the fade off.
 *
 * The pacing and fading renderer (`MarkdownSmooth`) is its own chunk, kept
 * off every page's first load: the provider loads it once the choice is on,
 * and a document that mounts before it has loaded renders as today.
 */
const SmoothStreamingContext = createContext(false);

export function SmoothStreamingProvider({
  value,
  children,
}: {
  readonly value: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    if (value) void preloadSmoothMarkdown();
  }, [value]);
  return (
    <SmoothStreamingContext.Provider value={value}>
      {children}
    </SmoothStreamingContext.Provider>
  );
}

/**
 * Whether smooth streaming applies here: the host's choice, unless the
 * reader asked for reduced motion, which keeps today's rendering everywhere.
 */
export function useSmoothStreaming(): boolean {
  return useContext(SmoothStreamingContext) && !prefersReducedMotion();
}

/**
 * What the smooth renderer compiles with, handed over by `Markdown`. The
 * renderer's chunk imports none of these itself, so it shares no module with
 * the first load and the first load's chunks stay as they were.
 */
export interface SmoothMarkdownTools {
  readonly compiler: typeof compiler;
  readonly prepareMarkdownRender: typeof prepareMarkdownRender;
  readonly textRule: typeof RuleType.text;
}

type SmoothMarkdownComponent = (
  props: MarkdownProps & { readonly tools: SmoothMarkdownTools },
) => JSX.Element;

let smoothMarkdown: SmoothMarkdownComponent | null = null;
let smoothMarkdownLoad: Promise<void> | null = null;

/** Loads the smooth Markdown renderer; resolves once it can render. */
export function preloadSmoothMarkdown(): Promise<void> {
  smoothMarkdownLoad ??= import('./MarkdownSmooth').then((module) => {
    smoothMarkdown = module.SmoothMarkdown;
  });
  return smoothMarkdownLoad;
}

/** The smooth Markdown renderer once loaded, otherwise `null`. */
export function loadedSmoothMarkdown(): SmoothMarkdownComponent | null {
  return smoothMarkdown;
}
