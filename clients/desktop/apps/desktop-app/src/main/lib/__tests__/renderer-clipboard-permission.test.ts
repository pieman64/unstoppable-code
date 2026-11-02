import { allowsRendererClipboardWrite } from '../renderer-clipboard-permission';

const page = 'file:///app/renderer/index.html';
const sender = {
  isDestroyed: (): boolean => false,
  getURL: (): string => page,
};
const details = { isMainFrame: true, requestingUrl: page };
it('allows only explicitly trusted top-level panel auxiliary documents', () => {
  const auxiliary = { ...sender, getURL: (): string => 'about:blank' };
  const auxiliaryDetails = { ...details, requestingUrl: 'about:blank' };
  const decide = (trusted: boolean, request = auxiliaryDetails): boolean =>
    Reflect.apply(allowsRendererClipboardWrite, undefined, [
      auxiliary,
      request,
      [page],
      undefined,
      trusted,
    ]);
  expect(decide(true)).toBe(true);
  expect(decide(false)).toBe(false);
  expect(decide(true, { ...auxiliaryDetails, isMainFrame: false })).toBe(false);
  expect(decide(true, details)).toBe(false);
});

it('allows writes only from the current top-level trusted app page', () => {
  expect(allowsRendererClipboardWrite(sender, details, [page])).toBe(true);
  expect(
    allowsRendererClipboardWrite(sender, { ...details, isMainFrame: false }, [
      page,
    ]),
  ).toBe(false);
  expect(
    allowsRendererClipboardWrite(
      sender,
      { ...details, requestingUrl: 'https://example.com' },
      [page],
    ),
  ).toBe(false);
  expect(
    allowsRendererClipboardWrite(sender, details, ['file:///other/index.html']),
  ).toBe(false);
  expect(
    allowsRendererClipboardWrite(
      { ...sender, isDestroyed: () => true },
      details,
      [page],
    ),
  ).toBe(false);
});
it('supports query-bearing detached documents on both renderer origins', () => {
  for (const url of [
    'file:///app/renderer/index.html',
    'canopy-renderer://app/index.html',
    'http://localhost:5173/index.html',
  ]) {
    const current = `${url}?panel=file`;
    expect(
      allowsRendererClipboardWrite(
        { ...sender, getURL: () => current },
        { ...details, requestingUrl: current },
        [url],
      ),
    ).toBe(true);
  }
});

it('admits the exact configured development entry URL while refusing other pages on that origin', () => {
  const devUrl = 'http://localhost:5173/';
  const currentSender = {
    isDestroyed: (): boolean => false,
    getURL: (): string => devUrl,
  };
  // Reflect also exercises the older policy, which ignored the new configuration argument.
  expect(
    Reflect.apply(allowsRendererClipboardWrite, undefined, [
      currentSender,
      { isMainFrame: true, requestingUrl: devUrl },
      [page],
      devUrl,
    ]),
  ).toBe(true);
  const foreign = 'http://localhost:5173/foreign.html';
  expect(
    Reflect.apply(allowsRendererClipboardWrite, undefined, [
      { ...currentSender, getURL: (): string => foreign },
      { isMainFrame: true, requestingUrl: foreign },
      [page],
      devUrl,
    ]),
  ).toBe(false);
});
