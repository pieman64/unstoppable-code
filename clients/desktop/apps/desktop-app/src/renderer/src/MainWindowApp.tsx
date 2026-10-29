import type { JSX } from 'react';
import { AgentSentSenderOpenerProvider } from '@canopy/ui-shared';
import App from './App';
import { DesktopResourceContextProvider } from './components/DesktopResourceContextProvider';
import { RemoteAccessConnectionNotice } from './components/remote-access/RemoteAccessConnectionNotice';
import { mainWindowSenderOpener } from './lib/agent-sent-sender-opener';

/**
 * The main window's root. The remote connection notice sits beside App, not
 * inside it: in a window that shows another computer, App's startup screens
 * wait on preferences that load over that connection, so a notice inside App
 * could never appear while the connection is down.
 */
export function MainWindowApp(): JSX.Element {
  return (
    <DesktopResourceContextProvider>
      <AgentSentSenderOpenerProvider opener={mainWindowSenderOpener}>
        <App />
      </AgentSentSenderOpenerProvider>
      <RemoteAccessConnectionNotice />
    </DesktopResourceContextProvider>
  );
}
