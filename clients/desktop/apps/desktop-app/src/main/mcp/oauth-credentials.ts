import { readFile } from 'node:fs/promises';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  McpCredentialBroker,
  type McpCredentialOwner,
} from '@canopy/core-runtime/node/mcp-auth';
import { logMainProcessError } from '../lib/main-process-logging';
import { getMcpServerFilePath } from '../lib/paths';
import { isRecord } from './integration-http';
import { getValidMcpAccessToken } from './oauth-client';
import {
  invalidateMcpOAuthAccessToken,
  onMcpOAuthCredentialRevoked,
} from './oauth-token-store';

/** What an OAuth credential binding stands for. Owner-side only; never handed to a connection. */
export type McpOAuthSubject =
  | {
      readonly kind: 'device';
      readonly serverId: string;
      readonly configId: string;
    }
  | {
      readonly kind: 'declared';
      readonly definition: McpServerDefinitionData;
      readonly config: McpServerConfigData;
    };

/** Revocation scope of one server config: `${serverId}\0${configId}`. */
export function mcpOAuthScope(serverId: string, configId: string): string {
  return `${serverId}\0${configId}`;
}

/** The subject for an OAuth route registration: declared when both oauthDefinition and oauthConfig are set, else device. */
export function mcpOAuthSubjectForRegistration(registration: {
  serverId: string;
  configId: string;
  oauthDefinition?: McpServerDefinitionData;
  oauthConfig?: McpServerConfigData;
}): McpOAuthSubject {
  return registration.oauthDefinition && registration.oauthConfig
    ? {
        kind: 'declared',
        definition: registration.oauthDefinition,
        config: registration.oauthConfig,
      }
    : {
        kind: 'device',
        serverId: registration.serverId,
        configId: registration.configId,
      };
}

function isMcpServerFile(value: unknown): value is McpServerFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.server) &&
    isRecord(value.server.definition) &&
    Array.isArray(value.server.configs)
  );
}

async function readDeviceOAuthSubject(
  serverId: string,
  configId: string,
  read: (path: string) => Promise<string>,
): Promise<{
  definition: McpServerDefinitionData;
  config: McpServerConfigData;
} | null> {
  try {
    const parsed: unknown = JSON.parse(
      await read(getMcpServerFilePath(serverId)),
    );
    if (!isMcpServerFile(parsed)) {
      return null;
    }

    const config = parsed.server.configs.find(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id === configId,
    );
    if (!config) {
      return null;
    }

    return {
      definition: parsed.server.definition,
      config,
    };
  } catch {
    return null;
  }
}

function subjectIds(subject: McpOAuthSubject): {
  serverId: string;
  configId: string;
} {
  return subject.kind === 'device'
    ? { serverId: subject.serverId, configId: subject.configId }
    : { serverId: subject.definition.id, configId: subject.config.id };
}

/** The owner over the existing token client (CAN-4126 D1, D3). */
export function createMcpOAuthCredentialOwner(
  deps: {
    getValidMcpAccessToken?: typeof getValidMcpAccessToken;
    invalidateMcpOAuthAccessToken?: typeof invalidateMcpOAuthAccessToken;
    readFile?: (path: string) => Promise<string>;
  } = {},
): McpCredentialOwner<McpOAuthSubject> {
  const resolveToken = deps.getValidMcpAccessToken ?? getValidMcpAccessToken;
  const invalidateToken =
    deps.invalidateMcpOAuthAccessToken ?? invalidateMcpOAuthAccessToken;
  const read =
    deps.readFile ??
    ((path: string): Promise<string> => readFile(path, 'utf8'));
  return {
    scopeOf: (subject): string => {
      const { serverId, configId } = subjectIds(subject);
      return mcpOAuthScope(serverId, configId);
    },
    resolve: async (subject, signal): Promise<string | null> => {
      if (subject.kind === 'declared')
        return resolveToken(subject.definition, subject.config, signal);
      const loaded = await readDeviceOAuthSubject(
        subject.serverId,
        subject.configId,
        read,
      );
      if (!loaded) return null;
      return resolveToken(loaded.definition, loaded.config, signal);
    },
    invalidate: async (subject, token, upstreamUrl): Promise<void> => {
      const { serverId, configId } = subjectIds(subject);
      await invalidateToken(serverId, configId, token, upstreamUrl).catch(
        (error: unknown) =>
          logMainProcessError('MCP token invalidation failed', error),
      );
    },
  };
}

/** Feeds committed token-store revocations into a broker's epochs. Returns an unsubscribe function. */
export function connectMcpOAuthRevocations(
  broker: McpCredentialBroker<McpOAuthSubject>,
): () => void {
  return onMcpOAuthCredentialRevoked((event) =>
    broker.revokeScope(mcpOAuthScope(event.serverId, event.configId)),
  );
}

let credentials: {
  broker: McpCredentialBroker<McpOAuthSubject>;
  disconnect: () => void;
} | null = null;

/** The process-wide broker; created on first use with createMcpOAuthCredentialOwner() and connectMcpOAuthRevocations. */
export function getMcpOAuthCredentials(): McpCredentialBroker<McpOAuthSubject> {
  if (!credentials) {
    const broker = new McpCredentialBroker<McpOAuthSubject>({
      owner: createMcpOAuthCredentialOwner(),
    });
    credentials = { broker, disconnect: connectMcpOAuthRevocations(broker) };
  }
  return credentials.broker;
}

/** Test only (throws unless NODE_ENV === 'test'): closes and forgets the process-wide broker. */
export function resetMcpOAuthCredentialsForTests(): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Only tests may reset MCP OAuth credentials.');
  credentials?.disconnect();
  credentials?.broker.close();
  credentials = null;
}
