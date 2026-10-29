/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineInputDef } from '@canopy/desktop-shared/types/pipeline';
import { TriggerInputsEditor } from '../settings/TriggerInputsEditor';

function Harness(): JSX.Element {
  const [inputs, setInputs] = useState<Record<string, PipelineInputDef>>({
    payload: { type: 'json', default: { initial: true } },
  });

  return (
    <>
      <button
        type="button"
        data-testid="replace-json-default"
        onClick={() =>
          setInputs({
            payload: { type: 'json', default: { replaced: true } },
          })
        }
      >
        Replace JSON default
      </button>
      <button
        type="button"
        data-testid="switch-to-string"
        onClick={() =>
          setInputs({
            payload: { type: 'string', default: 'plain text' },
          })
        }
      >
        String
      </button>
      <button
        type="button"
        data-testid="switch-to-json"
        onClick={() =>
          setInputs({
            payload: { type: 'json', default: { fresh: true } },
          })
        }
      >
        JSON
      </button>
      <button
        type="button"
        data-testid="switch-to-json-string"
        onClick={() =>
          setInputs({
            payload: { type: 'json', default: '[1,2]' },
          })
        }
      >
        JSON string
      </button>
      <output data-testid="persisted-default">
        {JSON.stringify(inputs.payload?.default)}
      </output>
      <TriggerInputsEditor
        triggerType="dispatch"
        inputs={inputs}
        onChange={setInputs}
      />
    </>
  );
}

function getButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${testId}`);
  }
  return button;
}

function getJsonDefault(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector(
    '[data-testid="trigger-input-def-json-default-payload"]',
  );
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Missing JSON default textarea');
  }
  return textarea;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the textarea as its receiver
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TriggerInputsEditor JSON defaults', () => {
  it('preserves free-form drafts and resets them after the input type changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(<Harness />);
    });

    const textarea = getJsonDefault(container);
    expect(textarea.value).toBe('{\n  "initial": true\n}');

    setTextareaValue(textarea, '{ "draft": true }');
    expect(getJsonDefault(container)).toBe(textarea);
    expect(textarea.value).toBe('{ "draft": true }');

    act(() => {
      getButton(container, 'switch-to-string').click();
    });
    expect(
      container.querySelector(
        '[data-testid="trigger-input-def-json-default-payload"]',
      ),
    ).toBeNull();

    act(() => {
      getButton(container, 'switch-to-json').click();
    });
    expect(getJsonDefault(container).value).toBe('{\n  "fresh": true\n}');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('synchronizes an externally replaced default for the same input', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(<Harness />);
    });

    const textarea = getJsonDefault(container);
    setTextareaValue(textarea, '{oops');
    expect(textarea.value).toBe('{oops');

    act(() => {
      getButton(container, 'replace-json-default').click();
    });

    expect(getJsonDefault(container)).toBe(textarea);
    expect(textarea.value).toBe('{\n  "replaced": true\n}');
    expect(
      container.querySelector(
        '[data-testid="trigger-input-def-json-default-error-payload"]',
      ),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps malformed drafts local and persists only validated JSON values', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(<Harness />);
    });

    const textarea = getJsonDefault(container);
    setTextareaValue(textarea, '{oops');

    expect(textarea.value).toBe('{oops');
    expect(
      container.querySelector(
        '[data-testid="trigger-input-def-json-default-error-payload"]',
      )?.textContent,
    ).toBe('Enter valid JSON.');
    expect(
      container.querySelector('[data-testid="persisted-default"]')?.textContent,
    ).toBe('{"initial":true}');

    setTextareaValue(textarea, '{"valid":[1,2]}');
    expect(
      container.querySelector(
        '[data-testid="trigger-input-def-json-default-error-payload"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="persisted-default"]')?.textContent,
    ).toBe('{"valid":[1,2]}');

    act(() => {
      getButton(container, 'switch-to-string').click();
    });
    act(() => {
      getButton(container, 'switch-to-json-string').click();
    });
    expect(getJsonDefault(container).value).toBe('"[1,2]"');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
