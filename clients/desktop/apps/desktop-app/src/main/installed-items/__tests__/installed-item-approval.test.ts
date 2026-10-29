import type { ApprovalSessionHandle } from '../../approvals/approval-service';
import { authorizeInstalledItemUninstall } from '../installed-item-approval';
const request = { target: { kind: 'collection', collectionId: 'id' } } as const;
function handle(decision: 'allow' | 'deny'): {
  approval: ApprovalSessionHandle;
  check: jest.Mock<Promise<{ decision: 'allow' | 'deny' }>, []>;
  dispose: jest.Mock<void, []>;
} {
  const check = jest.fn(() => Promise.resolve({ decision }));
  const dispose = jest.fn<void, []>();
  const approval: ApprovalSessionHandle = {
    check,
    setMode: jest.fn(),
    reevaluatePendingApprovals: () => Promise.resolve(),
    dispose,
    invalidatePending: jest.fn(),
  };
  return { approval, check, dispose };
}
test('missing and cancelled approval surfaces fail closed', async () => {
  expect(await authorizeInstalledItemUninstall(undefined, request)).toBe(false);
  const { approval, check } = handle('allow');
  const controller = new AbortController();
  controller.abort();
  expect(
    await authorizeInstalledItemUninstall(approval, request, {
      signal: controller.signal,
    }),
  ).toBe(false);
  expect(check).not.toHaveBeenCalled();
});
test.each(['allow', 'deny'] as const)(
  'uses the current session policy and honors %s without disposing it',
  async (decision) => {
    const { approval, check, dispose } = handle(decision);
    expect(await authorizeInstalledItemUninstall(approval, request)).toBe(
      decision === 'allow',
    );
    expect(check).toHaveBeenCalledWith(
      { kind: 'tool', toolName: 'installed_items.uninstall' },
      expect.anything(),
    );
    expect(dispose).not.toHaveBeenCalled();
  },
);
