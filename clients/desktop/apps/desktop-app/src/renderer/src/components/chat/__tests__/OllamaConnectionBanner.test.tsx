/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OllamaConnectionBanner } from '../OllamaConnectionBanner';
import { useNavigationStore } from '@/stores/navigationStore';
import { useOllamaConnectionBannerStore } from '@/stores/ollamaConnectionBannerStore';

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

describe('OllamaConnectionBanner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialOpenSettings = useNavigationStore.getState().openSettings;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useOllamaConnectionBannerStore.setState({ unavailableByChat: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useNavigationStore.setState({ openSettings: initialOpenSettings });
  });

  // Not dismissible on purpose: the server being unreachable blocks every
  // send, so the notice stays until the next attempt can reach it.
  it('shows recovery copy and opens the Ollama settings section', () => {
    const openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    useOllamaConnectionBannerStore.getState().showUnavailable(TARGET);

    act(() => root.render(<OllamaConnectionBanner target={TARGET} />));

    expect(container.textContent).toContain('Ollama server not reachable');
    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected the Ollama settings button');
    }
    act(() => button.click());
    expect(openSettings).toHaveBeenCalledWith('ollama');
  });

  it('renders nothing when the target has no warning', () => {
    act(() => root.render(<OllamaConnectionBanner target={TARGET} />));
    expect(container.innerHTML).toBe('');
  });
});
