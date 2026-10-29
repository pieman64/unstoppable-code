import { LocalSelectionTransfer, TransferIdentifier } from '../transfer';

interface DraggedPanel {
  readonly panelId: string;
}

interface DraggedGroup {
  readonly groupId: number;
}

describe('LocalSelectionTransfer', () => {
  const panelIdentifier = new TransferIdentifier<DraggedPanel>('panel');
  const groupIdentifier = new TransferIdentifier<DraggedGroup>('group');

  afterEach(() => {
    const transfer = LocalSelectionTransfer.getInstance();
    transfer.clearData(panelIdentifier);
    transfer.clearData(groupIdentifier);
  });

  it('is a singleton: two getInstance calls share state', () => {
    const first = LocalSelectionTransfer.getInstance();
    const second = LocalSelectionTransfer.getInstance();
    expect(first).toBe(second);

    first.setData([{ panelId: 'a' }], panelIdentifier);
    expect(second.hasData(panelIdentifier)).toBe(true);
    expect(second.getData(panelIdentifier)).toEqual([{ panelId: 'a' }]);
  });

  it('round-trips typed data per identifier', () => {
    const transfer = LocalSelectionTransfer.getInstance();
    const payload: DraggedPanel[] = [{ panelId: 'a' }, { panelId: 'b' }];

    transfer.setData(payload, panelIdentifier);

    expect(transfer.hasData(panelIdentifier)).toBe(true);
    const data: DraggedPanel[] | undefined = transfer.getData(panelIdentifier);
    expect(data).toBe(payload);
  });

  it('reports no data before setData and after clearData', () => {
    const transfer = LocalSelectionTransfer.getInstance();

    expect(transfer.hasData(panelIdentifier)).toBe(false);
    expect(transfer.getData(panelIdentifier)).toBeUndefined();

    transfer.setData([{ panelId: 'a' }], panelIdentifier);
    transfer.clearData(panelIdentifier);

    expect(transfer.hasData(panelIdentifier)).toBe(false);
    expect(transfer.getData(panelIdentifier)).toBeUndefined();
  });

  it('keeps identifiers isolated: another identifier sees no data', () => {
    const transfer = LocalSelectionTransfer.getInstance();

    transfer.setData([{ panelId: 'a' }], panelIdentifier);

    expect(transfer.hasData(groupIdentifier)).toBe(false);
    expect(transfer.getData(groupIdentifier)).toBeUndefined();
  });

  it('clearData with a different identifier does not clear the active payload', () => {
    const transfer = LocalSelectionTransfer.getInstance();

    transfer.setData([{ panelId: 'a' }], panelIdentifier);
    transfer.clearData(groupIdentifier);

    expect(transfer.hasData(panelIdentifier)).toBe(true);
    expect(transfer.getData(panelIdentifier)).toEqual([{ panelId: 'a' }]);
  });

  it('holds exactly one payload: a new drag evicts the previous identifier', () => {
    const transfer = LocalSelectionTransfer.getInstance();

    transfer.setData([{ panelId: 'a' }], panelIdentifier);
    transfer.setData([{ groupId: 1 }], groupIdentifier);

    expect(transfer.hasData(panelIdentifier)).toBe(false);
    expect(transfer.getData(panelIdentifier)).toBeUndefined();
    expect(transfer.hasData(groupIdentifier)).toBe(true);
    expect(transfer.getData(groupIdentifier)).toEqual([{ groupId: 1 }]);
  });

  it('distinguishes two identifiers of the same payload type by identity', () => {
    const transfer = LocalSelectionTransfer.getInstance();
    const otherPanelIdentifier = new TransferIdentifier<DraggedPanel>(
      'other-panel',
    );

    transfer.setData([{ panelId: 'a' }], panelIdentifier);

    expect(transfer.hasData(otherPanelIdentifier)).toBe(false);
    expect(transfer.getData(otherPanelIdentifier)).toBeUndefined();

    transfer.clearData(panelIdentifier);
  });
});
