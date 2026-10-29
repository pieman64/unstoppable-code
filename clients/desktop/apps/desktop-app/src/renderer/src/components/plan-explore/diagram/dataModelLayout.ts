import dagre from 'dagre';
import { Position, type Edge, type Node } from '@xyflow/react';
import type {
  DataModelCardinality,
  DataModelChange,
  DataModelChangeType,
  DataModelEntity,
  DataModelField,
  DataModelGraph,
  DataModelRelationship,
} from '@canopy/desktop-shared/types/plan-diagrams';

/**
 * Rendered footprint of an entity node. Entity height is dynamic (driven by the
 * field count) but clamped between a floor and `DATA_MODEL_ENTITY_MAX_LAYOUT_HEIGHT`
 * so dagre always lays the graph out with bounded, stable dimensions; the node
 * view itself scrolls/clips overflow via CSS.
 */
export const DATA_MODEL_ENTITY_WIDTH = 280;
export const DATA_MODEL_ENTITY_BASE_HEIGHT = 72;
export const DATA_MODEL_FIELD_ROW_HEIGHT = 20;
export const DATA_MODEL_ENTITY_MIN_HEIGHT = 96;
export const DATA_MODEL_ENTITY_MAX_LAYOUT_HEIGHT = 220;

const RANK_SEP = 64;
const NODE_SEP = 40;

/**
 * Stable layout height for a given field count, bounded so a wide field list
 * never destabilizes the overall layout. Shared by dagre layout and the node
 * view so the rendered shell matches the height dagre positioned around.
 */
export function dataModelEntityHeightForFieldCount(count: number): number {
  const raw =
    DATA_MODEL_ENTITY_BASE_HEIGHT + count * DATA_MODEL_FIELD_ROW_HEIGHT;
  return Math.max(
    DATA_MODEL_ENTITY_MIN_HEIGHT,
    Math.min(DATA_MODEL_ENTITY_MAX_LAYOUT_HEIGHT, raw),
  );
}

/** Stable layout height for a single entity. */
export function dataModelEntityLayoutHeight(entity: DataModelEntity): number {
  return dataModelEntityHeightForFieldCount(entity.fields.length);
}

/**
 * Data carried on each React Flow entity node. Constrained to a string-keyed
 * record so it satisfies React Flow's `Node<NodeData>` generic without casts.
 */
export interface DataModelEntityNodeData extends Record<string, unknown> {
  name: string;
  kind?: string;
  detail?: string;
  fields: DataModelField[];
  files?: string[];
  planNodeIds?: string[];
  /** Entity-level diff tone in the unified view; absent in current/planned. */
  changeType?: DataModelChangeType;
  /** Entity-level change note for the unified diff chip/detail. */
  changeNote?: string;
  /**
   * Field-level diff tones for THIS entity only, keyed by field id. Built from
   * the field changes whose `entityId` matches this node, so a field id shared
   * across entities (e.g. `id`) is never highlighted on the wrong one.
   */
  fieldChanges?: Record<string, DataModelChangeType>;
  /** Search outline state merged in by the diagram search handle. */
  searchState?: 'match' | 'active';
}

/** Concrete React Flow node/edge types for the plan data model diff diagram. */
export type DataModelFlowNode = Node<
  DataModelEntityNodeData,
  'dataModelEntity'
>;
export type DataModelFlowEdge = Edge;

export interface DataModelFlowLayoutResult {
  nodes: DataModelFlowNode[];
  edges: DataModelFlowEdge[];
}

/**
 * Per-target diff annotation maps for the unified data model view.
 *
 * Field changes are nested by `entityId` because field ids are unique only
 * within an entity — never key field changes globally or a shared field id
 * (`id`, `createdAt`) lands on the wrong entity.
 */
export interface DataModelChangeMaps {
  entityChangeById: Map<string, DataModelChangeType>;
  entityNoteById: Map<string, string>;
  /** entityId -> (fieldId -> change). */
  fieldChangeByEntity: Map<string, Map<string, DataModelChangeType>>;
  relationshipChangeById: Map<string, DataModelChangeType>;
}

type DataModelChangeInput =
  | DataModelChange
  | {
      id: string;
      target: 'field';
      type: DataModelChangeType;
      fieldId: string;
      note?: string;
    };

const RELATIONSHIP_EDGE_COLORS: Record<DataModelChangeType, string> = {
  added: 'var(--fg-success)',
  removed: 'var(--fg-destructive)',
  changed: 'var(--fg-warning)',
};

const CARDINALITY_LABELS: Record<DataModelCardinality, string> = {
  'one-to-one': '1:1',
  'one-to-many': '1:N',
  'many-to-one': 'N:1',
  'many-to-many': 'N:N',
  unknown: '',
};

/** Display label for a relationship edge: explicit label first, then cardinality. */
function relationshipEdgeLabel(
  relationship: DataModelRelationship,
): string | undefined {
  if (relationship.label && relationship.label.trim().length > 0) {
    const cardinality = relationship.cardinality
      ? CARDINALITY_LABELS[relationship.cardinality]
      : '';
    return cardinality
      ? `${relationship.label} (${cardinality})`
      : relationship.label;
  }
  if (relationship.cardinality) {
    const cardinality = CARDINALITY_LABELS[relationship.cardinality];
    return cardinality.length > 0 ? cardinality : undefined;
  }
  return undefined;
}

function toEntityNodeData(
  entity: DataModelEntity,
  changeMaps: DataModelChangeMaps | undefined,
): DataModelEntityNodeData {
  const fieldChangeMap = changeMaps?.fieldChangeByEntity.get(entity.id);
  return {
    name: entity.name,
    kind: entity.kind,
    detail: entity.detail,
    fields: entity.fields,
    files: entity.files,
    planNodeIds: entity.planNodeIds,
    changeType: changeMaps?.entityChangeById.get(entity.id),
    changeNote: changeMaps?.entityNoteById.get(entity.id),
    fieldChanges:
      fieldChangeMap && fieldChangeMap.size > 0
        ? Object.fromEntries(fieldChangeMap)
        : undefined,
  };
}

/**
 * Pure dagre top-to-bottom layout for a `DataModelGraph`. Returns positioned
 * React Flow entity nodes plus relationship edges. Relationships referencing
 * unknown entity ids are dropped so dagre never positions phantom nodes.
 * Returns empty arrays for an empty graph.
 *
 * `changeMaps` carry diff annotations into node data and edge styling so the
 * unified view can color/chip each entity, field row, and relationship.
 */
export function computeDataModelLayout(
  graph: DataModelGraph | null | undefined,
  changeMaps?: DataModelChangeMaps,
): DataModelFlowLayoutResult {
  if (!graph || graph.entities.length === 0) {
    return { nodes: [], edges: [] };
  }

  const known = new Set(graph.entities.map((entity) => entity.id));

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setGraph({
    rankdir: 'TB',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 16,
    marginy: 16,
  });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const heightById = new Map<string, number>();
  for (const entity of graph.entities) {
    const height = dataModelEntityLayoutHeight(entity);
    heightById.set(entity.id, height);
    dagreGraph.setNode(entity.id, {
      width: DATA_MODEL_ENTITY_WIDTH,
      height,
    });
  }

  const validRelationships = graph.relationships.filter(
    (relationship) =>
      known.has(relationship.from) && known.has(relationship.to),
  );
  for (const relationship of validRelationships) {
    dagreGraph.setEdge(relationship.from, relationship.to);
  }

  dagre.layout(dagreGraph);

  const nodes: DataModelFlowNode[] = graph.entities.map((entity) => {
    const positioned = dagreGraph.node(entity.id);
    const height = heightById.get(entity.id) ?? DATA_MODEL_ENTITY_MIN_HEIGHT;
    const x =
      positioned === undefined ? 0 : positioned.x - DATA_MODEL_ENTITY_WIDTH / 2;
    const y = positioned === undefined ? 0 : positioned.y - height / 2;
    return {
      id: entity.id,
      type: 'dataModelEntity',
      position: { x, y },
      data: toEntityNodeData(entity, changeMaps),
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: false,
      connectable: false,
    };
  });

  const edges: DataModelFlowEdge[] = validRelationships.map((relationship) => {
    const changeType = changeMaps?.relationshipChangeById.get(relationship.id);
    const stroke = changeType
      ? RELATIONSHIP_EDGE_COLORS[changeType]
      : undefined;
    return {
      id: relationship.id,
      source: relationship.from,
      target: relationship.to,
      type: 'smoothstep',
      label: relationshipEdgeLabel(relationship),
      ...(stroke
        ? {
            style: { stroke, strokeWidth: 2 },
            labelStyle: { fill: stroke },
          }
        : {}),
    };
  });

  return { nodes, edges };
}

/**
 * Builds the unified current/planned `DataModelGraph` over the union of entity
 * ids (planned winning on collision so name/detail reflect the projected
 * state). For entities present in both, fields are unioned by id with planned
 * winning, and removed fields (current-only, within the SAME entity) retained
 * so they still render with a removed annotation. Relationships are unioned by
 * id, planned winning, with removed relationships retained.
 */
export function buildUnifiedDataModelGraph(
  current: DataModelGraph,
  planned: DataModelGraph,
): DataModelGraph {
  const entityById = new Map<string, DataModelEntity>();
  for (const entity of current.entities) {
    entityById.set(entity.id, entity);
  }
  for (const entity of planned.entities) {
    const existing = entityById.get(entity.id);
    if (!existing) {
      entityById.set(entity.id, entity);
      continue;
    }
    // Union fields within THIS entity only: planned order/data wins, then
    // append removed (current-only) fields so they still render.
    const fieldById = new Map<string, DataModelField>();
    for (const field of entity.fields) {
      fieldById.set(field.id, field);
    }
    for (const field of existing.fields) {
      if (!fieldById.has(field.id)) {
        fieldById.set(field.id, field);
      }
    }
    entityById.set(entity.id, {
      ...entity,
      fields: Array.from(fieldById.values()),
    });
  }

  const relationshipById = new Map<string, DataModelRelationship>();
  for (const relationship of current.relationships) {
    relationshipById.set(relationship.id, relationship);
  }
  for (const relationship of planned.relationships) {
    relationshipById.set(relationship.id, relationship);
  }

  return {
    entities: Array.from(entityById.values()),
    relationships: Array.from(relationshipById.values()),
  };
}

/**
 * Resolves the per-target change annotation maps for the unified view.
 *
 * Removed items are derived from current-vs-planned id diffs: removed entities
 * and relationships by their globally-unique top-level id, and removed fields by
 * comparing a current entity's field ids against the SAME entity's field ids in
 * planned — never across entities. The explicit `changes` array supplies
 * added/changed (and may also confirm removed), dispatched by `target`:
 *   - `entity`       -> entityChangeById[entityId]
 *   - `field`        -> fieldChangeByEntity[entityId][fieldId]
 *   - `relationship` -> relationshipChangeById[relationshipId]
 * A `field` change missing `entityId` cannot be scoped and is ignored.
 */
export function buildDataModelChangeMaps(
  current: DataModelGraph,
  planned: DataModelGraph,
  changes: DataModelChangeInput[],
): DataModelChangeMaps {
  const entityChangeById = new Map<string, DataModelChangeType>();
  const entityNoteById = new Map<string, string>();
  const fieldChangeByEntity = new Map<
    string,
    Map<string, DataModelChangeType>
  >();
  const relationshipChangeById = new Map<string, DataModelChangeType>();

  const setFieldChange = (
    entityId: string,
    fieldId: string,
    type: DataModelChangeType,
  ): void => {
    let entityFields = fieldChangeByEntity.get(entityId);
    if (!entityFields) {
      entityFields = new Map<string, DataModelChangeType>();
      fieldChangeByEntity.set(entityId, entityFields);
    }
    entityFields.set(fieldId, type);
  };

  // Removed entities: in current, absent from planned.
  const plannedEntityById = new Map(
    planned.entities.map((entity) => [entity.id, entity] as const),
  );
  for (const entity of current.entities) {
    const plannedEntity = plannedEntityById.get(entity.id);
    if (!plannedEntity) {
      entityChangeById.set(entity.id, 'removed');
      continue;
    }
    // Removed fields: scoped strictly within the SAME entity's planned fields.
    const plannedFieldIds = new Set(
      plannedEntity.fields.map((field) => field.id),
    );
    for (const field of entity.fields) {
      if (!plannedFieldIds.has(field.id)) {
        setFieldChange(entity.id, field.id, 'removed');
      }
    }
  }

  // Removed relationships: in current, absent from planned.
  const plannedRelationshipIds = new Set(
    planned.relationships.map((relationship) => relationship.id),
  );
  for (const relationship of current.relationships) {
    if (!plannedRelationshipIds.has(relationship.id)) {
      relationshipChangeById.set(relationship.id, 'removed');
    }
  }

  // Explicit changes win, dispatched by their discriminating `target`.
  for (const change of changes) {
    if (change.target === 'entity') {
      entityChangeById.set(change.entityId, change.type);
      if (change.note !== undefined) {
        entityNoteById.set(change.entityId, change.note);
      }
    } else if (change.target === 'field') {
      // Field ids are entity-scoped; without entityId the change is ambiguous.
      if (!('entityId' in change) || change.entityId.length === 0) {
        continue;
      }
      setFieldChange(change.entityId, change.fieldId, change.type);
    } else if (change.target === 'relationship') {
      relationshipChangeById.set(change.relationshipId, change.type);
    }
  }

  return {
    entityChangeById,
    entityNoteById,
    fieldChangeByEntity,
    relationshipChangeById,
  };
}
