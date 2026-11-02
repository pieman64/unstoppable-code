import {
  notifyAcceptedWorktreeTurn,
  notifyHomeTaskSent,
} from '@/components/onboarding-tips/homeSendEvents';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { watchPresentationMilestones } from '../presentation-milestones';

it('uses only first live acceptance, never loading state or broad Home success', () => {
  const onInteraction = jest.fn();
  const onMilestone = jest.fn();
  const onAcceptedTurn = jest.fn();
  const dispose = watchPresentationMilestones({
    onInteraction,
    onMilestone,
    onAcceptedTurn,
    watchAcceptedTurns: true,
  });
  try {
    useChatStore.setState({ worktreeChats: {} });
    notifyHomeTaskSent({ kind: 'chat' }); // Can mean empty creation or schedule.
    notifyHomeTaskSent({ kind: 'chat', chatId: 'historical' });
    notifyHomeTaskSent({ kind: 'pipeline' });
    expect(onAcceptedTurn).not.toHaveBeenCalled();
    expect(onMilestone).not.toHaveBeenCalled();
    notifyAcceptedWorktreeTurn();
    notifyAcceptedWorktreeTurn();
    expect(onAcceptedTurn).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
  notifyAcceptedWorktreeTurn();
  expect(onAcceptedTurn).toHaveBeenCalledTimes(1);
});

it('does not resubscribe to consumed acceptance on remount', () => {
  const onAcceptedTurn = jest.fn();
  const dispose = watchPresentationMilestones({
    onInteraction: jest.fn(),
    onMilestone: jest.fn(),
    onAcceptedTurn,
    watchAcceptedTurns: false,
  });
  notifyAcceptedWorktreeTurn();
  expect(onAcceptedTurn).not.toHaveBeenCalled();
  dispose();
});

it('reports page navigation before Home return eligibility and ignores unchanged selection', () => {
  useNavigationStore.setState({ activePage: 'home' });
  const events: string[] = [];
  const dispose = watchPresentationMilestones({
    onInteraction: () => {
      events.push('interaction');
    },
    onMilestone: () => {
      events.push('milestone');
    },
    onAcceptedTurn: jest.fn(),
    watchAcceptedTurns: false,
  });
  useChatStore.setState({ selectedWorktree: null });
  events.length = 0;
  useNavigationStore.setState({ activePage: 'main' });
  useNavigationStore.setState({ activePage: 'home' });
  useChatStore.setState({ selectedWorktree: null });
  expect(events).toEqual(['interaction', 'interaction', 'milestone']);
  dispose();
});

it('ignores retry acceptance before the first newly accepted turn', () => {
  const onAcceptedTurn = jest.fn();
  const dispose = watchPresentationMilestones({
    onInteraction: jest.fn(),
    onMilestone: jest.fn(),
    onAcceptedTurn,
    watchAcceptedTurns: true,
  });
  try {
    notifyAcceptedWorktreeTurn({ retry: true });
    expect(onAcceptedTurn).not.toHaveBeenCalled();
    notifyAcceptedWorktreeTurn();
    expect(onAcceptedTurn).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
  }
});
