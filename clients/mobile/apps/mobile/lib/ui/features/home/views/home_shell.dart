import 'dart:async';
import 'package:mobile/ui/core/navigation/home_chat_destination.dart';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/navigation/home_back_handlers.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';
import 'package:mobile/ui/features/account/views/account_screen.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'package:mobile/ui/core/navigation/home_recent_chat_controller.dart';
import 'package:mobile/ui/features/home/views/activity_refresh_binding.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/home/views/organization_context_gate.dart';
import 'package:mobile/ui/features/home/views/widgets/home_navigation_drawer.dart';
import 'package:mobile/ui/core/navigation/home_extra_destination.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/features/home/views/widgets/workspace_context_switcher.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_screen.dart';
import 'package:mobile/ui/core/navigation/home_orchestrator_destination.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/stats/views/stats_screen.dart';

/// How far the visible content card gets pushed off-screen never exceeds this
/// menu width, so tablets keep a reachable card edge.
const double _maxMenuWidth = 360;

/// Horizontal gutter the content card keeps on-screen while the menu is open.
const double _cardPeek = 64;

/// Width of the topmost strip that gives edge-originating drawer gestures
/// priority over horizontal content such as the Usage tab pager.
const double _edgeDragZoneWidth = 24;

/// Corner radius of the content card when the menu is fully open.
const double _openCardRadius = 28;

/// Drag speeds past this many pixels per second fling the menu in the drag
/// direction instead of settling to the nearest endpoint.
const double _flingVelocity = 365;

/// Authenticated app shell: ChatGPT-style slide-behind navigation between the
/// destinations the current [HomeTabController] exposes. The menu panel sits
/// underneath the main content; opening it slides the content aside as a
/// rounded, dimmed card. Each screen keeps its state via [IndexedStack].
///
/// The visible set is not fixed. A user with no organization gets a shorter
/// menu (see [noOrganizationHomeTabs]), so the shell renders whatever
/// [HomeTabController.tabs] lists rather than a hard-coded five.
class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.refreshActivity,
    required this.activityAccount,
    this.membersTab = const MembersScreen(),
    this.accountTab = const AccountScreen(),
  });

  /// Reloads Activity from the given context (see [ActivityRefreshBinding]).
  final void Function(BuildContext context) refreshActivity;

  /// Reads the account facts Activity shows from the given context. Activity
  /// calls it while it builds, so a watch there rebuilds Activity when they
  /// change.
  final ActivityAccount Function(BuildContext context) activityAccount;

  /// Content for [HomeTab.members].
  ///
  /// Defaults to the real [MembersScreen], which requires an org-scoped
  /// `MembersViewModel`. The no-organization shell swaps in a substitute that
  /// needs no such provider, which is what keeps that shell from reaching for
  /// org-scoped data it cannot have.
  final Widget membersTab;

  /// Content for [HomeTab.account] (Settings).
  ///
  /// Defaults to the real [AccountScreen], which reads the account-security
  /// view models. The guest shell (CAN-2872) swaps in a guest Settings page,
  /// because a guest has no sign-in methods, two-factor or API keys to show.
  final Widget accountTab;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell>
    with SingleTickerProviderStateMixin {
  late final AnimationController _menu = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
    reverseDuration: const Duration(milliseconds: 250),
  );
  HomeTabController? _tabController;

  final _backHandlers = HomeBackHandlers();
  late final _recentChat = HomeRecentChatController()
    ..addListener(_recentChatChanged);

  void _recentChatChanged() {
    setState(() {});
    _syncRemoteVisibility();
  }

  /// Whether the app-composed [HomeExtraDestination] covers the selected tab.
  /// It mounts on first open and then keeps its state like a tab does.
  bool _extraSelected = false;
  bool _extraMounted = false;
  HomeTab? get _visibleTab =>
      _extraSelected || _recentChat.page != null ? null : _tabController?.value;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final tabController = context.read<HomeTabController>();
    if (identical(tabController, _tabController)) return;

    if (_tabController == null) {
      _extraSelected =
          HomeExtraDestination.maybeOf(context)?.takeInitialSelection?.call() ??
          false;
      _extraMounted = _extraSelected;
    }
    _tabController?.removeListener(_handleTabChanged);
    _tabController = tabController..addListener(_handleTabChanged);
    _syncRemoteVisibility();
  }

  @override
  void dispose() {
    _recentChat.removeListener(_recentChatChanged);
    _recentChat.dispose();
    _tabController?.removeListener(_handleTabChanged);
    _menu.dispose();
    super.dispose();
  }

  void _handleTabChanged() {
    _recentChat.close();
    // Selecting a tab, even the one under it, leaves the extra destination.
    if (_extraSelected) setState(() => _extraSelected = false);
    _syncRemoteVisibility();
    if (!_menu.isDismissed) _closeMenu();
  }

  void _syncRemoteVisibility() {
    context.read<RemoteControlViewModel>().setRemoteVisible(
      _visibleTab == HomeTab.remote,
    );
  }

  void _openMenu() {
    if (_menu.isDismissed) _refreshRecents();
    _menu.fling(velocity: 1);
  }

  void _refreshRecents() {
    final source = context.read<HomeRecentChatsSource?>();
    if (source != null) unawaited(source.refresh());
  }

  void _openExtraDestination() {
    _recentChat.close();
    setState(() {
      _extraSelected = true;
      _extraMounted = true;
    });
    _syncRemoteVisibility();
    _closeMenu();
  }

  void _leaveExtraDestination() {
    setState(() => _extraSelected = false);
    _syncRemoteVisibility();
  }

  void _closeMenu() {
    _menu.fling(velocity: -1);
  }

  /// The drawer's Chat button shows the Chat destination; Home keeps its
  /// unsent draft.
  void _openNewChat() {
    // Selecting always notifies, which closes the menu.
    _tabController?.select(HomeTab.chat);
  }

  /// Opens a chat from the drawer's Recents inside the shell. The shell's
  /// context, not the drawer's: the drawer unmounts as it closes.
  void _openRecentChat(HomeRecentChat chat) {
    _closeMenu();
    unawaited(_recentChat.open(chat, context));
  }

  void _dragMenu(DragUpdateDetails details, double menuWidth) {
    if (_menu.isDismissed && (details.primaryDelta ?? 0) > 0) {
      _refreshRecents();
    }
    _menu.value += (details.primaryDelta ?? 0) / menuWidth;
  }

  void _settleMenu(DragEndDetails details, double menuWidth) {
    final velocity = details.velocity.pixelsPerSecond.dx;
    if (velocity.abs() >= _flingVelocity) {
      _menu.fling(velocity: velocity / menuWidth);
    } else {
      _menu.fling(velocity: _menu.value >= 0.5 ? 1 : -1);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tabController = context.watch<HomeTabController>();
    final tabs = tabController.tabs;
    final extra = HomeExtraDestination.maybeOf(context);
    final showsRecent = _recentChat.page != null;
    final showsExtra = extra != null && _extraSelected && !showsRecent;
    final outlineColor = Theme.of(context).colorScheme.outlineVariant;
    return Scaffold(
      backgroundColor: HomeNavigationDrawer.backgroundColorOf(context),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final menuWidth = math.min(
            _maxMenuWidth,
            math.max(0, constraints.maxWidth - _cardPeek).toDouble(),
          );
          return AnimatedBuilder(
            animation: _menu,
            builder: (context, _) {
              final t = _menu.value;
              final menuVisible = t > 0;
              final parentTab = _parentTabOf(tabController.value);
              // The shell is the app's root, so system back never pops it:
              // with nothing to unwind, back does nothing instead of
              // closing the app on Android.
              return PopScope(
                canPop: false,
                onPopInvokedWithResult: (didPop, _) {
                  if (didPop) return;
                  if (menuVisible) {
                    _closeMenu();
                  } else if (_backHandlers.consume()) {
                    return;
                  } else if (showsRecent) {
                    _recentChat.close();
                  } else if (showsExtra) {
                    _leaveExtraDestination();
                  } else if (parentTab != null) {
                    _tabController?.select(parentTab);
                  }
                },
                // Keep one recognizer above the changing menu/card subtree so
                // revealing the drawer cannot dispose an in-flight drag.
                child: GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onHorizontalDragUpdate: (details) =>
                      _dragMenu(details, menuWidth),
                  onHorizontalDragEnd: (details) =>
                      _settleMenu(details, menuWidth),
                  child: Stack(
                    children: [
                      if (menuVisible)
                        Positioned(
                          key: const ValueKey('home-navigation-drawer-slot'),
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: menuWidth,
                          // Gentle parallax: the menu drifts in from the left as
                          // the card slides away, landing flush at the edge.
                          child: Transform.translate(
                            offset: Offset(-(1 - t) * menuWidth * 0.25, 0),
                            child: _RecentChatsBuilder(
                              builder: (context, recentChats, notice) {
                                final remoteConnected = context
                                    .select<RemoteControlViewModel, bool>(
                                      (remote) => remote.isConnected,
                                    );
                                return HomeNavigationDrawer(
                                  extraDestination: extra == null
                                      ? null
                                      : HomeNavigationDrawerRow(
                                          key: const ValueKey(
                                            'home-nav-computer-connect',
                                          ),
                                          glyph: CanopyGlyph.macbook,
                                          label: extra.label,
                                          subtitle: extra.subtitle,
                                          selected: showsExtra,
                                          onTap: _openExtraDestination,
                                        ),
                                  contextRow: const WorkspaceContextRow(),
                                  tabs: [
                                    for (final tab in tabs)
                                      if (tab != HomeTab.remote ||
                                          remoteConnected)
                                        tab,
                                  ],
                                  selectedTab: showsExtra || showsRecent
                                      ? null
                                      : tabController.value,
                                  onSelected: (tab) {
                                    tabController.select(tab);
                                    _closeMenu();
                                  },
                                  recentChats: recentChats,
                                  recentChatsNotice: notice,
                                  onOpenChat: _openRecentChat,
                                  onNewChat: tabs.contains(HomeTab.chat)
                                      ? _openNewChat
                                      : null,
                                  // Selecting always notifies, which
                                  // closes the menu.
                                  onOpenSettings: tabs.contains(HomeTab.account)
                                      ? () => tabController.select(
                                          HomeTab.account,
                                        )
                                      : null,
                                );
                              },
                            ),
                          ),
                        ),
                      Positioned.fill(
                        key: const ValueKey('home-content-slot'),
                        child: Transform.translate(
                          offset: Offset(menuWidth * t, 0),
                          child: DecoratedBox(
                            // Foreground so the hairline and the open-menu
                            // tint paint over the card's own content right at
                            // the clipped edge. The tint lives HERE, as a
                            // rounded fill, rather than as a full-rect child
                            // inside the clip: Impeller does not apply a
                            // rounded ClipRRect to content painted after a
                            // BackdropFilter (the app bar) unless the whole
                            // card goes through a save layer, which used to
                            // cost a full offscreen composite on every frame
                            // of the slide.
                            position: DecorationPosition.foreground,
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(
                                _openCardRadius * t,
                              ),
                              // Lift the card slightly in dark mode and dim it
                              // slightly in light mode.
                              color: !menuVisible
                                  ? null
                                  : Theme.of(context).brightness ==
                                        Brightness.dark
                                  ? Colors.white.withValues(alpha: 0.08 * t)
                                  : Colors.black.withValues(alpha: 0.15 * t),
                              border: menuVisible
                                  ? Border.all(
                                      color: outlineColor.withValues(
                                        alpha: outlineColor.a * t,
                                      ),
                                    )
                                  : null,
                            ),
                            child: ClipRRect(
                              // A plain clip layer: no offscreen save layer for
                              // the whole card on every frame of the slide.
                              clipBehavior: Clip.antiAlias,
                              borderRadius: BorderRadius.circular(
                                _openCardRadius * t,
                              ),
                              child: Stack(
                                fit: StackFit.expand,
                                children: [
                                  ExcludeSemantics(
                                    excluding: menuVisible,
                                    child: FocusScope(
                                      key: const ValueKey(
                                        'home-content-focus-scope',
                                      ),
                                      canRequestFocus: !menuVisible,
                                      // The card is translated every frame of
                                      // the slide; its own layer lets the
                                      // raster cache reuse the tab content
                                      // (and its blurred app bar) instead of
                                      // redrawing it per frame.
                                      child: RepaintBoundary(
                                        key: const ValueKey(
                                          'home-content-repaint-boundary',
                                        ),
                                        child: HomeNavigationScope(
                                          openDrawer: _openMenu,
                                          backHandlers: _backHandlers,
                                          contentVisible: !menuVisible,
                                          child: IndexedStack(
                                            index: showsRecent
                                                ? tabs.length +
                                                      (extra != null &&
                                                              _extraMounted
                                                          ? 1
                                                          : 0)
                                                : showsExtra
                                                ? tabs.length
                                                : tabController.selectedIndex,
                                            children: [
                                              for (final tab in tabs)
                                                _contentFor(tab),
                                              if (extra != null &&
                                                  _extraMounted)
                                                Builder(
                                                  key: const ValueKey(
                                                    'home-extra-destination',
                                                  ),
                                                  builder: extra.pageBuilder,
                                                ),
                                              if (_recentChat.page
                                                  case final page?)
                                                KeyedSubtree(
                                                  key: ObjectKey(page),
                                                  child: page,
                                                ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  // While the menu is open the card is inert:
                                  // this scrim swallows every pointer and
                                  // tapping or dragging it closes the menu. It
                                  // paints nothing; the tint is the card's
                                  // rounded foreground decoration above.
                                  if (menuVisible)
                                    Semantics(
                                      button: true,
                                      label: 'Close navigation menu',
                                      child: GestureDetector(
                                        key: const ValueKey('home-menu-scrim'),
                                        behavior: HitTestBehavior.opaque,
                                        onTap: _closeMenu,
                                        child: const SizedBox.expand(),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      // Stay above horizontal descendants in the gesture arena
                      // so the established edge swipe works over pagers. The
                      // enclosing recognizer remains mounted across rebuilds
                      // and handles drags that begin outside this edge zone.
                      Positioned(
                        key: const ValueKey('home-edge-drag-zone'),
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: _edgeDragZoneWidth,
                        child: GestureDetector(
                          behavior: HitTestBehavior.translucent,
                          onHorizontalDragUpdate: (details) =>
                              _dragMenu(details, menuWidth),
                          onHorizontalDragEnd: (details) =>
                              _settleMenu(details, menuWidth),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }

  /// Built once, so the menu-slide and theme rebuilds of the shell do not
  /// rebuild Activity. Its account and refresh forward to the current
  /// [HomeShell.activityAccount] and [HomeShell.refreshActivity].
  late final Widget _activityScreen = _ActivityScreen(
    account: _activityAccount,
    refresh: _refreshActivity,
  );

  ActivityAccount _activityAccount(BuildContext context) =>
      widget.activityAccount(context);

  void _refreshActivity(BuildContext context) =>
      widget.refreshActivity(context);

  /// Account for the [settingsHomeTabs], which are opened from it (CAN-3558);
  /// null for top-level destinations and shells without Account.
  HomeTab? _parentTabOf(HomeTab tab) =>
      settingsHomeTabs.contains(tab) &&
          (_tabController?.tabs.contains(HomeTab.account) ?? false)
      ? HomeTab.account
      : null;

  /// A tear-off, not a closure, so the scope stays equal across the rebuilds
  /// of every menu-slide frame and does not notify its dependents.
  void _backToAccount() => _tabController?.select(HomeTab.account);

  Widget _contentFor(HomeTab tab) => _parentTabOf(tab) == null
      ? _screenFor(tab)
      : HomeNavigationScope(
          openDrawer: _openMenu,
          goBack: _backToAccount,
          child: _screenFor(tab),
        );

  Widget _screenFor(HomeTab tab) => switch (tab) {
    HomeTab.activity => _activityScreen,
    HomeTab.usage => const OrganizationContextGate(
      title: 'Usage',
      child: StatsScreen(),
    ),
    HomeTab.members => OrganizationContextGate(
      title: 'Members',
      child: widget.membersTab,
    ),
    HomeTab.advisor =>
      HomeOrchestratorDestination.maybeOf(
            context,
          )?.builder(context, _visibleTab == HomeTab.advisor) ??
          RemoteAppAdvisorScreen(isActive: _visibleTab == HomeTab.advisor),
    HomeTab.remote => const RemoteScreen(),
    HomeTab.account => widget.accountTab,
    HomeTab.chat =>
      HomeChatDestination.maybeOf(context)?.builder(context) ??
          widget.accountTab,
  };
}

/// Reads the drawer's Recents from the app-composed [HomeRecentChatsSource],
/// rebuilding only the drawer subtree when it changes.
class _RecentChatsBuilder extends StatelessWidget {
  const _RecentChatsBuilder({required this.builder});

  /// Builds the drawer from Recents and loading or empty feedback.
  final Widget Function(
    BuildContext context,
    List<HomeRecentChat> recentChats,
    Widget? notice,
  )
  builder;

  @override
  Widget build(BuildContext context) {
    final source = context.watch<HomeRecentChatsSource?>();
    final workspaceContext = context.watch<WorkspaceContext?>();
    if (source == null) return builder(context, const [], null);
    final recents = source.read(
      workspaceContext ?? const WorkspaceContext.personal(),
    );
    final label =
        context.watch<WorkspaceContextLabel?>()?.value ??
        WorkspaceContextLabel.fallback(workspaceContext);
    final Widget? notice;
    if (recents.chats.isNotEmpty || !recents.connected) {
      notice = null;
    } else if (recents.loading) {
      notice = const ChatListNotice(
        message: 'Loading chats from your computers…',
      );
    } else {
      notice = ChatListNotice(message: 'No recent chats in $label.');
    }
    return builder(context, recents.chats, notice);
  }
}

/// The account facts Activity shows (CAN-3715): whether Personal is the
/// active context, the selected team's name for the sharing notice, and the
/// action that selects Personal, null when the account has no Personal
/// organization.
typedef ActivityAccount = ({
  bool isPersonalActive,
  String? organizationName,
  VoidCallback? viewPersonal,
});

/// Activity as the shell composes it (CAN-3715): reloaded when the user comes
/// back to it, with the account facts its sharing notice needs. The shell owns
/// tab navigation and account switching, so the feed imports neither.
///
/// Personal shows the Personal organization's feed. Without a Personal
/// organization, Personal asks for an organization (CAN-4429), like Usage and
/// Members.
class _ActivityScreen extends StatelessWidget {
  const _ActivityScreen({required this.account, required this.refresh});

  final ActivityAccount Function(BuildContext context) account;
  final void Function(BuildContext context) refresh;

  @override
  Widget build(BuildContext context) {
    final account = this.account(context);
    final activity = ActivityRefreshBinding(
      refresh: refresh,
      child: FeedScreen(
        organizationName: account.organizationName,
        onViewPersonal: account.viewPersonal,
      ),
    );
    if (account.isPersonalActive) return activity;
    return OrganizationContextGate(title: 'Timeline', child: activity);
  }
}
