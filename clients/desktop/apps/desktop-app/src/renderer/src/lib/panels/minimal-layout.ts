import type {
  ISerializedPanelEntry,
  ISerializedPanelLeafNode,
  ISerializedPanelNode,
  PanelKind,
  SerializablePanelLayoutFile,
} from '@canopy/protocol';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { earlyAccessMinimalFor } from './early-access-minimal';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_ACTIVITY_PANEL_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_FILE_EXPLORER_PANEL_ID,
  DEFAULT_TERMINAL_GROUP_ID,
  DEFAULT_TERMINAL_PANEL_ID,
} from './panel-group-ids';

export type MinimalDestination = 'chat' | 'side' | 'bottom';
const MINIMAL_DESTINATIONS: readonly MinimalDestination[] = [
  'chat',
  'side',
  'bottom',
];
export interface MinimalLayoutImpact {
  panelId: string;
  title: string;
  outcome: 'Move to chat' | 'Move to side panel' | 'Move to bottom drawer';
}
export interface MinimalLayoutPlan {
  layout: SerializablePanelLayoutFile;
  impacts: MinimalLayoutImpact[];
  closedPanels: readonly ISerializedPanelEntry[];
}
export interface MinimalAuxiliaryLayoutSource {
  readonly layout: SerializablePanelLayoutFile;
  /** The popped-out group occupied a lower row in the Advanced layout. */
  readonly sourceWasBottom?: boolean;
}
export interface MinimalLayoutSidePanelOptions {
  /**
   * Leads the Side Panel with Activity and File explorer (the default). Early
   * access passes `false`: nothing is added, so a new Side Panel starts empty
   * and lists what can be opened there, and a closed Activity or File
   * explorer stays closed. Tabs a user's layout already holds are never
   * removed; only a fresh `initial` plan drops the app default's own
   * Activity and File explorer.
   */
  readonly seedSidePanels?: boolean;
}

export interface MinimalLayoutPlanOptions extends MinimalLayoutSidePanelOptions {
  /** Fresh Minimal workspaces begin with both optional regions hidden. */
  readonly initial?: boolean;
}

const WIDTH = 1200;
const HEIGHT = 800;

interface PositionedLeaf {
  readonly leaf: ISerializedPanelLeafNode;
  readonly inBottomRow: boolean;
}

function positionedLeaves(
  node: ISerializedPanelNode,
  orientation: 0 | 1,
  inBottomRow = false,
): PositionedLeaf[] {
  if (node.type === 'leaf') return [{ leaf: node, inBottomRow }];
  const childOrientation = orientation === 0 ? 1 : 0;
  return node.children.flatMap((child, index) =>
    positionedLeaves(
      child,
      childOrientation,
      inBottomRow || (orientation === 0 && index > 0),
    ),
  );
}

function leaves(node: ISerializedPanelNode): ISerializedPanelLeafNode[] {
  return node.type === 'leaf'
    ? [node]
    : node.children.flatMap((child) => leaves(child));
}

function destination(
  panel: ISerializedPanelEntry,
  inBottomRow: boolean,
): MinimalDestination {
  if (panel.kind === 'chat') return 'chat';
  if (panel.kind === 'terminal') return 'bottom';
  // Subagents is an unbound navigation/list panel, so it stays in the Side
  // Panel like File Explorer and Activity, even if it came from a bottom row.
  if (
    panel.kind === 'activity-section' ||
    panel.kind === 'file-explorer' ||
    panel.kind === 'subagents'
  ) {
    return 'side';
  }
  // Run and subagent-chat panels are content like files: they follow the file
  // destination (Side Panel, or Bottom Drawer when already in the bottom row)
  // and never land in the fixed Chat section.
  if (
    panel.kind === 'file-diff' ||
    panel.kind === 'pipeline-execution' ||
    panel.kind === 'subagent-chat'
  ) {
    return inBottomRow ? 'bottom' : 'side';
  }
  return inBottomRow ? 'bottom' : 'side';
}

function leaf(
  groupId: string,
  panels: readonly ISerializedPanelEntry[],
  size: number,
  preferredActive?: string | null,
  collapsed?: ISerializedPanelLeafNode['collapsed'],
): ISerializedPanelLeafNode {
  const activePanelId = panels.some(
    (panel) => panel.panelId === preferredActive,
  )
    ? (preferredActive ?? null)
    : (panels[0]?.panelId ?? null);
  return {
    type: 'leaf',
    groupId,
    panels,
    activePanelId,
    size,
    ...(collapsed !== undefined ? { collapsed } : {}),
  };
}

const OPTIONAL_REGION_EDGES: Readonly<
  Record<string, NonNullable<ISerializedPanelLeafNode['collapsed']>['edge']>
> = {
  [DEFAULT_EXTRAS_GROUP_ID]: 'right',
  [DEFAULT_TERMINAL_GROUP_ID]: 'bottom',
};

function mapLeaves(
  node: ISerializedPanelNode,
  map: (leaf: ISerializedPanelLeafNode) => ISerializedPanelLeafNode,
): ISerializedPanelNode {
  return node.type === 'leaf'
    ? map(node)
    : {
        ...node,
        children: node.children.map((child) => mapLeaves(child, map)),
      };
}

/** True when the grid already has Minimal's shape: Chat and Side Panel over Bottom Drawer. */
export function isMinimalLayoutShape(
  layout: SerializablePanelLayoutFile,
): boolean {
  const root = layout.grid.root;
  if (root.type !== 'branch' || root.children.length !== 2) return false;
  const [top, bottom] = root.children;
  return (
    top.type === 'branch' &&
    top.children.length === 2 &&
    top.children[0].type === 'leaf' &&
    top.children[0].groupId === DEFAULT_CHAT_GROUP_ID &&
    top.children[1].type === 'leaf' &&
    top.children[1].groupId === DEFAULT_EXTRAS_GROUP_ID &&
    bottom.type === 'leaf' &&
    bottom.groupId === DEFAULT_TERMINAL_GROUP_ID
  );
}

/**
 * Hides the Side Panel and Bottom Drawer of a Minimal layout and focuses
 * Chat. The collapse carries no `auto` flag, so nothing reopens the regions
 * on its own: they stay hidden until the user opens them from the header.
 */
export function hideOptionalMinimalRegions(
  layout: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  return {
    ...layout,
    grid: {
      ...layout.grid,
      root: mapLeaves(layout.grid.root, (entry) => {
        const edge = OPTIONAL_REGION_EDGES[entry.groupId];
        if (edge === undefined) return entry;
        return {
          ...entry,
          collapsed: {
            edge,
            expandedSize: entry.collapsed?.expandedSize ?? entry.size,
          },
        };
      }),
    },
    activeGroupId: DEFAULT_CHAT_GROUP_ID,
  };
}

function panelTitle(panel: ISerializedPanelEntry): string {
  return panel.title ?? panel.kind;
}

/**
 * A fresh layout built from the app's default arrangement (never one the user
 * made) carries Activity and File explorer under their default panel ids.
 * Without seeding, a fresh Minimal Side Panel starts empty, so they go.
 */
function dropDefaultSidePanels(
  buckets: Record<MinimalDestination, ISerializedPanelEntry[]>,
): void {
  const defaultIds = new Set([
    DEFAULT_ACTIVITY_PANEL_ID,
    DEFAULT_FILE_EXPLORER_PANEL_ID,
  ]);
  for (const target of MINIMAL_DESTINATIONS) {
    buckets[target] = buckets[target].filter(
      (panel) => !defaultIds.has(panel.panelId),
    );
  }
}

/**
 * Repairs a removed fixed group without reclassifying tabs the user explicitly
 * added to another Minimal section. Conversion is kind-based; repair is
 * group-based so a Side Panel terminal remains in Side Panel when Bottom
 * Drawer is reasserted later.
 */
export function repairMinimalLayout(
  current: SerializablePanelLayoutFile,
  auxiliary: readonly (
    | SerializablePanelLayoutFile
    | MinimalAuxiliaryLayoutSource
  )[] = [],
  options: MinimalLayoutSidePanelOptions = {},
): SerializablePanelLayoutFile {
  const auxiliarySources = auxiliary.map((source) =>
    'grid' in source ? { layout: source } : source,
  );
  const currentPositioned = positionedLeaves(
    current.grid.root,
    current.grid.orientation,
  );
  const auxiliaryPositioned = auxiliarySources.flatMap(
    ({ layout, sourceWasBottom }) =>
      positionedLeaves(layout.grid.root, layout.grid.orientation).map(
        (source) => ({
          ...source,
          inBottomRow: Boolean(sourceWasBottom) || source.inBottomRow,
        }),
      ),
  );
  const byGroup = new Map(
    currentPositioned.map(({ leaf: sourceLeaf }) => [
      sourceLeaf.groupId,
      sourceLeaf,
    ]),
  );
  const chatSource = byGroup.get(DEFAULT_CHAT_GROUP_ID);
  const sideSource = byGroup.get(DEFAULT_EXTRAS_GROUP_ID);
  const bottomSource = byGroup.get(DEFAULT_TERMINAL_GROUP_ID);
  const buckets: Record<MinimalDestination, ISerializedPanelEntry[]> = {
    chat: [...(chatSource?.panels ?? [])],
    side: [...(sideSource?.panels ?? [])],
    bottom: [...(bottomSource?.panels ?? [])],
  };
  const canonicalGroupIds = new Set([
    DEFAULT_CHAT_GROUP_ID,
    DEFAULT_EXTRAS_GROUP_ID,
    DEFAULT_TERMINAL_GROUP_ID,
  ]);
  for (const source of currentPositioned) {
    if (canonicalGroupIds.has(source.leaf.groupId)) continue;
    for (const panel of source.leaf.panels) {
      buckets[destination(panel, source.inBottomRow)].push(panel);
    }
  }
  for (const source of auxiliaryPositioned) {
    for (const panel of source.leaf.panels) {
      buckets[destination(panel, source.inBottomRow)].push(panel);
    }
  }

  if (options.seedSidePanels !== false) {
    const allPanels = [...buckets.chat, ...buckets.side, ...buckets.bottom];
    const activity =
      allPanels.find((panel) => panel.kind === 'activity-section') ??
      ({
        panelId: DEFAULT_ACTIVITY_PANEL_ID,
        kind: 'activity-section',
      } as const);
    const explorer =
      allPanels.find((panel) => panel.kind === 'file-explorer') ??
      ({
        panelId: DEFAULT_FILE_EXPLORER_PANEL_ID,
        kind: 'file-explorer',
      } as const);
    for (const target of MINIMAL_DESTINATIONS) {
      buckets[target] = buckets[target].filter(
        (panel) =>
          panel.panelId !== activity.panelId &&
          panel.panelId !== explorer.panelId,
      );
    }
    buckets.side = [activity, explorer, ...buckets.side];
  }
  if (buckets.bottom.length === 0) {
    buckets.bottom.push({
      panelId: DEFAULT_TERMINAL_PANEL_ID,
      kind: 'terminal',
    });
  }

  const width =
    Number.isFinite(current.grid.width) && current.grid.width > 0
      ? current.grid.width
      : WIDTH;
  const height =
    Number.isFinite(current.grid.height) && current.grid.height > 0
      ? current.grid.height
      : HEIGHT;
  const sideWidth = Math.min(
    width - 160,
    sideSource?.size ?? Math.round(width * 0.28),
  );
  const bottomHeight = Math.min(
    height - 120,
    bottomSource?.size ?? Math.round(height * 0.3),
  );
  const topHeight = height - bottomHeight;
  const chatWidth = width - sideWidth;

  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: width,
        children: [
          {
            type: 'branch',
            size: topHeight,
            children: [
              leaf(
                DEFAULT_CHAT_GROUP_ID,
                buckets.chat,
                chatWidth,
                chatSource?.activePanelId,
                chatSource?.collapsed,
              ),
              leaf(
                DEFAULT_EXTRAS_GROUP_ID,
                buckets.side,
                sideWidth,
                sideSource?.activePanelId,
                sideSource?.collapsed,
              ),
            ],
          },
          leaf(
            DEFAULT_TERMINAL_GROUP_ID,
            buckets.bottom,
            bottomHeight,
            bottomSource?.activePanelId,
            bottomSource?.collapsed,
          ),
        ],
      },
      orientation: 0,
      width,
      height,
    },
    activeGroupId: canonicalGroupIds.has(current.activeGroupId)
      ? current.activeGroupId
      : DEFAULT_CHAT_GROUP_ID,
    mostRecentActiveGroupIds: [
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_EXTRAS_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ],
  };
}

/** Deterministically projects the complete main/aux layout family to Minimal. */
export function planMinimalLayout(
  current: SerializablePanelLayoutFile,
  auxiliary: readonly (
    | SerializablePanelLayoutFile
    | MinimalAuxiliaryLayoutSource
  )[] = [],
  options: MinimalLayoutPlanOptions = {},
): MinimalLayoutPlan {
  const auxiliarySources = auxiliary.map((source) =>
    'grid' in source ? { layout: source } : source,
  );
  const sourceLeaves = [
    ...positionedLeaves(current.grid.root, current.grid.orientation),
    ...auxiliarySources.flatMap(({ layout, sourceWasBottom }) =>
      positionedLeaves(layout.grid.root, layout.grid.orientation).map(
        (source) => ({
          ...source,
          inBottomRow:
            Boolean(sourceWasBottom) ||
            source.inBottomRow ||
            source.leaf.groupId === DEFAULT_TERMINAL_GROUP_ID,
        }),
      ),
    ),
  ];
  const auxiliaryPanelIds = new Set(
    auxiliarySources.flatMap(({ layout }) =>
      leaves(layout.grid.root).flatMap((entry) =>
        entry.panels.map((panel) => panel.panelId),
      ),
    ),
  );
  const preservedSize = (groupId: string, fallback: number): number => {
    const size = sourceLeaves.find((entry) => entry.leaf.groupId === groupId)
      ?.leaf.size;
    return typeof size === 'number' && Number.isFinite(size) && size > 40
      ? size
      : fallback;
  };
  const preservedCollapsed = (
    groupId: string,
  ): ISerializedPanelLeafNode['collapsed'] =>
    sourceLeaves.find((entry) => entry.leaf.groupId === groupId)?.leaf
      .collapsed;
  const originalGroup = new Map<string, string>();
  const buckets: Record<MinimalDestination, ISerializedPanelEntry[]> = {
    chat: [],
    side: [],
    bottom: [],
  };
  const closedPanels: ISerializedPanelEntry[] = [];
  const activeByDestination: Partial<Record<MinimalDestination, string>> = {};
  let focusedPanelId: string | null = null;
  for (const file of [
    current,
    ...auxiliarySources.map((source) => source.layout),
  ]) {
    const activeLeaf = leaves(file.grid.root).find(
      (entry) => entry.groupId === file.activeGroupId,
    );
    if (
      focusedPanelId === null &&
      activeLeaf?.activePanelId !== null &&
      activeLeaf?.panels.some(
        (panel) => panel.panelId === activeLeaf.activePanelId,
      )
    ) {
      focusedPanelId = activeLeaf.activePanelId;
    }
  }
  for (const source of sourceLeaves) {
    for (const panel of source.leaf.panels) {
      originalGroup.set(panel.panelId, source.leaf.groupId);
      const target = destination(panel, source.inBottomRow);
      buckets[target].push({ ...panel, pinned: undefined });
      if (
        source.leaf.activePanelId === panel.panelId &&
        activeByDestination[target] === undefined
      ) {
        activeByDestination[target] = panel.panelId;
      }
    }
  }

  if (options.seedSidePanels === false) {
    if (options.initial === true) dropDefaultSidePanels(buckets);
  } else {
    const activity =
      buckets.side.find((panel) => panel.kind === 'activity-section') ??
      ({
        panelId: DEFAULT_ACTIVITY_PANEL_ID,
        kind: 'activity-section',
      } as const);
    const explorer =
      buckets.side.find((panel) => panel.kind === 'file-explorer') ??
      ({
        panelId: DEFAULT_FILE_EXPLORER_PANEL_ID,
        kind: 'file-explorer',
      } as const);
    const remainingSidePanels = buckets.side.filter(
      (panel) =>
        panel.panelId !== activity.panelId &&
        panel.panelId !== explorer.panelId,
    );
    buckets.side = [activity, explorer, ...remainingSidePanels];
  }
  if (!buckets.bottom.some((panel) => panel.kind === 'terminal')) {
    buckets.bottom.unshift({
      panelId: DEFAULT_TERMINAL_PANEL_ID,
      kind: 'terminal',
    });
  }
  const preferredActiveForDestination = (
    target: MinimalDestination,
  ): string | undefined =>
    focusedPanelId &&
    buckets[target].some((panel) => panel.panelId === focusedPanelId)
      ? focusedPanelId
      : activeByDestination[target];

  // Preserved leaf sizes are pixels in the serialized grid's coordinate space.
  // Resetting the canvas to a fixed size makes restoreLayout scale them again
  // on every Advanced → Minimal conversion.
  const width =
    Number.isFinite(current.grid.width) && current.grid.width > 0
      ? current.grid.width
      : WIDTH;
  const height =
    Number.isFinite(current.grid.height) && current.grid.height > 0
      ? current.grid.height
      : HEIGHT;
  const sideWidth = options.initial
    ? width / 2
    : Math.min(
        width - 160,
        preservedSize(
          DEFAULT_EXTRAS_GROUP_ID,
          preservedSize(DEFAULT_ACTIVITY_GROUP_ID, Math.round(width * 0.28)),
        ),
      );
  const bottomHeight = Math.min(
    height - 120,
    preservedSize(DEFAULT_TERMINAL_GROUP_ID, Math.round(height * 0.3)),
  );
  const chatWidth = width - sideWidth;
  const topHeight = height - bottomHeight;
  const chatLeaf = leaf(
    DEFAULT_CHAT_GROUP_ID,
    buckets.chat,
    chatWidth,
    preferredActiveForDestination('chat'),
  );
  const sideLeaf = leaf(
    DEFAULT_EXTRAS_GROUP_ID,
    buckets.side,
    sideWidth,
    preferredActiveForDestination('side'),
    options.initial
      ? // CAN-2836: the Minimal seed collapses the Side Panel the same way the
        // advanced default collapses the activity rail, and marks it `auto` so
        // it reopens itself once the worktree produces work. A mode conversion
        // (`initial: false`) carries the preserved descriptor verbatim and
        // therefore never invents the flag.
        { edge: 'right', expandedSize: sideWidth, auto: true }
      : (preservedCollapsed(DEFAULT_EXTRAS_GROUP_ID) ??
          preservedCollapsed(DEFAULT_ACTIVITY_GROUP_ID)),
  );
  const bottomSource = sourceLeaves.find((source) => source.inBottomRow)?.leaf;
  const bottomLeaf = leaf(
    DEFAULT_TERMINAL_GROUP_ID,
    buckets.bottom,
    bottomHeight,
    preferredActiveForDestination('bottom'),
    options.initial
      ? { edge: 'bottom', expandedSize: bottomHeight }
      : (preservedCollapsed(DEFAULT_TERMINAL_GROUP_ID) ??
          bottomSource?.collapsed),
  );
  const layout: SerializablePanelLayoutFile = {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: width,
        children: [
          {
            type: 'branch',
            size: topHeight,
            children: [chatLeaf, sideLeaf],
          },
          bottomLeaf,
        ],
      },
      orientation: 0,
      width,
      height,
    },
    activeGroupId:
      focusedPanelId &&
      buckets.side.some((panel) => panel.panelId === focusedPanelId)
        ? DEFAULT_EXTRAS_GROUP_ID
        : focusedPanelId &&
            buckets.bottom.some((panel) => panel.panelId === focusedPanelId)
          ? DEFAULT_TERMINAL_GROUP_ID
          : DEFAULT_CHAT_GROUP_ID,
    mostRecentActiveGroupIds: [
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_EXTRAS_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ],
  };
  const targetGroup: Record<MinimalDestination, string> = {
    chat: DEFAULT_CHAT_GROUP_ID,
    side: DEFAULT_EXTRAS_GROUP_ID,
    bottom: DEFAULT_TERMINAL_GROUP_ID,
  };
  const outcome: Record<MinimalDestination, MinimalLayoutImpact['outcome']> = {
    chat: 'Move to chat',
    side: 'Move to side panel',
    bottom: 'Move to bottom drawer',
  };
  const impacts: MinimalLayoutImpact[] = [];
  for (const target of MINIMAL_DESTINATIONS) {
    for (const panel of buckets[target]) {
      if (
        auxiliaryPanelIds.has(panel.panelId) ||
        originalGroup.get(panel.panelId) !== targetGroup[target]
      ) {
        impacts.push({
          panelId: panel.panelId,
          title: panelTitle(panel),
          outcome: outcome[target],
        });
      }
    }
  }
  return { layout, impacts, closedPanels };
}

export function applyMinimalLayout(
  worktreeKey: string,
  plan: MinimalLayoutPlan,
): boolean {
  return usePanelLayoutStore.getState().restoreLayout(worktreeKey, plan.layout);
}

export function ensureMinimalDestination(
  worktreeKey: string,
  kind: PanelKind,
): string | null {
  const target = destination(
    {
      panelId: 'probe',
      kind,
      instance: kind === 'terminal' ? { terminalId: 'probe' } : undefined,
    },
    false,
  );
  const groupId = {
    chat: DEFAULT_CHAT_GROUP_ID,
    side: DEFAULT_EXTRAS_GROUP_ID,
    bottom: DEFAULT_TERMINAL_GROUP_ID,
  }[target];
  const store = usePanelLayoutStore.getState();
  const current = store.serializeLayout(worktreeKey);
  if (current === null) return null;
  if (leaves(current.grid.root).some((entry) => entry.groupId === groupId))
    return groupId;
  const repaired = repairMinimalLayout(current, [], {
    seedSidePanels: !earlyAccessMinimalFor(worktreeKey),
  });
  if (!store.restoreLayout(worktreeKey, repaired)) return null;
  return leaves(repaired.grid.root).some((entry) => entry.groupId === groupId)
    ? groupId
    : null;
}

export function removeMinimalDestinationProbe(
  worktreeKey: string,
  destination: MinimalDestination,
): void {
  const groupId = {
    chat: DEFAULT_CHAT_GROUP_ID,
    side: DEFAULT_EXTRAS_GROUP_ID,
    bottom: DEFAULT_TERMINAL_GROUP_ID,
  }[destination];
  usePanelLayoutStore
    .getState()
    .closeTab(
      worktreeKey,
      groupId,
      `panel-minimal-destination-probe-${destination}`,
    );
}
