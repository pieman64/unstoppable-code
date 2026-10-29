/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCopilotModels } from '../useCopilotModels';

jest.mock('@/stores/modelCatalogStore', () => ({
  useModelCatalogStore: (
    selector: (state: { snapshot: { copilot: never[] } }) => unknown,
  ): unknown => selector({ snapshot: { copilot: [] } }),
}));

const listModels = jest.fn<Promise<never[]>, []>();

function Probe(): JSX.Element {
  const { message } = useCopilotModels(true, true);
  return <span data-testid="probe">{message ?? ''}</span>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let originalApi: PropertyDescriptor | undefined;

async function mountProbe(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(<Probe />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container.querySelector('[data-testid="probe"]')?.textContent ?? '';
}

beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { copilotConnection: { listModels } },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  listModels.mockReset();
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});

const POLICY =
  "An organization policy blocks Copilot CLI for this GitHub account. Ask an organization owner to enable Copilot CLI in the organization's Copilot policies, then connect again.";
const EXPIRED = 'Copilot sign-in expired. Reconnect Copilot in Settings.';

test('shows the organization policy refusal the main process named', async () => {
  listModels.mockRejectedValue(
    new Error(
      `Error invoking remote method 'copilot-connection:models': CopilotPolicyError: ${POLICY}`,
    ),
  );
  expect(await mountProbe()).toBe(POLICY);
});

test('shows an expired sign-in the main process named', async () => {
  listModels.mockRejectedValue(
    new Error(
      `Error invoking remote method 'copilot-connection:models': CopilotSignInExpiredError: ${EXPIRED}`,
    ),
  );
  expect(await mountProbe()).toBe(EXPIRED);
});

test('keeps a retry message for any other failure', async () => {
  listModels.mockRejectedValue(
    new Error(
      "Error invoking remote method 'copilot-connection:models': Error: Request models.list failed with message: socket hang up",
    ),
  );
  expect(await mountProbe()).toBe(
    "Couldn't load Copilot models. Reopen this menu to retry.",
  );
});
