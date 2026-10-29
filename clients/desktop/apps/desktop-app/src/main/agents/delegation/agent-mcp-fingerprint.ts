import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** Pin all static selected configuration without retaining its secret values. */
export function mcpTransportDigest(
  raw: unknown,
  identity: Readonly<Record<string, string>>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ identity, raw })))
    .digest('hex');
}

/** Pins an account selection to the connection it resolved to; no secrets. */
export function accountMcpTransportDigest(connection: {
  id: string;
  serverKey: string;
  configId: string;
}): string {
  return mcpTransportDigest(
    { kind: 'account', connectionId: connection.id },
    { serverId: connection.serverKey, configId: connection.configId },
  );
}

export function standaloneMcpTransportDigest(
  serverId: string,
  configId: string,
  definition: unknown,
  config: unknown,
): string {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {};
  const source = record(definition);
  const variant = record(config);
  const credentialAware = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /(?:^|[_-])(?:auth(?:orization)?|token|secret|password|credential|api[_-]?key|private[_-]?key)(?:$|[_-])/i.test(
          key,
        )
          ? '<credential>'
          : entry,
      ]),
    );
  };
  const oauth = Object.fromEntries(
    Object.entries(record(source.oauth)).filter(
      ([key]) => key !== 'clientSecret',
    ),
  );
  return mcpTransportDigest(
    {
      definition: {
        type: source.type,
        command: source.command,
        args: source.args,
        url: source.url,
        headers: credentialAware(source.headers),
        oauth,
        httpAuthHandler: source.httpAuthHandler,
      },
      config: {
        enabled: variant.enabled,
        extraArgs: variant.extraArgs,
        envVars: credentialAware(variant.envVars),
        extraHeaders: credentialAware(variant.extraHeaders),
      },
    },
    { serverId, configId },
  );
}

/** Credential rotation keeps an inherited plugin's transport identity. */
export function inheritedPluginMcpTransportDigest(
  raw: unknown,
  identity: Readonly<Record<string, string>>,
): string {
  const credentialKey = (key: string): boolean =>
    /(?:^|[_-])(?:auth(?:orization)?|token|secret|password|credentials?|api[_-]?key|private[_-]?key)$/i.test(
      key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'),
    );
  const redactUrl = (value: string): string => {
    if (!/^https?:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.username) url.username = '<credential>';
      if (url.password) url.password = '<credential>';
      for (const key of Array.from(new Set(url.searchParams.keys()))) {
        if (credentialKey(key)) url.searchParams.set(key, '<credential>');
      }
      return url.toString();
    } catch {
      // Keep unresolved URL templates pinned until the host resolves them.
      return value;
    }
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return redactUrl(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        // These values name environment selectors, not the credentials they read.
        if (key === 'env_http_headers') return [key, entry];
        if (credentialKey(key)) return [key, '<credential>'];
        if (key === 'args' && Array.isArray(entry)) {
          return [
            key,
            entry.map((argument: unknown, index: number) => {
              const previous: unknown = entry[index - 1];
              if (
                typeof previous === 'string' &&
                /^--?[^=]+$/.test(previous) &&
                credentialKey(previous)
              )
                return '<credential>';
              if (typeof argument !== 'string') return redact(argument);
              const assignment = /^(--?[^=]+)=/.exec(argument);
              if (assignment && credentialKey(assignment[1]))
                return `${assignment[1]}=<credential>`;
              return redact(argument);
            }),
          ];
        }
        return [key, redact(entry)];
      }),
    );
  };
  return mcpTransportDigest(redact(raw), identity);
}

/** Pins the host-owned installation without retaining its local path. */
export function inheritedPluginInstallDigest(root: string): string {
  return createHash('sha256').update(realpathSync(root)).digest('hex');
}
