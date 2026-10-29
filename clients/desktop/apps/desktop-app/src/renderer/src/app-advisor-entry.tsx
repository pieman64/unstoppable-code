/**
 * Entry module for the standalone App Advisor window (`app-advisor.html`). It
 * imports only {@link AppAdvisorWindowApp}, so this window never loads or
 * evaluates the main window's app.
 */
import { startRenderer } from './main';
import { AppAdvisorWindowApp } from './AppAdvisorWindowApp';

startRenderer('app-advisor', AppAdvisorWindowApp);
