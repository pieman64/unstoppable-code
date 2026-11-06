/* Controlled Secret Service for the gated Linux golden. Never ship this fixture.
 * All bytes are synthetic; only method names and booleans leave this process.
 */
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define SS "org.freedesktop.Secret"
#define ROOT "/org/freedesktop/secrets"
#define COL ROOT "/collection/qualification"
#define ITEM COL "/item1"
#define SESSION ROOT "/session/qualification"
#define PROMPT ROOT "/prompt/qualification"
static GDBusConnection *bus;
static GMainLoop *loop;
static gboolean locked = FALSE, present = FALSE, hold_prompt = FALSE;
static GDBusMethodInvocation *pending, *pending_search, *pending_prompt;
static gboolean hold_search = FALSE;
static char *pending_method;
static guint submissions = 0, mutations = 0, dismiss_calls = 0;

static void event(const char *name) {
    printf("{\"event\":\"%s\",\"at_us\":%" G_GINT64_FORMAT "}\n", name, g_get_monotonic_time()); fflush(stdout);
}
static void fail(const char *stage, GError *error) {
    /* Don't print GError messages: providers may put attributes in them. */
    fprintf(stderr, "fixture failure at %s (domain=%u code=%d)\n", stage,
            error ? error->domain : 0, error ? error->code : 0);
    if (error) g_error_free(error);
    _exit(2);
}
static void guard(void) {
    const char *root = g_getenv("CAN4503_FIXTURE_ROOT");
    const char *address = g_getenv("DBUS_SESSION_BUS_ADDRESS");
    if (!root || !g_str_has_prefix(root, "/tmp/can4503-") || !address)
        fail("private-session-guard", NULL);
    char *prefix = g_strdup_printf("unix:path=%s/bus", root);
    const char *suffix = address + MIN(strlen(address), strlen(prefix));
    gboolean valid_suffix = !*suffix;
    if (g_str_has_prefix(suffix, ",guid=") && strlen(suffix + 6) == 32) {
        valid_suffix = TRUE;
        for (const char *p = suffix + 6; *p; ++p)
            if (!g_ascii_isxdigit(*p)) valid_suffix = FALSE;
    }
    if (!g_str_has_prefix(address, prefix) || !valid_suffix || strstr(root, ".."))
        fail("private-address-guard", NULL);
    g_free(prefix);
}
static GVariant *paths(gboolean include_item) {
    GVariantBuilder b;
    g_variant_builder_init(&b, G_VARIANT_TYPE("ao"));
    if (include_item) g_variant_builder_add(&b, "o", ITEM);
    return g_variant_builder_end(&b);
}
static GVariant *secret(void) {
    guint8 bytes[] = { 1, 7, 3, 9 };
    return g_variant_new("(o@ay@ays)", SESSION,
        g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, NULL, 0, 1),
        g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, bytes, sizeof bytes, 1),
        "application/octet-stream");
}
static void completed(gboolean dismissed) {
    GError *error = NULL;
    g_dbus_connection_emit_signal(bus, NULL, PROMPT, SS ".Prompt", "Completed",
        g_variant_new("(bv)", dismissed, g_variant_new_objv((const char *[]){ COL, NULL }, dismissed ? 0 : 1)), &error);
    if (error) fail("completed", error);
    event(dismissed ? "dismiss-ack" : "unlock-ack");
}
static void commit_pending(void) {
    if (!pending) { event("nothing-pending"); return; }
    present = strcmp(pending_method, "Delete") != 0;
    mutations++;
    event("mutation-landed");
    if (g_dbus_connection_is_closed(bus)) { /* Still processed despite transport loss. */ }
    else if (!strcmp(pending_method, "CreateItem"))
        g_dbus_method_invocation_return_value(pending, g_variant_new("(oo)", ITEM, "/"));
    else if (!strcmp(pending_method, "Delete"))
        g_dbus_method_invocation_return_value(pending, g_variant_new("(o)", "/"));
    else g_dbus_method_invocation_return_value(pending, g_variant_new("()"));
    g_object_unref(pending); pending = NULL;
    g_clear_pointer(&pending_method, g_free);
}
static void method(GDBusConnection *connection, const char *sender, const char *path,
                   const char *iface, const char *name, GVariant *params,
                   GDBusMethodInvocation *call, gpointer data) {
    (void)connection; (void)sender; (void)path; (void)iface; (void)data;
    if (!strcmp(name, "OpenSession")) {
        const char *algorithm;
        GVariant *input;
        g_variant_get(params, "(&s@v)", &algorithm, &input);
        g_variant_unref(input);
        if (strcmp(algorithm, "plain")) {
            g_dbus_method_invocation_return_dbus_error(call,
                "org.freedesktop.DBus.Error.NotSupported", "Fixture supports plain only");
        } else g_dbus_method_invocation_return_value(call,
            g_variant_new("(vo)", g_variant_new_string(""), SESSION));
    } else if (!strcmp(name, "ReadAlias")) {
        g_dbus_method_invocation_return_value(call, g_variant_new("(o)", COL));
    } else if (!strcmp(name, "SearchItems")) {
        if (hold_search) { pending_search = g_object_ref(call); event("read-submitted"); return; }
        if (!strcmp(iface, SS ".Service"))
            g_dbus_method_invocation_return_value(call,
                g_variant_new("(@ao@ao)", paths(present && !locked), paths(present && locked)));
        else g_dbus_method_invocation_return_value(call, g_variant_new("(@ao)", paths(present)));
    } else if (!strcmp(name, "Unlock")) {
        event("unlock-called");
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("ao"));
        if (!locked) g_variant_builder_add(&b, "o", COL);
        g_dbus_method_invocation_return_value(call,
            g_variant_new("(@aoo)", g_variant_builder_end(&b), locked ? PROMPT : "/"));
    } else if (!strcmp(name, "Prompt")) {
        event("prompt-called");
        if (hold_prompt) pending_prompt = g_object_ref(call);
        else g_dbus_method_invocation_return_value(call, g_variant_new("()"));
    } else if (!strcmp(name, "Dismiss")) {
        dismiss_calls++; event("dismiss-called");
        g_dbus_method_invocation_return_value(call, g_variant_new("()"));
        completed(TRUE);
    } else if (!strcmp(name, "GetSecret")) {
        g_dbus_method_invocation_return_value(call, g_variant_new("(@(oayays))", secret()));
    } else if (!strcmp(name, "CreateItem") || !strcmp(name, "SetSecret") || !strcmp(name, "Delete")) {
        submissions++;
        if (pending) {
            g_dbus_method_invocation_return_dbus_error(call, SS ".Error.IsLocked", "Fixture busy");
        } else {
            pending = g_object_ref(call);
            pending_method = g_strdup(name);
            event("mutation-submitted");
            /* Deliberately no reply until the controller says release. */
        }
    } else if (!strcmp(name, "Close")) {
        g_dbus_method_invocation_return_value(call, g_variant_new("()"));
    } else g_dbus_method_invocation_return_dbus_error(call,
            "org.freedesktop.DBus.Error.UnknownMethod", "Unsupported fixture method");
}
static GVariant *property(GDBusConnection *connection, const char *sender,
                         const char *path, const char *iface, const char *name,
                         GError **error, gpointer data) {
    (void)connection; (void)sender; (void)path; (void)iface; (void)error; (void)data;
    if (!strcmp(name, "Collections")) {
        const char *p[] = { COL, NULL };
        return g_variant_new_objv(p, -1);
    }
    if (!strcmp(name, "Items")) return paths(present);
    if (!strcmp(name, "Locked")) return g_variant_new_boolean(locked);
    if (!strcmp(name, "Label")) return g_variant_new_string("CAN-4503 disposable");
    if (!strcmp(name, "Created") || !strcmp(name, "Modified")) return g_variant_new_uint64(1);
    if (!strcmp(name, "Attributes")) {
        GVariantBuilder b;
        g_variant_builder_init(&b, G_VARIANT_TYPE("a{ss}"));
        g_variant_builder_add(&b, "{ss}", "qualification", "can-4503");
        return g_variant_builder_end(&b);
    }
    return NULL;
}
static const char *xml =
"<node>"
"<interface name='org.freedesktop.Secret.Service'>"
"<method name='OpenSession'><arg type='s' direction='in'/><arg type='v' direction='in'/><arg type='v' direction='out'/><arg type='o' direction='out'/></method>"
"<method name='ReadAlias'><arg type='s' direction='in'/><arg type='o' direction='out'/></method>"
"<method name='SearchItems'><arg type='a{ss}' direction='in'/><arg type='ao' direction='out'/><arg type='ao' direction='out'/></method>"
"<method name='Unlock'><arg type='ao' direction='in'/><arg type='ao' direction='out'/><arg type='o' direction='out'/></method>"
"<property name='Collections' type='ao' access='read'/></interface>"
"<interface name='org.freedesktop.Secret.Collection'>"
"<method name='SearchItems'><arg type='a{ss}' direction='in'/><arg type='ao' direction='out'/></method>"
"<method name='CreateItem'><arg type='a{sv}' direction='in'/><arg type='(oayays)' direction='in'/><arg type='b' direction='in'/><arg type='o' direction='out'/><arg type='o' direction='out'/></method>"
"<property name='Items' type='ao' access='read'/><property name='Label' type='s' access='read'/><property name='Locked' type='b' access='read'/><property name='Created' type='t' access='read'/><property name='Modified' type='t' access='read'/></interface>"
"<interface name='org.freedesktop.Secret.Item'>"
"<method name='GetSecret'><arg type='o' direction='in'/><arg type='(oayays)' direction='out'/></method>"
"<method name='SetSecret'><arg type='(oayays)' direction='in'/></method>"
"<method name='Delete'><arg type='o' direction='out'/></method>"
"<property name='Attributes' type='a{ss}' access='read'/><property name='Label' type='s' access='read'/><property name='Locked' type='b' access='read'/><property name='Created' type='t' access='read'/><property name='Modified' type='t' access='read'/></interface>"
"<interface name='org.freedesktop.Secret.Session'><method name='Close'/></interface>"
"<interface name='org.freedesktop.Secret.Prompt'><method name='Prompt'><arg type='s' direction='in'/></method><method name='Dismiss'/><signal name='Completed'><arg type='b'/><arg type='v'/></signal></interface>"
"</node>";
static gboolean command(GIOChannel *channel, GIOCondition condition, gpointer data) {
    (void)condition; (void)data;
    char *line = NULL;
    if (g_io_channel_read_line(channel, &line, NULL, NULL, NULL) != G_IO_STATUS_NORMAL) {
        g_main_loop_quit(loop); return G_SOURCE_REMOVE;
    }
    g_strchomp(line);
    if (!strcmp(line, "release")) commit_pending();
    else if (!strcmp(line, "disconnect")) {
        GError *error = NULL;
        if (!g_dbus_connection_close_sync(bus, NULL, &error)) fail("disconnect", error);
        event("disconnected");
    }
    else if (!strcmp(line, "lock")) { locked = TRUE; event("locked"); }
    else if (!strcmp(line, "hold-search")) { hold_search = TRUE; event("holding-search"); }
    else if (!strcmp(line, "present")) { present = TRUE; event("present"); }
    else if (!strcmp(line, "hold-prompt")) { hold_prompt = TRUE; event("holding-prompt"); }
    else if (!strcmp(line, "prompt-ack")) {
        if (!pending_prompt) fail("no-held-prompt", NULL);
        g_dbus_method_invocation_return_value(pending_prompt, g_variant_new("()"));
        g_clear_object(&pending_prompt); event("prompt-ack");
    }
    else if (!strcmp(line, "release-completed")) completed(TRUE);
    else if (!strcmp(line, "unlock-ack")) { locked = FALSE; completed(FALSE); }
    else if (!strcmp(line, "checkpoint")) {
        printf("{\"event\":\"checkpoint\",\"submissions\":%u,\"mutations\":%u,\"dismissCalls\":%u,\"present\":%s}\n", submissions, mutations, dismiss_calls, present ? "true" : "false"); fflush(stdout);
    } else if (!strcmp(line, "quit")) g_main_loop_quit(loop);
    else fail("unknown-command", NULL);
    g_free(line); return G_SOURCE_CONTINUE;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    GError *error = NULL;
    if (!strcmp(argv[1], "validate-xml")) {
        GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(xml, &error);
        if (!node) fail("introspection", error);
        g_dbus_node_info_unref(node); event("introspection-valid"); return 0;
    }
    guard();
    bus = g_dbus_connection_new_for_address_sync(g_getenv("DBUS_SESSION_BUS_ADDRESS"),
        G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
        NULL, NULL, &error);
    if (!bus) fail("connect", error);
    g_dbus_connection_set_exit_on_close(bus, FALSE);
    loop = g_main_loop_new(NULL, FALSE);
    if (!strcmp(argv[1], "serve")) {
        GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(xml, &error);
        if (!node) fail("introspection", error);
        const GDBusInterfaceVTable vtable = { .method_call = method, .get_property = property };
        const char *p[] = { ROOT, COL, ITEM, SESSION, PROMPT };
        for (guint i = 0; i < G_N_ELEMENTS(p); ++i)
            if (!g_dbus_connection_register_object(bus, p[i], node->interfaces[i], &vtable, NULL, NULL, &error))
                fail("register", error);
        GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.freedesktop.secrets", 4),
            G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);
        if (!reply) fail("name", error);
        guint result; g_variant_get(reply, "(u)", &result); g_variant_unref(reply);
        if (result != 1) fail("name-already-owned", NULL);
        GIOChannel *input = g_io_channel_unix_new(STDIN_FILENO);
        g_io_add_watch(input, G_IO_IN | G_IO_HUP, command, NULL);
        event("service-ready"); g_main_loop_run(loop);
        if (pending) g_object_unref(pending);
        if (pending_prompt) g_object_unref(pending_prompt);
        if (pending_search) g_object_unref(pending_search);
        g_free(pending_method); g_io_channel_unref(input); g_dbus_node_info_unref(node);
    } else return 2;
    g_main_loop_unref(loop); g_object_unref(bus);
    return 0;
}
