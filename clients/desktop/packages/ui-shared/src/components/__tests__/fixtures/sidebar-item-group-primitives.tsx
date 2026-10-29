import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { SidebarItemGroup as GroupData } from '@canopy/protocol/sidebar';
import { ColorSwatchPicker } from '../../ColorSwatchPicker';
import {
  SidebarItemGroup,
  SidebarItemGroupEditor,
  type SidebarItemGroupLabelCommit,
} from '../../SidebarItemGroup';
import { sidebarItemGroupRowMenu } from '../../sidebar-item-group-menu';
import { WorktreeActionsMenu } from '../../WorktreeActionsMenu';
import { WorktreeRow } from '../../WorktreeRow';

const hideFirstMemberOnCollapse =
  new URLSearchParams(window.location.search).get(
    'hideFirstMemberOnCollapse',
  ) === 'true';

function Harness(): JSX.Element {
  const [group, setGroup] = useState<GroupData>({
    id: 'grp-frontend',
    name: 'Frontend',
    color: 'categorical-1',
    collapsed: false,
    labelHidden: false,
    memberIds: ['a', 'b'],
  });
  const [editor, setEditor] = useState(false);
  const [lastAction, setLastAction] = useState('');
  const [legacyColor, setLegacyColor] = useState<string>();
  const [removed, setRemoved] = useState(false);
  const firstRowRef = useRef<HTMLDivElement | null>(null);
  const rowMenuRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect((): void => {
    if (removed) firstRowRef.current?.focus();
  }, [removed]);
  const unitLabel = { singular: 'worktree', plural: 'worktrees' };
  const actions = {
    onToggle: (): void =>
      setGroup((value) => ({ ...value, collapsed: !value.collapsed })),
    onCreate: (): void => setLastAction('create'),
    onUngroup: (): void => {
      setRemoved(true);
      firstRowRef.current?.focus();
    },
    onLabelCommit: (label: SidebarItemGroupLabelCommit): void =>
      setGroup((value) => ({ ...value, ...label })),
    onColorChange: (color: GroupData['color']): void =>
      setGroup((value) => ({ ...value, color })),
    onKeepWhenEmptyChange: (keepWhenEmpty: boolean): void =>
      setGroup((value) => ({ ...value, keepWhenEmpty })),
  };
  const groups: readonly Pick<GroupData, 'id' | 'name'>[] = [
    group,
    { id: 'grp-other', name: 'Backend' },
  ];
  const rows = (
    <>
      {(!group.collapsed || !hideFirstMemberOnCollapse) && (
        <div ref={firstRowRef} tabIndex={-1} data-testid="selected-member">
          <WorktreeRow
            branchLabel="Checkout form"
            branchName="checkout"
            uiStatus="idle"
            selected={!hideFirstMemberOnCollapse}
            actionChipSlot={
              <WorktreeActionsMenu
                ref={rowMenuRef}
                alwaysVisible
                items={sidebarItemGroupRowMenu({
                  groups: [
                    group,
                    { ...group, id: 'grp-other', name: 'Backend' },
                  ],
                  currentGroupId: group.id,
                  eligible: true,
                  unitLabel,
                  onNewGroup: (): void => setLastAction('new-group'),
                  onMove: (id): void => setLastAction(id),
                  onEdit: (): void => setEditor(true),
                  onToggle: actions.onToggle,
                  onRemove: (): void => setLastAction('remove'),
                })}
                accessibleLabel="Actions for Checkout form"
                triggerTestId="row-menu"
                menuTestId="row-actions"
              />
            }
          />
        </div>
      )}
      {(!group.collapsed || hideFirstMemberOnCollapse) && (
        <WorktreeRow
          branchLabel="Dark mode polish"
          uiStatus="unread"
          selected={hideFirstMemberOnCollapse}
        />
      )}
    </>
  );
  return (
    <main
      data-testid="primitives-harness"
      className="bg-base fg-primary p-6"
      style={{ width: 380 }}
    >
      <h1 className="mb-3 text-s fg-secondary">Projects</h1>
      <section className="bg-secondary p-2" data-testid="group-area">
        <WorktreeRow branchLabel="Release notes" uiStatus="idle" />
        {removed ? (
          rows
        ) : (
          <SidebarItemGroup
            group={group}
            groups={groups}
            count={2}
            unitLabel={unitLabel}
            actions={actions}
            returnFocusRef={firstRowRef}
          >
            {rows}
          </SidebarItemGroup>
        )}
        <WorktreeRow branchLabel="Fix upload test" uiStatus="idle" />
      </section>
      <h2 className="mt-4 mb-2 text-s fg-secondary">Project color</h2>
      <ColorSwatchPicker
        value={legacyColor}
        onChange={setLegacyColor}
        testId="legacy-swatches"
      />
      <output data-testid="legacy-color">{legacyColor}</output>
      <output data-testid="last-action">{lastAction}</output>
      {editor && (
        <SidebarItemGroupEditor
          group={group}
          groups={groups}
          unitLabel={unitLabel}
          anchorRef={rowMenuRef}
          returnFocusRef={rowMenuRef}
          onClose={(): void => setEditor(false)}
          onLabelCommit={actions.onLabelCommit}
          onColorChange={actions.onColorChange}
          onKeepWhenEmptyChange={actions.onKeepWhenEmptyChange}
          onCreate={actions.onCreate}
          onUngroup={actions.onUngroup}
        />
      )}
    </main>
  );
}
const container = document.getElementById('root');
if (!container) throw new Error('Missing primitive fixture root');
createRoot(container).render(<Harness />);
