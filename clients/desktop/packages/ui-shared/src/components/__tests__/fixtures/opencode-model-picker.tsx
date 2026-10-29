import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelCatalog } from '@canopy/protocol/models';
import { ModelPickerMenu } from '@canopy/ui-shared/components';

// A deterministic host for the shared contract, before connection/execution
// activation in later stack slices. No provider, auth or network is simulated.
const catalog: ModelCatalog = [
  {
    id: 'claude-fixture',
    label: 'Claude fixture',
    provider: 'claude',
    source: 'claude',
    harness: 'claude',
    vendor: 'anthropic',
    kind: 'model',
    available: true,
  },
  {
    id: 'opencode:fixture/ready',
    label: 'OpenCode fixture',
    provider: 'opencode',
    source: 'opencode',
    harness: 'opencode',
    vendor: 'anthropic',
    kind: 'model',
    available: true,
  },
  {
    id: 'opencode:fixture/unavailable',
    label: 'Unavailable fixture',
    provider: 'opencode',
    source: 'opencode',
    harness: 'opencode',
    vendor: 'anthropic',
    kind: 'model',
    available: false,
  },
];

function Fixture(): React.JSX.Element {
  const [selected, setSelected] = useState('claude-fixture');
  const [includeOpenCode, setIncludeOpenCode] = useState(true);
  return (
    <main
      data-testid="opencode-picker-fixture"
      className="bg-base fg-primary p-6"
      style={{ width: 800, minHeight: 620 }}
    >
      <h1 className="text-l mb-4">Model selection</h1>
      <ModelPickerMenu
        catalog={
          includeOpenCode
            ? catalog
            : catalog.filter((model) => model.provider !== 'opencode')
        }
        currentModel={selected}
        onSelect={(id) => {
          setSelected(id);
        }}
        getOptionState={(model) => ({
          disabled: !model.available,
          unavailableReason: model.available
            ? undefined
            : 'This model is unavailable.',
        })}
        harnessTabs={{
          brandIcon: null,
          brandLabel: 'AI Credits',
          allModelsTab: true,
          favoritesStorageKey: 'can-3692:picker',
        }}
      />
      <output data-testid="selected-model" className="block mt-4">
        {selected}
      </output>
      <button
        className="mt-4"
        data-testid="remove-opencode"
        onClick={() => setIncludeOpenCode(false)}
      >
        Remove OpenCode catalog
      </button>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing model-picker fixture root');
createRoot(root).render(<Fixture />);
