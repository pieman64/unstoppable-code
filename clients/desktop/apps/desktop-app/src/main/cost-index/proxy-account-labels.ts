// Joins account-proxy account labels into cost views as they are read
// (CAN-4021). The store keeps an account's key only, never its label (often
// an email), the same way chat names are joined from the chat store.

import type {
  CostAttributedItem,
  CostChatRow,
  CostChatView,
  CostProxyAccountRef,
  CostScopeView,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';

/** Label by `proxy:<connectionId>:<auth_index>`. */
export type ProxyAccountLabels = ReadonlyMap<string, string>;

function labelRows<Row extends CostProxyAccountRef>(
  rows: readonly Row[] | undefined,
  labels: ProxyAccountLabels,
): readonly Row[] | undefined {
  return rows?.map((row) => {
    const label = labels.get(row.accountKey);
    return label === undefined ? row : { ...row, label };
  });
}

function labelChat(chat: CostChatRow, labels: ProxyAccountLabels): CostChatRow {
  const proxyAccounts = labelRows(chat.proxyAccounts, labels);
  return proxyAccounts ? { ...chat, proxyAccounts } : chat;
}

function labelItems(
  items: readonly CostAttributedItem[],
  labels: ProxyAccountLabels,
): readonly CostAttributedItem[] {
  return items.map((item) => {
    const proxyAccounts = labelRows(item.proxyAccounts, labels);
    return proxyAccounts ? { ...item, proxyAccounts } : item;
  });
}

function itemsName(items: readonly CostAttributedItem[]): boolean {
  return items.some((item) => (item.proxyAccounts?.length ?? 0) > 0);
}

/** Whether a view names any proxy account, so labels are worth reading. */
export function scopeViewNamesProxyAccounts(view: CostScopeView): boolean {
  return view.chats.some((chat) => (chat.proxyAccounts?.length ?? 0) > 0);
}

export function chatViewNamesProxyAccounts(view: CostChatView): boolean {
  switch (view.kind) {
    case 'summary':
      return (view.chat.proxyAccounts?.length ?? 0) > 0;
    case 'subagent':
      return (
        (view.chat.proxyAccounts?.length ?? 0) > 0 ||
        (view.item.proxyAccounts?.length ?? 0) > 0
      );
    case 'full':
      return (
        (view.breakdown.chat.proxyAccounts?.length ?? 0) > 0 ||
        itemsName(view.breakdown.bySource.subagents.items) ||
        itemsName(view.breakdown.bySource.delegations.items)
      );
  }
}

export function pipelineRunViewNamesProxyAccounts(
  view: PipelineRunCostView,
): boolean {
  return (
    (view.byProxyAccount?.length ?? 0) > 0 ||
    view.steps.some((step) => (step.proxyAccounts?.length ?? 0) > 0) ||
    itemsName(view.subagents) ||
    itemsName(view.delegations)
  );
}

export function labelScopeView(
  view: CostScopeView,
  labels: ProxyAccountLabels,
): CostScopeView {
  return { ...view, chats: view.chats.map((chat) => labelChat(chat, labels)) };
}

export function labelChatView(
  view: CostChatView,
  labels: ProxyAccountLabels,
): CostChatView {
  switch (view.kind) {
    case 'summary':
      return { ...view, chat: labelChat(view.chat, labels) };
    case 'subagent': {
      const proxyAccounts = labelRows(view.item.proxyAccounts, labels);
      return {
        ...view,
        chat: labelChat(view.chat, labels),
        item: proxyAccounts ? { ...view.item, proxyAccounts } : view.item,
      };
    }
    case 'full': {
      const { breakdown } = view;
      return {
        ...view,
        breakdown: {
          ...breakdown,
          chat: labelChat(breakdown.chat, labels),
          bySource: {
            ...breakdown.bySource,
            subagents: {
              ...breakdown.bySource.subagents,
              items: labelItems(breakdown.bySource.subagents.items, labels),
            },
            delegations: {
              ...breakdown.bySource.delegations,
              items: labelItems(breakdown.bySource.delegations.items, labels),
            },
          },
        },
      };
    }
  }
}

export function labelPipelineRunView(
  view: PipelineRunCostView,
  labels: ProxyAccountLabels,
): PipelineRunCostView {
  const byProxyAccount = labelRows(view.byProxyAccount, labels);
  return {
    ...view,
    steps: view.steps.map((step) => {
      const proxyAccounts = labelRows(step.proxyAccounts, labels);
      return proxyAccounts ? { ...step, proxyAccounts } : step;
    }),
    subagents: labelItems(view.subagents, labels),
    delegations: labelItems(view.delegations, labels),
    ...(byProxyAccount ? { byProxyAccount } : {}),
  };
}
