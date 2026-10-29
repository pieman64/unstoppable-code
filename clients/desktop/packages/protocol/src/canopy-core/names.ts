import { z } from 'zod';

export const CANOPY_PLANES = ['core', 'worker'] as const;

export type CanopyPlane = (typeof CANOPY_PLANES)[number];

/**
 * A coarse compile-time filter for universal names. Runtime schemas enforce the
 * complete grammar and closed registries provide exact operation-name unions.
 */
export type PlaneQualifiedName<P extends CanopyPlane = CanopyPlane> =
  `${P}.${string}.${string}`;

/** Rejects missing and doubled plane prefixes at registry definition sites. */
export type ValidPlaneQualifiedName<
  Name extends string,
  P extends CanopyPlane = CanopyPlane,
> =
  Name extends PlaneQualifiedName<P>
    ? Name extends `${P}.${CanopyPlane}.${string}`
      ? never
      : Name
    : never;

const PLANE_QUALIFIED_NAME_PATTERN = /^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/;

function isSinglyPlaneQualified(value: unknown): value is PlaneQualifiedName {
  if (typeof value !== 'string') return false;
  if (!PLANE_QUALIFIED_NAME_PATTERN.test(value)) return false;
  const [, secondSegment] = value.split('.');
  return secondSegment !== 'core' && secondSegment !== 'worker';
}

function createPlaneQualifiedNameSchema(
  description: string,
): z.ZodType<PlaneQualifiedName> {
  return z
    .custom<PlaneQualifiedName>(
      isSinglyPlaneQualified,
      'Expected one core or worker prefix followed by a domain and terminal lower-camel segment',
    )
    .describe(description);
}

export const CanopyOperationNameSchema = createPlaneQualifiedNameSchema(
  'Canopy operation name',
);
export const CanopyEventNameSchema =
  createPlaneQualifiedNameSchema('Canopy event name');
export const CanopyStreamNameSchema =
  createPlaneQualifiedNameSchema('Canopy stream name');
export const CanopyGrantNameSchema =
  createPlaneQualifiedNameSchema('Canopy grant name');
export const CanopyCapabilityNameSchema = createPlaneQualifiedNameSchema(
  'Canopy capability name',
);
export const CanopyOperationCodeSchema = createPlaneQualifiedNameSchema(
  'Canopy operation-specific error code',
);

export type CanopyOperationName = z.output<typeof CanopyOperationNameSchema>;
export type CanopyEventName = z.output<typeof CanopyEventNameSchema>;
export type CanopyStreamName = z.output<typeof CanopyStreamNameSchema>;
export type CanopyGrantName = z.output<typeof CanopyGrantNameSchema>;
export type CanopyCapabilityName = z.output<typeof CanopyCapabilityNameSchema>;
export type CanopyOperationCode = z.output<typeof CanopyOperationCodeSchema>;

export function getCanopyNamePlane(name: PlaneQualifiedName): CanopyPlane {
  return name.startsWith('core.') ? 'core' : 'worker';
}

export function getCanopyNameDomain(name: PlaneQualifiedName): string {
  return name.split('.')[1];
}
