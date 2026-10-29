import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { RemoteAppAdvisorSurface } from '../host/app-advisor-surface';
import type {
  AppAdvisorWindowParams,
  AppAdvisorWindowStateParams,
} from '../remote-protocol';
import { FakeBridge } from './host-fakes';

function createSurface(): {
  surface: RemoteAppAdvisorSurface;
  log: string[];
} {
  const log: string[] = [];
  const surface = new RemoteAppAdvisorSurface({
    controllerDeviceId: 'controller-1',
    bridgeFor: (): Promise<FakeBridge> => Promise.resolve(new FakeBridge()),
    bridgeWindow: (): null => null,
    requestWindow: (
      params: AppAdvisorWindowParams,
    ): Promise<AppAdvisorWindowStateParams> => {
      log.push(`window:${params.action}`);
      return Promise.resolve({
        open: params.action === 'open',
        focused: false,
      });
    },
    sendRequestCommands: (request, send): Promise<void> => {
      if (request?.chatId)
        send({ type: 'select_chat', chatId: request.chatId });
      return Promise.resolve();
    },
    sendToWindow: (_window, channel, payload): void => {
      if (
        channel === IPC_CHANNELS.appAdvisorWindowCommand &&
        typeof payload === 'object' &&
        payload !== null &&
        'type' in payload
      ) {
        log.push(`command:${String(payload.type)}`);
      }
    },
    redeliverQuestions: (): void => undefined,
  });
  return { surface, log };
}

describe('RemoteAppAdvisorSurface', () => {
  it('has the controller create its window before sending it commands', async () => {
    const { surface, log } = createSurface();
    await surface.openAppAdvisorWindow({ chatId: 'chat-1', focus: true });
    expect(log).toEqual([
      'window:ensure',
      'command:select_chat',
      'window:open',
    ]);
  });

  it('creates the window before commands when only ensuring it', async () => {
    const { surface, log } = createSurface();
    await surface.ensureAppAdvisorWindow({ chatId: 'chat-1' });
    expect(log).toEqual(['window:ensure', 'command:select_chat']);
  });

  it('routes by the controller, which stays the same across reconnects', () => {
    expect(createSurface().surface.routeKey).toBe('controller-1');
  });
});
