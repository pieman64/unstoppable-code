/** @jest-environment jsdom */
import { appendTryItStarter } from '../tryItStage';
import {
  readTryItDraft,
  saveTryItDraft,
  clearTryItDraft,
} from '../tryItDraftStorage';

beforeAll(() =>
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  }),
);

beforeEach(() => localStorage.clear());

it('retains rich edited content and insertion identity through a reload', () => {
  const initial = appendTryItStarter(
    [{ type: 'paragraph', children: [{ text: 'Existing' }] }],
    'Line one\nLine two',
  );
  saveTryItDraft('chat', initial, 'capability');
  const edited = appendTryItStarter(initial, 'My incident details');
  saveTryItDraft('chat', edited);
  expect(readTryItDraft('chat')).toEqual({
    content: edited,
    stagingIds: ['capability'],
  });
  expect(readTryItDraft('other')).toBeNull();
});

it('clearing or sending permits a later explicit Try it to stage again', () => {
  saveTryItDraft('chat', appendTryItStarter([], 'Starter'), 'capability');
  saveTryItDraft('chat', [{ type: 'paragraph', children: [{ text: '' }] }]);
  expect(readTryItDraft('chat')?.stagingIds).toEqual([]);
  clearTryItDraft('chat');
  expect(readTryItDraft('chat')).toBeNull();
});

it('does not mark an insertion accepted if storage refuses its content', () => {
  const write = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota');
    });
  expect(() =>
    saveTryItDraft('chat', appendTryItStarter([], 'Starter'), 'capability'),
  ).toThrow('quota');
  write.mockRestore();
  expect(readTryItDraft('chat')).toBeNull();
});
