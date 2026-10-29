import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';
import type { HostBridge } from '../host/bridge-window';
import type { MainWindowPushSource } from '../host/main-window-pushes';
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteVersion,
} from '../remote-protocol';

/** The version both computers run unless a test sets them apart. */
export const TEST_VERSION: RemoteVersion = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.0.0',
};

/** A bridge that echoes calls and records what it was sent. */
export class FakeBridge implements HostBridge {
  readonly window = null;
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  readonly posts: Array<{ channel: string; args: unknown[] }> = [];
  private readonly listeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();
  destroyed = false;
  chatInterest: ChatInterestDeclaration | undefined;
  handler: (channel: string, args: unknown[]) => Promise<unknown> = (
    channel,
    args,
  ) => Promise.resolve({ echoed: channel, args });

  invoke(channel: string, args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
    return this.handler(channel, args);
  }

  post(channel: string, args: unknown[]): void {
    this.posts.push({ channel, args });
  }

  getChatInterest(): ChatInterestDeclaration | undefined {
    return this.destroyed ? undefined : this.chatInterest;
  }

  onPush(
    listener: (channel: string, args: ReadonlyArray<unknown>) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(channel: string, args: unknown[]): void {
    for (const listener of Array.from(this.listeners)) listener(channel, args);
  }

  private readonly closedListeners = new Set<() => void>();

  onClosed(listener: () => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of Array.from(this.closedListeners)) listener();
  }
}

/** The main window's pushes, published by hand. */
export class FakeMainWindow implements MainWindowPushSource {
  private readonly listeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();

  subscribe(
    listener: (channel: string, args: ReadonlyArray<unknown>) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(channel: string, args: unknown[]): void {
    for (const listener of Array.from(this.listeners)) listener(channel, args);
  }
}
