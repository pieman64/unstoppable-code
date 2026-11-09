import type {
  CanopyCoreRelayAuthority,
  CanopyCoreRelayReply,
} from '../../../shared/canopy-core-relay';

export type RelayAuthorityRoute =
  | {
      readonly authority: 'local' | CanopyCoreRelayAuthority;
      /** The request without its `authority`, as the authority's relay parses it. */
      readonly request: unknown;
    }
  | { readonly invalid: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Picks the relay a renderer request names; an unknown authority is never the local one. */
export function splitRelayAuthority(input: unknown): RelayAuthorityRoute {
  if (!isRecord(input) || !('authority' in input))
    return { authority: 'local', request: input };
  const { authority, ...request } = input;
  return authority === 'web-core' ? { authority, request } : { invalid: true };
}

export const INVALID_RELAY_AUTHORITY: CanopyCoreRelayReply = {
  ok: false,
  error: {
    kind: 'invalid_argument',
    message: 'The relay request names an unknown authority.',
    retry: { kind: 'never' },
  },
};

export const WEB_CORE_RELAY_UNAVAILABLE: CanopyCoreRelayReply = {
  ok: false,
  error: {
    kind: 'capability_unavailable',
    message: 'Cloud chats are not available.',
    retry: { kind: 'never' },
  },
};

interface RelayAuthorityTarget<Event> {
  invoke(event: Event, input: unknown): Promise<CanopyCoreRelayReply>;
}

/** The relay each authority reaches; without `webCore` the web core is unavailable. */
export interface RelayAuthorityTargets<Event> {
  readonly local: RelayAuthorityTarget<Event>;
  readonly webCore?: RelayAuthorityTarget<Event>;
}

/** One renderer request to exactly one relay, never a fallback to another. */
export function routeRendererRelayRequest<Event>(
  targets: RelayAuthorityTargets<Event>,
  event: Event,
  input: unknown,
): Promise<CanopyCoreRelayReply> {
  const route = splitRelayAuthority(input);
  if ('invalid' in route) return Promise.resolve(INVALID_RELAY_AUTHORITY);
  if (route.authority === 'web-core')
    return targets.webCore
      ? targets.webCore.invoke(event, route.request)
      : Promise.resolve(WEB_CORE_RELAY_UNAVAILABLE);
  return targets.local.invoke(event, route.request);
}
