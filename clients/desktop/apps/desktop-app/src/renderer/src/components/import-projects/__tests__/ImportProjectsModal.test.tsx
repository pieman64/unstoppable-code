/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const panelProps: Record<string, unknown>[] = [];
jest.mock('../ImportProjectsPanel', () => ({
  ImportProjectsPanel: (props: Record<string, unknown>): null => {
    panelProps.push(props);
    return null;
  },
}));

import { ImportProjectsModal } from '../ImportProjectsModal';

describe('ImportProjectsModal', () => {
  it('passes the opening entry to the panel for import telemetry (CAN-4635)', () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ImportProjectsModal
          target={{ source: 'app-advisor' }}
          onClose={jest.fn()}
        />,
      );
    });
    expect(panelProps.at(-1)).toMatchObject({ modalEntry: 'app-advisor' });
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
