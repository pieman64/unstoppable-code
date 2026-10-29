/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { McpClientSetupDetails } from '../McpClientSetupDetails';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('McpClientSetupDetails', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(): void {
    act(() => {
      root.render(
        <McpClientSetupDetails
          serverName="Acme Internal"
          redirectUri="https://acme.example/oauth/callback"
          docsUrl="https://acme.example/docs"
          clientSecretRequired={false}
          clientSecretAccepted
        />,
      );
    });
  }

  it('names the server inside the explanation', () => {
    render();
    const intro = container.querySelector(
      '[data-testid="mcp-client-setup-intro"]',
    );
    expect(intro?.textContent).toBe(
      'Acme Internal doesn’t let apps register themselves. Create an app in Acme Internal’s developer dashboard with this redirect URI, then paste its client ID.',
    );
  });

  it('names the server in the docs link', () => {
    render();
    const docs = container.querySelector(
      '[data-testid="mcp-client-setup-docs"]',
    );
    expect(docs?.textContent).toBe('Acme Internal docs');
  });
});
