import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * Which glyph family shared toolbars draw where both exist. `classic` keeps
 * the original barrel icons; `central` draws the Central set the rest of the
 * shell uses. Hosts choose it once at their root. Desktop picks `central`
 * under early access; hosts without a provider keep `classic`.
 */
export type IconStyle = 'classic' | 'central';

const IconStyleContext = createContext<IconStyle>('classic');

export function IconStyleProvider({
  value,
  children,
}: {
  readonly value: IconStyle;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <IconStyleContext.Provider value={value}>
      {children}
    </IconStyleContext.Provider>
  );
}

export function useIconStyle(): IconStyle {
  return useContext(IconStyleContext);
}
