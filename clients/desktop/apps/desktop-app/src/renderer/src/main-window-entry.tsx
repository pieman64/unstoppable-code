/**
 * Entry module for the main window (`index.html`). It imports only the main
 * app; the App Advisor window has its own page and entry
 * (`app-advisor-entry.tsx`).
 */
import { startRenderer } from './main';
import { MainWindowApp } from './MainWindowApp';

startRenderer('main', MainWindowApp);
