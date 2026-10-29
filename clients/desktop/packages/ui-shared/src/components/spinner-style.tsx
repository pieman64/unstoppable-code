import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { SpinnerTone } from './spinner-tone';

/**
 * Which drawing the shared spinners use. `dots` is the dot-grid family
 * (`ThinkingSpinner`, `LoadingSpinner`); `comet` draws every one of them as
 * the `CometSpinner` ring. Hosts choose it once at their root, so every
 * spinner in the app changes together. Desktop picks `comet` under early
 * access.
 */
export type SpinnerStyle = 'dots' | 'comet';

const SpinnerStyleContext = createContext<SpinnerStyle>('dots');

export function SpinnerStyleProvider({
  value,
  children,
}: {
  readonly value: SpinnerStyle;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SpinnerStyleContext.Provider value={value}>
      {children}
    </SpinnerStyleContext.Provider>
  );
}

export function useSpinnerStyle(): SpinnerStyle {
  return useContext(SpinnerStyleContext);
}

/**
 * The comet's ink for a dot spinner's tone. Activity reads in the primary
 * ink rather than the brand accent; every other tone keeps its meaning, and
 * `inherit` and `emphasis` still follow the control they sit in.
 */
export function cometTone(tone: SpinnerTone): SpinnerTone {
  return tone === 'accent' ? 'primary' : tone;
}
