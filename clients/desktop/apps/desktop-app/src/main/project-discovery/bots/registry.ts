import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_BOT_ID,
  type BotRow,
} from '@canopy/desktop-shared/lib/bot-discovery';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { DiscoveryError } from '../errors';

export interface RegisteredBot {
  botId: string;
  projectId: string;
  name: string;
  capabilities: BotRow['capabilities'];
}

const advisor: RegisteredBot = {
  botId: APP_ADVISOR_BOT_ID,
  projectId: APP_ADVISOR_PROJECT_ID,
  name: ORCHESTRATOR_LABEL,
  capabilities: {
    listTasks: true,
    readChats: true,
    sendMessages: true,
    createTasks: true,
    createChats: true,
    watchChats: true,
  },
};

/** Public IDs only: the internal workspace ID is never a bot alias. */
export function requireBot(botId: string): RegisteredBot {
  if (botId !== advisor.botId)
    throw new DiscoveryError('unknown_bot', 'Bot was not found.');
  return advisor;
}

export function registeredBots(): readonly RegisteredBot[] {
  return [advisor];
}
