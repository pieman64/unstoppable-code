import type {
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import type { CanopyRuntimeProfile } from '../runtime/types';

export interface RuntimeOperationOwner {
  name: string;
  plane?: 'core' | 'worker';
  operations: readonly string[];
}

export interface RuntimeOperation {
  name: string;
  kind: 'query' | 'instruction' | 'stream';
  plane: 'core' | 'worker';
  owner: string;
}

export interface OperationRegistryOptions {
  profile: CanopyRuntimeProfile;
  definitions: {
    queries: CanopyQueryDefinitionMap;
    instructions: CanopyInstructionDefinitionMap;
    streams: CanopyStreamDefinitionMap;
  };
  owners: readonly RuntimeOperationOwner[];
}

/**
 * Validates operation ownership metadata. Handler admission stays with the
 * dispatcher; this holds no handlers.
 */
export function createOperationRegistry(
  options: OperationRegistryOptions,
): readonly RuntimeOperation[] {
  const { profile, definitions, owners } = options;
  const ownerByOperation = new Map<string, string>();
  const ownerPlanes = new Map<string, RuntimeOperationOwner['plane']>();
  const ownerNames = new Set<string>();
  for (const owner of owners) {
    if (ownerNames.has(owner.name))
      throw new Error(`Duplicate operation owner ${owner.name}`);
    ownerNames.add(owner.name);
    ownerPlanes.set(owner.name, owner.plane);
    if (owner.plane && profile !== 'core+worker' && profile !== owner.plane)
      throw new Error(
        `Runtime profile ${profile} cannot host ${owner.plane} module ${owner.name}`,
      );
    for (const operation of owner.operations) {
      const existing = ownerByOperation.get(operation);
      if (existing !== undefined)
        throw new Error(
          `Operation ${operation} is claimed by both ${existing} and ${owner.name}`,
        );
      ownerByOperation.set(operation, owner.name);
    }
  }

  const groups: readonly [
    RuntimeOperation['kind'],
    Readonly<Record<string, { plane: RuntimeOperation['plane'] }>>,
  ][] = [
    ['query', definitions.queries],
    ['instruction', definitions.instructions],
    ['stream', definitions.streams],
  ];
  const operations: RuntimeOperation[] = [];
  const seen = new Set<string>();
  for (const [kind, map] of groups) {
    for (const [name, definition] of Object.entries(map)) {
      if (seen.has(name)) throw new Error(`Duplicate operation name ${name}`);
      seen.add(name);
      if (profile !== 'core+worker' && profile !== definition.plane)
        throw new Error(
          `Runtime profile ${profile} cannot register operation ${name}`,
        );
      const owner = ownerByOperation.get(name);
      if (owner === undefined)
        throw new Error(`Operation ${name} has no owner`);
      const ownerPlane = ownerPlanes.get(owner);
      if (ownerPlane && ownerPlane !== definition.plane)
        throw new Error(
          `Module ${owner} cannot register ${definition.plane} operation ${name}`,
        );
      operations.push(
        Object.freeze({ name, kind, plane: definition.plane, owner }),
      );
    }
  }
  ownerByOperation.forEach((owner, operation) => {
    if (!seen.has(operation))
      throw new Error(`Owner ${owner} claims unknown operation ${operation}`);
  });
  return Object.freeze(operations);
}
