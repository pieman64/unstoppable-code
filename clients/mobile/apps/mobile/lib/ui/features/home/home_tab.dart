/// The side-navigation destinations the authenticated shell can show.
///
/// Tabs are referred to by identity rather than by index because the visible
/// set varies: a user with no organization sees a shorter bar, so a raw index
/// no longer names a fixed destination.
///
/// [chat] is the new-chat destination the app opens on (CAN-2930). It has no
/// row in the menu list; the drawer's pinned Chat button selects it. It sits
/// last in every tab list so list order keeps describing the menu rows.
///
/// [advisor] is the paired desktop's App Advisor (CAN-3989). It sits directly
/// above [remote] wherever Remote Control is offered, as Advisor leads Remote
/// Control in the desktop and web nav.
///
/// [account] is the Settings page (CAN-4449). It has no row either; the
/// drawer's pinned Settings cog selects it. [activity], [usage], and
/// [members] are opened from Settings instead of from a row (see
/// [settingsHomeTabs]).
enum HomeTab { activity, usage, members, cloud, advisor, remote, account, chat }

/// Destinations opened from Settings, which the drawer's Settings cog opens,
/// instead of from a drawer row (CAN-3558), in the order Settings lists them.
///
/// They stay shell destinations, so their org-scoped providers, kept state,
/// and deep links work unchanged; each shows a back button to Settings.
const List<HomeTab> settingsHomeTabs = [
  HomeTab.activity,
  HomeTab.usage,
  HomeTab.members,
];

/// Tabs shown when an organization is resolved: the full app.
///
/// Drawer rows lead, then Account and the [settingsHomeTabs] it lists, the
/// same shape as [noOrganizationHomeTabs].
const List<HomeTab> organizationHomeTabs = [
  HomeTab.cloud,
  HomeTab.advisor,
  HomeTab.remote,
  HomeTab.account,
  HomeTab.activity,
  HomeTab.usage,
  HomeTab.members,
  HomeTab.chat,
];

/// Tabs shown in Personal to an account with a Personal organization and no
/// team organization (CAN-3715).
///
/// Activity shows the viewer's own work through the Personal organization's
/// feed. Usage is left out until mobile has Personal statistics, and Members
/// leads to invitations and team creation.
const List<HomeTab> personalHomeTabs = [
  HomeTab.cloud,
  HomeTab.advisor,
  HomeTab.remote,
  HomeTab.account,
  HomeTab.activity,
  HomeTab.members,
  HomeTab.chat,
];

/// Tabs shown to a signed-in user who belongs to no organization (CAN-2576).
///
/// Activity and Usage are dropped because their APIs are org-scoped
/// (`/api/account/organizations/{orgId}/...`) and have no personal equivalent —
/// there is nothing honest to render. Remote Control is device/user-scoped and
/// Account is account-scoped, so both work as-is; Remote leads because it is
/// what the app is for. Members is kept last as the home for pending
/// invitations and the create-an-organization CTA.
///
/// Cloud chats (CAN-3143) are account-scoped too and sit directly before
/// Remote in every shell. This interim entry point is filtered out by
/// `visibleHomeTabs` once the server reports cloud agents unavailable, and is
/// superseded by CAN-2930/CAN-2931.
const List<HomeTab> noOrganizationHomeTabs = [
  HomeTab.cloud,
  HomeTab.advisor,
  HomeTab.remote,
  HomeTab.account,
  HomeTab.members,
  HomeTab.chat,
];

/// Tabs shown to a guest (CAN-2872): cloud chats and Settings, where the
/// guest signs in to keep their chats.
///
/// Remote Control and App Advisor need a paired desktop, which needs an
/// account, and the organization destinations have nothing to show a guest.
const List<HomeTab> guestHomeTabs = [
  HomeTab.cloud,
  HomeTab.account,
  HomeTab.chat,
];

/// Where the guest shell opens when cloud chats are unavailable: Settings,
/// which offers sign-in, rather than an empty app.
const HomeTab guestLandingTab = HomeTab.account;

/// Where the no-organization shell opens when cloud chats are unavailable;
/// otherwise every shell opens on [HomeTab.chat].
///
/// Solo accounts start with their desktop connection: pairing instructions
/// when disconnected, or their workspaces when a session is restored.
/// Organization creation and invitations remain optional under Members.
const HomeTab noOrganizationLandingTab = HomeTab.remote;

/// Where the shell opens when organization membership could not be loaded
/// and cloud chats are unavailable.
///
/// Unlike a confirmed no-organization account, this state must not offer a
/// create-organization CTA because the user may already belong to one.
const HomeTab organizationsUnavailableLandingTab = HomeTab.account;

/// Where the full shell opens when cloud chats are unavailable.
///
/// Remote, like a solo account: Activity is opened from Account now
/// (CAN-3558), and opening the app on a Settings page would be backwards.
const HomeTab organizationLandingTab = HomeTab.remote;
