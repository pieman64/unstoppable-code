/**
 * A `PageModelHost` fed a recording: its registry learns the recorded
 * frames through the CDP events BrowserService forwards, and its requests
 * are answered from the recording unless `extra` answers them first.
 */
import { PageModelHost } from '../../page-model-host';
import { recordedSend, type Recording } from './recorded-cdp';

export interface SentRequest {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

export type ExtraAnswer = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
) => Promise<unknown> | undefined;

export function recordedHost(
  recording: Recording,
  extra: ExtraAnswer = () => undefined,
): { host: PageModelHost; sent: SentRequest[] } {
  const replay = recordedSend(recording);
  const sent: SentRequest[] = [];
  const host = new PageModelHost({
    now: Date.now,
    send: (method, params, sessionId = ''): Promise<unknown> => {
      sent.push({ method, params, sessionId });
      return (
        extra(method, params, sessionId) ?? replay(method, params, sessionId)
      );
    },
  });
  for (const frame of recording.frames) {
    if (frame.sessionId === '') continue;
    host.noteEvent(
      'Target.attachedToTarget',
      {
        sessionId: frame.sessionId,
        targetInfo: { targetId: frame.frameId, type: 'iframe', url: frame.url },
      },
      '',
    );
  }
  const ordered = [...recording.frames].sort(
    (first, second) =>
      Number(first.parentId !== undefined) -
      Number(second.parentId !== undefined),
  );
  for (const frame of ordered) {
    host.noteEvent(
      'Page.frameNavigated',
      {
        frame: {
          id: frame.frameId,
          loaderId: frame.loaderId,
          url: frame.url,
          ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
        },
      },
      frame.sessionId,
    );
  }
  return { host, sent };
}
