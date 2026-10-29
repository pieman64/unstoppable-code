/** @jest-environment jsdom */
// CAN-3119 (F2): the pipeline `KeyValueEditor` opens `EnlargeValueModal` to
// edit a value at full size. The modal portals out of the editor's own blocked
// root and `DialogModal` records its card, so the value field and the key in
// its title record. This pins both inside the recorded card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { KeyValueEditor } from '../KeyValueEditor';
import { expectInRecordedDialogCard } from '@/test-utils/replay';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const SECRET_VALUE = 'sk-live-enlarged-secret';

describe('KeyValueEditor enlarge-value modal session replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('records the enlarged value field and its key inside the recorded DialogModal card', () => {
    act(() =>
      root.render(
        <KeyValueEditor
          value={{ API_TOKEN: SECRET_VALUE }}
          onChange={(): void => undefined}
        />,
      ),
    );

    const enlarge = container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit in expanded view"]',
    );
    if (enlarge === null) throw new Error('Enlarge control not rendered');
    act(() => enlarge.click());

    // The inline row keeps its own textarea; the modal's copy is portaled.
    const enlarged = Array.from(document.querySelectorAll('textarea')).filter(
      (field) => !container.contains(field),
    );
    expect(enlarged).toHaveLength(1);
    expect(enlarged[0].value).toBe(SECRET_VALUE);
    // The field is recorded; the recorder masks its value.
    expect(enlarged[0].closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    const card = expectInRecordedDialogCard(enlarged[0]);
    const heading = card.querySelector('h2');
    expect(heading?.textContent).toBe('API_TOKEN');
  });
});
