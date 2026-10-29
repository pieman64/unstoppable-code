import type {
  ModelDefaultsByProvider,
  ProviderModelSelection,
} from '@canopy/desktop-shared/types';
import { resolveTryItRuntime, type TryItHarnessSupport } from '../tryItRuntime';

const claudeModel: ProviderModelSelection = {
  model: 'opus',
  thinkingLevel: 'high',
};
const codexModel: ProviderModelSelection = {
  model: 'gpt-5.5',
  thinkingLevel: 'medium',
};
const byProvider: ModelDefaultsByProvider = {
  claude: claudeModel,
  codex: codexModel,
  ollama: null,
  cursor: null,
};
const claudeDefault = {
  chatProvider: 'claude' as const,
  chatModelByProvider: byProvider,
};
const codexOnly: TryItHarnessSupport = {
  claude: false,
  codex: true,
  cursor: false,
};
const allSignedIn = { claude: true, codex: true, cursor: true };

describe('resolveTryItRuntime', () => {
  it('starts a Claude-unsupported capability on the signed-in Codex default', () => {
    expect(
      resolveTryItRuntime({
        support: codexOnly,
        defaults: claudeDefault,
        signedIn: { claude: true, codex: true, cursor: false },
      }),
    ).toEqual({ status: 'model', selection: codexModel });
  });

  it('keeps the default chat when the default harness is supported', () => {
    expect(
      resolveTryItRuntime({
        support: { claude: true, codex: false, cursor: false },
        defaults: claudeDefault,
        signedIn: { claude: null, codex: null, cursor: false },
      }),
    ).toEqual({ status: 'default' });
    expect(
      resolveTryItRuntime({
        support: codexOnly,
        defaults: { ...claudeDefault, chatProvider: 'codex' },
        signedIn: allSignedIn,
      }),
    ).toEqual({ status: 'default' });
  });

  it('keeps the default chat for an unrestricted capability without waiting', () => {
    expect(
      resolveTryItRuntime({
        support: undefined,
        defaults: null,
        signedIn: { claude: null, codex: null, cursor: false },
      }),
    ).toEqual({ status: 'default' });
    expect(
      resolveTryItRuntime({
        support: { claude: true, codex: true, cursor: true },
        defaults: null,
        signedIn: { claude: null, codex: null, cursor: false },
      }),
    ).toEqual({ status: 'default' });
  });

  it('waits for defaults and sign-in facts before switching harness', () => {
    expect(
      resolveTryItRuntime({
        support: codexOnly,
        defaults: null,
        signedIn: allSignedIn,
      }),
    ).toEqual({ status: 'loading' });
    expect(
      resolveTryItRuntime({
        support: codexOnly,
        defaults: claudeDefault,
        signedIn: { claude: true, codex: null, cursor: false },
      }),
    ).toEqual({ status: 'loading' });
  });

  it('pins the supported model before sign-in and reports a missing model', () => {
    expect(
      resolveTryItRuntime({
        support: codexOnly,
        defaults: claudeDefault,
        signedIn: { claude: true, codex: false, cursor: true },
      }),
    ).toEqual({ status: 'model', selection: codexModel });
    // Cursor without a default model cannot start the chat either.
    expect(
      resolveTryItRuntime({
        support: { claude: false, codex: false, cursor: true },
        defaults: claudeDefault,
        signedIn: allSignedIn,
      }),
    ).toEqual({ status: 'setup-required' });
  });

  it('moves an unmatched default provider to the first supported harness', () => {
    expect(
      resolveTryItRuntime({
        support: { claude: true, codex: true, cursor: false },
        defaults: { ...claudeDefault, chatProvider: 'cursor' },
        signedIn: allSignedIn,
      }),
    ).toEqual({ status: 'model', selection: claudeModel });
  });
});
