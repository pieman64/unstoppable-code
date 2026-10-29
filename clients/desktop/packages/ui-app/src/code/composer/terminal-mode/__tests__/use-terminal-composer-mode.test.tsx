/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  isTerminalDraft,
  terminalDraftCommand,
  TERMINAL_SEND_FAILED_MESSAGE,
  TerminalComposerBlockedError,
  useTerminalComposerMode,
  type TerminalComposerMode,
  type UseTerminalComposerModeOptions,
} from '..';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('terminal draft parsing', () => {
  it('enters terminal mode on a leading !, ignoring leading whitespace', () => {
    expect(isTerminalDraft('!ls')).toBe(true);
    expect(isTerminalDraft('  \n !ls')).toBe(true);
    expect(isTerminalDraft('ls !')).toBe(false);
  });

  it('sends only the first line of a raw command, trimmed', () => {
    expect(terminalDraftCommand('! pnpm dev  \nsecond line')).toBe('pnpm dev');
    expect(terminalDraftCommand('!\nls -la')).toBe('ls -la');
    expect(terminalDraftCommand('hello')).toBe('');
  });
});

describe('useTerminalComposerMode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: TerminalComposerMode;

  function Probe(props: UseTerminalComposerModeOptions): JSX.Element | null {
    latest = useTerminalComposerMode(props);
    return null;
  }

  function render(props: UseTerminalComposerModeOptions): void {
    act(() => root.render(<Probe {...props} />));
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('stays inactive while disabled, so `!` is ordinary text', () => {
    render({
      draftText: '!ls',
      enabled: false,
      runInTerminal: jest.fn(),
      onSent: jest.fn(),
    });
    expect(latest.active).toBe(false);
    expect(latest.command).toBe('');
  });

  it('clears the draft only after a successful write', async () => {
    const runInTerminal = jest.fn(() => Promise.resolve());
    const onSent = jest.fn();
    render({
      draftText: '!ls -la\nignored',
      enabled: true,
      runInTerminal,
      onSent,
    });
    expect(latest.active).toBe(true);
    let sent = false;
    await act(async () => {
      sent = await latest.send();
    });
    expect(sent).toBe(true);
    expect(runInTerminal).toHaveBeenCalledTimes(1);
    expect(runInTerminal).toHaveBeenCalledWith('ls -la');
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(latest.error).toBeNull();
  });

  it('keeps the draft and shows the error on failure, without retrying', async () => {
    const runInTerminal = jest.fn(() => Promise.reject(new Error('spawn')));
    const onSent = jest.fn();
    const props = { draftText: '!ls', enabled: true, runInTerminal, onSent };
    render(props);
    await act(async () => {
      await latest.send();
    });
    expect(runInTerminal).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
    expect(latest.error).toBe(TERMINAL_SEND_FAILED_MESSAGE);
    // Editing the draft clears the failure.
    render({ ...props, draftText: '!ls -la' });
    expect(latest.error).toBeNull();
  });

  it('shows a blocked run in the label place with its own reason', async () => {
    const runInTerminal = jest.fn(() =>
      Promise.reject(new TerminalComposerBlockedError('Script changed')),
    );
    render({
      draftText: '!dev',
      enabled: true,
      runInTerminal,
      onSent: jest.fn(),
    });
    await act(async () => {
      await latest.send();
    });
    expect(latest.error).toBe('Script changed');
  });

  it('sends one command for a repeated Enter while the first is in flight', async () => {
    let finish: () => void = () => undefined;
    const runInTerminal = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onSent = jest.fn();
    render({ draftText: '!dev', enabled: true, runInTerminal, onSent });
    let first: Promise<boolean> = Promise.resolve(false);
    let second = true;
    await act(async () => {
      first = latest.send();
      second = await latest.send();
    });
    expect(second).toBe(false);
    await act(async () => {
      finish();
      await first;
    });
    expect(runInTerminal).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
