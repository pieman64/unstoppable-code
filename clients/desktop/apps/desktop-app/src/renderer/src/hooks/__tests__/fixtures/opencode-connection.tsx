import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useOpenCodeChatAvailable } from '../../useOpenCodeChatAvailable';
import { useFeatureFlagsStore } from '../../../stores/featureFlagsStore';

// Keep the real availability subscriber mounted while the real preload/main
// connection changes. The buttons are only a deterministic driver for that API.
function Fixture(): React.JSX.Element {
  const available = useOpenCodeChatAvailable(true);
  const [result, setResult] = useState('idle');
  const run = async (operation: 'connect' | 'disconnect'): Promise<void> => {
    setResult('pending');
    try {
      const api = window.api.opencodeConnection;
      if (!api) throw new Error('Connection API missing');
      await api[operation]();
      setResult(operation);
    } catch (error) {
      setResult(String(error));
    }
  };
  return (
    <main>
      <output data-testid="availability">
        {available ? 'available' : 'unavailable'}
      </output>
      <output data-testid="operation">{result}</output>
      <button
        data-testid="connect"
        onClick={() => {
          void run('connect');
        }}
      >
        Connect
      </button>
      <button
        data-testid="disconnect"
        onClick={() => {
          void run('disconnect');
        }}
      >
        Disconnect
      </button>
    </main>
  );
}
void useFeatureFlagsStore
  .getState()
  .hydrate()
  .then(() => {
    const root = document.getElementById('root');
    if (root) createRoot(root).render(<Fixture />);
  });
