/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InterruptedSessionRow } from '../InterruptedSessionRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('InterruptedSessionRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names and describes the leading checkbox without labelling the trailing control', () => {
    act(() => {
      root.render(
        <InterruptedSessionRow
          title="Fix sign-in"
          selection={{
            id: 'session-1',
            describedBy: 'session-1-metadata',
            checked: false,
            disabled: true,
            onChange: () => undefined,
          }}
          replayMaskTitle
          metadataId="session-1-metadata"
          metadataTestId="session-1-metadata"
          metadata="Codex · Weekly limit · Waiting for reset"
          secondaryMetadata="Chat"
          replayMaskSecondaryMetadata
          disabled
          trailing={<button type="button">Resume at reset</button>}
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>('#session-1');
    // The title line is the checkbox's label: clicking it toggles.
    const label = input?.closest('label');
    expect(label?.textContent).toBe('Fix sign-in');
    const title = label?.querySelector('.ph-mask');
    expect(title?.textContent).toBe('Fix sign-in');
    expect(title?.hasAttribute('title')).toBe(false);
    expect(title?.className).toContain('fg-secondary');
    const description = document.getElementById(
      input?.getAttribute('aria-describedby') ?? '',
    );
    expect(description?.textContent).toBe(
      'Codex · Weekly limit · Waiting for reset',
    );
    expect(description?.dataset.testid).toBe('session-1-metadata');
    const button = container.querySelector('button');
    expect(button?.closest('label')).toBeNull();
    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain('Chat');
    expect(
      Array.from(container.querySelectorAll('p')).find(
        (element) => element.textContent === 'Chat',
      )?.className,
    ).toContain('ph-mask');
  });

  it('renders a list item with a plain title and context line', () => {
    act(() => {
      root.render(
        <ul>
          <InterruptedSessionRow
            as="li"
            data-testid="resume-queue-entry-1"
            title="Release"
            context="Workspace A"
            metadataTestId="resume-queue-entry-identity"
            metadata="Pipeline · Claude"
          >
            <p>Needs attention</p>
          </InterruptedSessionRow>
        </ul>,
      );
    });
    const item = container.querySelector('li');
    expect(item?.dataset.testid).toBe('resume-queue-entry-1');
    expect(container.querySelector('label')).toBeNull();
    expect(item?.querySelector('p[title="Release"]')?.textContent).toBe(
      'Release',
    );
    expect(
      item?.querySelector('[data-testid="resume-queue-entry-identity"]')
        ?.textContent,
    ).toBe('Pipeline · Claude');
    expect(item?.textContent).toContain('Workspace A');
    expect(item?.textContent).toContain('Needs attention');
  });
});
