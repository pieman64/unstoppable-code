import {
  deriveDesktopIpcCaller,
  type DesktopAppWindow,
  type DesktopIpcCallerOptions,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../desktop-ipc-caller';

function frame(url: string): DesktopIpcFrame {
  return { url, detached: false, isDestroyed: () => false };
}

function sender(id: number, url: string): DesktopIpcSender {
  const mainFrame = frame(url);
  return { id, mainFrame, getURL: () => url, isDestroyed: () => false };
}

const options: Pick<
  DesktopIpcCallerOptions,
  'getAppWindows' | 'packagedRendererUrls'
> = {
  getAppWindows: (): DesktopAppWindow[] => [],
  packagedRendererUrls: ['file:///app/out/renderer/index.html'],
};

describe('deriveDesktopIpcCaller for remote-control bridges', () => {
  it('accepts the live bridge main frame after renderer replacement', () => {
    const bridge = sender(7, 'data:text/html,bridge');
    bridge.mainFrame.detached = true;
    expect(
      deriveDesktopIpcCaller(
        { sender: bridge, senderFrame: bridge.mainFrame },
        {
          ...options,
          resolveRemoteBridgeSender: () => 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      ),
    ).toMatchObject({ principalId: 'remote-device:AAAAAAAAAAAAAAAAAAAAAA' });
  });

  it.each(['retired-frame', 'disposed', 'null', 'destroyed-sender'])(
    'rejects a bridge %s after renderer replacement',
    (scenario) => {
      const bridge = sender(7, 'data:text/html,bridge');
      bridge.mainFrame.detached = true;
      if (scenario === 'disposed')
        bridge.mainFrame.isDestroyed = (): boolean => true;
      if (scenario === 'destroyed-sender')
        bridge.isDestroyed = (): boolean => true;
      const senderFrame =
        scenario === 'null'
          ? null
          : scenario === 'retired-frame'
            ? { ...bridge.mainFrame }
            : bridge.mainFrame;
      expect(() =>
        deriveDesktopIpcCaller(
          { sender: bridge, senderFrame },
          {
            ...options,
            resolveRemoteBridgeSender: () => 'AAAAAAAAAAAAAAAAAAAAAA',
          },
        ),
      ).toThrow('Untrusted desktop IPC sender.');
    },
  );

  it('attributes a live bridge to its controller device', () => {
    const bridge = sender(7, 'data:text/html,bridge');
    const caller = deriveDesktopIpcCaller(
      { sender: bridge, senderFrame: bridge.mainFrame },
      {
        ...options,
        resolveRemoteBridgeSender: (candidate) =>
          candidate.id === 7 ? 'AAAAAAAAAAAAAAAAAAAAAA' : null,
      },
    );
    expect(caller).toMatchObject({
      principalId: 'remote-device:AAAAAAAAAAAAAAAAAAAAAA',
      clientInstanceId: 'remote-bridge:7',
      interfaceKind: 'desktop',
    });
    expect(caller.grants).toContain('core.chat.write');
  });

  it('still rejects untracked senders that are not bridges', () => {
    const stranger = sender(8, 'data:text/html,other');
    expect(() =>
      deriveDesktopIpcCaller(
        { sender: stranger, senderFrame: stranger.mainFrame },
        { ...options, resolveRemoteBridgeSender: () => null },
      ),
    ).toThrow('Untrusted desktop IPC sender.');
  });

  it('rejects a bridge subframe', () => {
    const bridge = sender(7, 'data:text/html,bridge');
    expect(() =>
      deriveDesktopIpcCaller(
        { sender: bridge, senderFrame: frame('data:text/html,child') },
        {
          ...options,
          resolveRemoteBridgeSender: () => 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      ),
    ).toThrow('Untrusted desktop IPC sender.');
  });
});
