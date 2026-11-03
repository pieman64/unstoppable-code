import { createContext } from 'react';

/** The lab's Light / Dark switch, read by every stage for its theme. */
export type LabColorMode = 'light' | 'dark';

export const LabColorModeContext = createContext<LabColorMode>('light');
