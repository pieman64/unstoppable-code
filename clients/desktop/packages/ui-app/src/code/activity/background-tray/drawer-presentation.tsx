'use client';
import { createContext } from 'react';
/** The legacy standalone tray keeps its established host behavior. */
export const DrawerRowPresentationContext = createContext<
  'legacy' | 'drawer' | 'modal'
>('legacy');
