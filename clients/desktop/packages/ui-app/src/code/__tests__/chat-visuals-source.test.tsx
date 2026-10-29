/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalChatMessage } from '@canopy/protocol';
import type { ChatVisualHost, ChatVisualOwner } from '../chat-visual-host';
import {
  collectChatVisualOwners,
  publishChatVisuals,
  requestChatVisualReveal,
  resetChatVisualsSourcesForTests,
  useChatVisualReveal,
  useChatVisualsPublisher,
  useChatVisualsSource,
} from '../chat-visuals-source';

function reference(title: string): ChatVisualOwner['reference'] {
  return {
    version: 1,
    visualId: 'vis_00000000-0000-4000-8000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    byteLength: 1,
    mediaType: 'text/html',
    title,
    maxHeight: 400,
  };
}

function owner(toolUseId: string): ChatVisualOwner {
  return {
    messageId: `message-${toolUseId}`,
    toolUseId,
    reference: reference(toolUseId),
  };
}

const host: ChatVisualHost = {
  read: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  openLink: (): void => {},
};

let container: HTMLDivElement;
let root: Root;
let renders = 0;

function Probe({ sourceKey }: { sourceKey: string }): JSX.Element {
  renders += 1;
  const source = useChatVisualsSource(sourceKey);
  const reveal = useChatVisualReveal(sourceKey);
  return (
    <output>
      {source ? source.owners.map((item) => item.toolUseId).join(',') : 'none'}
      {reveal ? `|${reveal.toolUseId}#${reveal.request}` : ''}
    </output>
  );
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  resetChatVisualsSourcesForTests();
  renders = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('delivers a published source to the panel reading the same key only', () => {
  act(() => root.render(<Probe sourceKey="chat-a" />));
  expect(container.textContent).toBe('none');
  act(() => publishChatVisuals('chat-b', { owners: [owner('x')], host }));
  expect(container.textContent).toBe('none');
  act(() =>
    publishChatVisuals('chat-a', {
      owners: [owner('one'), owner('two')],
      host,
    }),
  );
  expect(container.textContent).toBe('one,two');
});

it('keeps the earlier snapshot when an equal list is published again', () => {
  act(() => root.render(<Probe sourceKey="chat-a" />));
  act(() => publishChatVisuals('chat-a', { owners: [owner('one')], host }));
  const settled = renders;
  // A host that rebuilds its owners on every render publishes equal objects.
  act(() => publishChatVisuals('chat-a', { owners: [owner('one')], host }));
  expect(renders).toBe(settled);
  act(() => publishChatVisuals('chat-a', { owners: [owner('two')], host }));
  expect(container.textContent).toBe('two');
});

it('treats a repeated reveal of the same visual as a new request', () => {
  act(() => root.render(<Probe sourceKey="chat-a" />));
  act(() => requestChatVisualReveal('chat-a', 'one'));
  expect(container.textContent).toBe('none|one#1');
  act(() => requestChatVisualReveal('chat-a', 'one'));
  expect(container.textContent).toBe('none|one#2');
});

it('keeps a source after its publisher unmounts', () => {
  function Publisher(): null {
    useChatVisualsPublisher('chat-a', owners, host);
    return null;
  }
  const owners = [owner('one')];
  act(() => root.render(<Publisher />));
  act(() => root.render(<Probe sourceKey="chat-a" />));
  expect(container.textContent).toBe('one');
});

it('publishes nothing without a key or a host', () => {
  function Publisher({
    sourceKey,
    visualHost,
  }: {
    sourceKey: string | null;
    visualHost: ChatVisualHost | null;
  }): null {
    useChatVisualsPublisher(sourceKey, owners, visualHost);
    return null;
  }
  const owners = [owner('one')];
  act(() => root.render(<Publisher sourceKey={null} visualHost={host} />));
  act(() => root.render(<Publisher sourceKey="chat-a" visualHost={null} />));
  act(() => root.render(<Probe sourceKey="chat-a" />));
  expect(container.textContent).toBe('none');
});

describe('collectChatVisualOwners', () => {
  function message(
    messageId: string,
    parts: PortalChatMessage['parts'],
  ): PortalChatMessage {
    return {
      messageId,
      role: 'assistant',
      text: '',
      createdAtMs: 0,
      parts,
    };
  }

  it('lists each visual once, in transcript order', () => {
    const first = reference('First');
    const second = reference('Second');
    const messages = [
      message('m1', [{ kind: 'text', data: { text: 'hello' } }]),
      message('m2', [
        {
          kind: 'tool_result',
          data: { toolUseId: 't1', messageId: 'owner-1', visual: first },
        },
      ]),
      message('m3', [
        { kind: 'tool_result', data: { toolUseId: 't2', output: 'no visual' } },
        { kind: 'tool_result', data: { toolUseId: 't3', visual: second } },
        // The same call projected twice must not list its visual twice.
        { kind: 'tool_result', data: { toolUseId: 't3', visual: second } },
      ]),
    ];
    expect(collectChatVisualOwners(messages)).toEqual([
      { messageId: 'owner-1', toolUseId: 't1', reference: first },
      { messageId: 'm3', toolUseId: 't3', reference: second },
    ]);
  });

  it('returns nothing for messages with no parts', () => {
    expect(collectChatVisualOwners([message('m1', undefined)])).toEqual([]);
  });
});
