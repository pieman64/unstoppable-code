import { isCodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import {
  clearCodexAccountModels,
  initCodexModels,
  setCodexAccountModels,
} from '@canopy/desktop-shared/types';

const mockPeek = jest.fn<ReadonlySet<string> | null, []>();
const mockReadCatalog = jest.fn<Promise<unknown>, []>();
jest.mock('../codex-account-models', () => ({
  peekCodexAccountModelIds: (): ReadonlySet<string> | null => mockPeek(),
  readCodexSpeedCatalog: (): Promise<unknown> => mockReadCatalog(),
}));
const mockBlocked = jest.fn<boolean, [string | undefined]>(() => false);
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByCurrentPolicy: (model: string | undefined): boolean =>
    mockBlocked(model),
}));
jest.mock('../../lib/model-gateway-state', () => ({
  isModelExcludedByCurrentGatewayRequirement: (): boolean => false,
}));

import { resolveCodexAccountModelAccessFailure } from '../codex-account-model-fallback';

const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6-luna';
const rejection = `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`;

describe('resolveCodexAccountModelAccessFailure (CAN-4716)', () => {
  beforeEach(() => {
    initCodexModels([
      { id: SOL, label: '6.1 Sol' },
      { id: LUNA, label: 'Luna 6.0' },
    ]);
    clearCodexAccountModels();
    mockPeek.mockReset();
    mockReadCatalog.mockReset().mockResolvedValue({ status: 'unknown' });
    mockBlocked.mockReturnValue(false);
  });

  it('offers the first eligible, allowed model that is not the refused one', async () => {
    mockPeek.mockReturnValue(new Set([SOL, LUNA]));
    await expect(
      resolveCodexAccountModelAccessFailure({
        error: rejection,
        codexErrorInfo: 'badRequest',
        owner: undefined,
        turnModel: SOL,
      }),
    ).resolves.toEqual({
      kind: 'model_unsupported',
      model: SOL,
      modelLabel: '6.1 Sol',
      fallbackModel: LUNA,
      fallbackModelLabel: 'Luna 6.0',
    });
    expect(mockReadCatalog).not.toHaveBeenCalled();
  });

  it("falls back to the account's own model when no catalog model is eligible", async () => {
    setCodexAccountModels([
      { id: 'free-6', model: 'free-6', displayName: 'Free 6' },
    ]);
    mockPeek.mockReturnValue(new Set([SOL, 'free-6']));
    await expect(
      resolveCodexAccountModelAccessFailure({
        error: rejection,
        owner: undefined,
      }),
    ).resolves.toMatchObject({
      fallbackModel: 'free-6',
      fallbackModelLabel: 'Free 6',
    });
  });

  it('keeps a long account model label within the carrier bounds', async () => {
    const longLabel = 'Free '.repeat(60);
    setCodexAccountModels([
      { id: 'free-6', model: 'free-6', displayName: longLabel },
    ]);
    mockPeek.mockReturnValue(new Set([SOL, 'free-6']));
    const failure = await resolveCodexAccountModelAccessFailure({
      error: rejection,
      owner: undefined,
    });

    expect(isCodexAccountModelAccessFailure(failure)).toBe(true);
    expect(failure?.fallbackModel).toBe('free-6');
    expect(failure?.fallbackModelLabel?.startsWith('Free Free')).toBe(true);
  });

  it('omits the fallback when the refused model is the only eligible one, or policy blocks the rest', async () => {
    mockPeek.mockReturnValue(new Set([SOL]));
    const only = await resolveCodexAccountModelAccessFailure({
      error: rejection,
      owner: undefined,
    });
    expect(only).not.toHaveProperty('fallbackModel');

    mockPeek.mockReturnValue(new Set([SOL, LUNA]));
    mockBlocked.mockImplementation((model) => model === LUNA);
    const blocked = await resolveCodexAccountModelAccessFailure({
      error: rejection,
      owner: undefined,
    });
    expect(blocked).not.toHaveProperty('fallbackModel');
  });

  it('reads the catalog once on a cold cache and omits the fallback while still unknown', async () => {
    mockPeek.mockReturnValue(null);
    const unknown = await resolveCodexAccountModelAccessFailure({
      error: rejection,
      owner: undefined,
    });
    expect(mockReadCatalog).toHaveBeenCalledTimes(1);
    expect(unknown).toEqual({
      kind: 'model_unsupported',
      model: SOL,
      modelLabel: '6.1 Sol',
    });

    mockPeek.mockReturnValueOnce(null).mockReturnValueOnce(new Set([LUNA]));
    await expect(
      resolveCodexAccountModelAccessFailure({
        error: rejection,
        owner: undefined,
      }),
    ).resolves.toMatchObject({ fallbackModel: LUNA });
  });

  it('returns null for other failures without reading anything', async () => {
    await expect(
      resolveCodexAccountModelAccessFailure({
        error: 'Codex turn failed',
        owner: undefined,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveCodexAccountModelAccessFailure({
        error: rejection,
        codexErrorInfo: 'unauthorized',
        owner: undefined,
      }),
    ).resolves.toBeNull();
    expect(mockPeek).not.toHaveBeenCalled();
    expect(mockReadCatalog).not.toHaveBeenCalled();
  });
});
