/* CAN-4503 PR A: inert Node-API mechanism; no host composes this addon.
 * Accepted Linux policy (Mike, q-26, 2026-11-05): mutations drain even
 * after abort. Transport ambiguity latches this process unavailable, since
 * Secret Service cannot promise that a failed reply prevents a later effect.
 * Concurrency domain is this process, with no file lock. A disconnected
 * provider may still apply a mutation before the next daemon start.
 * Data/secure paths belong to composition (q-25/CAN-5774), never this addon.
 */
#include <node_api.h>
/* Qualified against libsecret 0.21.4. Raw mutation calls use its unstable
 * session encoder to avoid convenience APIs that implicitly follow prompts. */
#define SECRET_API_SUBJECT_TO_CHANGE
#include <libsecret/secret.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define LIMIT 1024
#define TEXT 512
#define SS "org.freedesktop.Secret"
#define ROOT "/org/freedesktop/secrets"
#ifndef SECRET_SERVICE_FIXTURE
#define SECRET_SERVICE_FIXTURE 0
#endif
#include "policy.h"

static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static bool failed = false; /* Protected by gate; never reset or reconnected. */
static _Atomic size_t owned_bytes = 0;
static _Atomic unsigned long api_calls = 0, unlock_calls = 0, prompt_calls = 0, dismiss_calls = 0;
typedef struct request request;
typedef struct { request *head, *tail; } queue;
struct request {
    napi_async_work work;
    napi_deferred deferred;
    napi_ref signal, listener;
    queue *owner;
    request *previous, *next;
    char operation[24], service[TEXT], account[TEXT];
    unsigned char input[LIMIT], output[LIMIT];
    size_t input_len, output_len;
    const char *code;
    bool allowed, submitted, reject_abort;
    _Atomic bool aborted;
    _Atomic int submission; /* 0 preflight, 1 aborted, 2 mutation owned */
    GCancellable *cancel;
    GMainContext *context;
};
static const SecretSchema schema = {
    .name = "org.canopy.VaultSlot.v1", .flags = SECRET_SCHEMA_NONE,
    .attributes = {{"service", SECRET_SCHEMA_ATTRIBUTE_STRING},
                   {"authority", SECRET_SCHEMA_ATTRIBUTE_STRING},
                   {"slot", SECRET_SCHEMA_ATTRIBUTE_STRING}, {NULL, 0}}
};
static void erase(void *memory, size_t size) {
    volatile unsigned char *p = memory;
    while (size--) *p++ = 0;
}
static napi_value undefined(napi_env env) {
    napi_value value; napi_get_undefined(env, &value); return value;
}
static bool text_arg(napi_env env, napi_value value, char *out, size_t size) {
    napi_valuetype type;
    size_t length = 0, copied = 0;
    return napi_typeof(env, value, &type) == napi_ok && type == napi_string &&
        napi_get_value_string_utf8(env, value, NULL, 0, &length) == napi_ok &&
        length > 0 && length < size &&
        napi_get_value_string_utf8(env, value, out, size, &copied) == napi_ok &&
        copied == length && strlen(out) == length;
}
static bool write_op(request *r) {
    return !strcmp(r->operation, "create") || !strcmp(r->operation, "replace") ||
        (SECRET_SERVICE_FIXTURE && (!strcmp(r->operation, "fixture-create") || !strcmp(r->operation, "fixture-empty")));
}
static bool stopped(request *r) {
    if (!atomic_load(&r->aborted)) return false;
    r->reject_abort = true;
    return true;
}
static void complete(napi_env env, napi_status status, void *data);
static napi_value abort_call(napi_env env, napi_callback_info info) {
    request *r = NULL;
    napi_get_cb_info(env, info, NULL, NULL, NULL, (void **)&r);
    int preflight = 0;
    atomic_compare_exchange_strong(&r->submission, &preflight, 1);
    atomic_store(&r->aborted, true);
    /* Unlock has no slot effects; submitted mutations never use this cancel. */
    g_cancellable_cancel(r->cancel);
    g_main_context_wakeup(r->context);
    /* Non-head FIFO entries have never reached libuv or the backend. Do not
     * make their abort wait for the head's unanswered OS prompt. */
    if (r->previous) {
        r->reject_abort = true;
        complete(env, napi_ok, r);
    }
    return undefined(env);
}
static GVariant *call(GDBusConnection *bus, const char *owner, const char *path,
                      const char *iface, const char *method, GVariant *parameters,
                      const GVariantType *reply, GCancellable *cancel, GError **error) {
    atomic_fetch_add(&api_calls, 1);
    return g_dbus_connection_call_sync(bus, owner, path, iface, method,
        parameters, reply, G_DBUS_CALL_FLAGS_NONE, -1, cancel, error);
}
typedef struct { bool done, dismissed, lost; } prompt_state;
static gboolean prompt_bus_tick(gpointer data) {
    (void)data;
    return G_SOURCE_CONTINUE;
}
static void completed(GDBusConnection *bus, const char *sender, const char *path,
                      const char *iface, const char *name, GVariant *parameters, gpointer data) {
    (void)bus; (void)sender; (void)path; (void)iface; (void)name;
    prompt_state *state = data;
    if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(bv)"))) { state->lost = true; return; }
    gboolean dismissed;
    GVariant *result;
    g_variant_get(parameters, "(b@v)", &dismissed, &result);
    g_variant_unref(result);
    state->dismissed = dismissed; state->done = true;
}
static void owner_changed(GDBusConnection *bus, const char *sender, const char *path,
                          const char *iface, const char *name, GVariant *parameters, gpointer data) {
    (void)bus; (void)sender; (void)path; (void)iface; (void)name;
    const char *service, *old_owner, *new_owner;
    g_variant_get(parameters, "(&s&s&s)", &service, &old_owner, &new_owner);
    (void)service; (void)old_owner;
    if (!*new_owner) ((prompt_state *)data)->lost = true;
}
/* q-28: abort never dismisses an OS unlock prompt. Detach our observations
 * and leave its outcome to the user; no slot work can follow an aborted unlock.
 */
static bool unlock(request *r, GDBusConnection *bus, const char *owner,
                   const char *path, GError **error) {
    GVariantBuilder objects;
    g_variant_builder_init(&objects, G_VARIANT_TYPE("ao"));
    g_variant_builder_add(&objects, "o", path);
    atomic_fetch_add(&unlock_calls, 1);
    GVariant *reply = call(bus, owner, ROOT, SS ".Service", "Unlock",
        g_variant_new("(@ao)", g_variant_builder_end(&objects)), G_VARIANT_TYPE("(aoo)"), r->cancel, error);
    if (!reply) return false;
    GVariant *unlocked;
    const char *prompt;
    g_variant_get(reply, "(@ao&o)", &unlocked, &prompt);
    g_variant_unref(unlocked);
    if (stopped(r)) { g_variant_unref(reply); return false; }
    if (!strcmp(prompt, "/")) { g_variant_unref(reply); return !stopped(r); }
    prompt_state state = {0};
    guint subscription = g_dbus_connection_signal_subscribe(bus, owner, SS ".Prompt", "Completed",
        prompt, NULL, G_DBUS_SIGNAL_FLAGS_NONE, completed, &state, NULL);
    guint owner_subscription = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.DBus",
        "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", owner,
        G_DBUS_SIGNAL_FLAGS_NONE, owner_changed, &state, NULL);
    atomic_fetch_add(&prompt_calls, 1);
    GVariant *started = call(bus, owner, prompt, SS ".Prompt", "Prompt",
        g_variant_new("(s)", ""), G_VARIANT_TYPE_UNIT, r->cancel, error);
    bool success = false;
    if (!started) {
        /* Cancellation leaves any opened prompt up, with no slot effects. */
        if (!stopped(r)) failed = true;
    } else {
        g_variant_unref(started);
        /* GIO may deliver shared-bus closure on another, idle context. Bound
         * closed-state rechecks without imposing a lifetime on the OS prompt. */
        GSource *bus_tick = g_timeout_source_new(100);
        g_source_set_callback(bus_tick, prompt_bus_tick, NULL, NULL);
        g_source_attach(bus_tick, r->context);
        while (!state.done && !state.lost && !g_dbus_connection_is_closed(bus)) {
            if (atomic_load(&r->aborted)) break;
            g_main_context_iteration(r->context, TRUE);
        }
        g_source_destroy(bus_tick);
        g_source_unref(bus_tick);
        if (stopped(r)) success = false;
        else success = state.done && !state.dismissed && !state.lost;
        if (state.dismissed) r->code = "denied";
        if (state.lost || g_dbus_connection_is_closed(bus)) failed = true;
    }
    /* Same thread/context as subscription: unsubscribe prevents later callbacks
     * from reaching this stack state, even if Completed was already queued. */
    g_dbus_connection_signal_unsubscribe(bus, subscription);
    g_dbus_connection_signal_unsubscribe(bus, owner_subscription);
    g_variant_unref(reply);
    return success;
}
static void execute(napi_env env, void *data) {
    (void)env;
    request *r = data;
    GError *error = NULL;
    GDBusConnection *bus = NULL;
    SecretService *service = NULL;
    SecretCollection *collection = NULL;
    GHashTable *attributes = NULL;
    GList *items = NULL;
    SecretValue *value = NULL;
    char *owner = NULL;
    pthread_mutex_lock(&gate);
    g_main_context_push_thread_default(r->context);
    r->code = "unavailable";
    if (stopped(r) || failed) goto done;
    /* L-D4: only GIO's default session bus. Resolve it first to distinguish
     * an unusable session from an absent Secret Service. */
    atomic_fetch_add(&api_calls, 1);
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, r->cancel, &error);
    if (!bus) { r->code = "unsupported_session"; goto done; }
    g_dbus_connection_set_exit_on_close(bus, FALSE);
    if (stopped(r)) goto done;
    atomic_fetch_add(&api_calls, 1);
    /* SecretService forces its own bus type: g_initable_new with g-connection
     * aborts inside GDBusProxy, even with G_BUS_TYPE_NONE (GLib 2.80).
     * Use libsecret's supported non-shared service constructor, not its cached
     * service singleton. The underlying GIO connection is shared: never close
     * it on completion/failure and disrupt non-secret services. */
    service = secret_service_open_sync(SECRET_TYPE_SERVICE, NULL,
        SECRET_SERVICE_OPEN_SESSION, r->cancel, &error);
    if (!service) goto done;
    g_clear_object(&bus);
    bus = g_object_ref(g_dbus_proxy_get_connection(G_DBUS_PROXY(service)));
    g_dbus_connection_set_exit_on_close(bus, FALSE);
    owner = g_dbus_proxy_get_name_owner(G_DBUS_PROXY(service));
    if (!owner) goto done;
    if (stopped(r)) goto done;
    atomic_fetch_add(&api_calls, 1);
    collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT,
        SECRET_COLLECTION_NONE, r->cancel, &error);
    if (!collection) goto done; /* Do not create/reset collections on recovery. */
    bool status = !strcmp(r->operation, "status");
    const char *collection_path = g_dbus_proxy_get_object_path(G_DBUS_PROXY(collection));
    if (secret_collection_get_locked(collection)) {
        r->code = "locked";
        if (status || !r->allowed || stopped(r)) goto done;
        if (!unlock(r, bus, owner, collection_path, &error)) goto done;
        /* Re-read properties; cached Locked cannot establish unlock success. */
        g_clear_object(&collection);
        if (stopped(r)) goto done;
        collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT,
            SECRET_COLLECTION_NONE, r->cancel, &error);
        if (!collection || secret_collection_get_locked(collection)) goto done;
    }
    if (status) { r->code = "ok"; goto done; }
    if (stopped(r)) goto done;
    size_t authority_offset = strlen(r->service) + 1;
    char authority[65]; memcpy(authority, r->account + authority_offset, 64); authority[64] = 0;
    attributes = secret_attributes_build(&schema, "service", r->service,
        "authority", authority, "slot", r->account + authority_offset + 65, NULL);
    atomic_fetch_add(&api_calls, 1);
    items = secret_collection_search_sync(collection, &schema, attributes, SECRET_SEARCH_ALL, r->cancel, &error);
    if (error) goto done;
    unsigned count = g_list_length(items);
    if (count > 1 && strcmp(r->operation, "create") && !g_str_has_prefix(r->operation, "fixture-")) { r->code = "corrupt"; goto done; }
    bool fixture = SECRET_SERVICE_FIXTURE && g_str_has_prefix(r->operation, "fixture-");
    if ((!strcmp(r->operation, "create") && count) || (!strcmp(r->operation, "replace") && !count)) {
        r->code = "conflict"; goto done;
    }
    if (!write_op(r) && !count) { r->code = "absent"; goto done; }
    SecretItem *item = count ? SECRET_ITEM(items->data) : NULL;
    if (item && secret_item_get_locked(item)) {
        r->code = "locked";
        if (!r->allowed || stopped(r)) goto done;
        if (!unlock(r, bus, owner, g_dbus_proxy_get_object_path(G_DBUS_PROXY(item)), &error)) goto done;
    }
    if (stopped(r)) goto done;
    if (!strcmp(r->operation, "read")) {
        atomic_fetch_add(&api_calls, 1);
        if (!secret_item_load_secret_sync(item, r->cancel, &error)) goto done;
        value = secret_item_get_secret(item);
        gsize size = 0;
        const char *bytes = value ? secret_value_get(value, &size) : NULL;
        /* GNOME 46.1 normalizes MIME metadata on read. It is not an integrity
         * marker: identity attributes and byte bounds define a key slot. */
        if (!bytes || size < 1 || size > LIMIT) {
            r->code = "corrupt"; goto done;
        }
        memcpy(r->output, bytes, size); r->output_len = size; r->code = "ok";
    } else {
        /* No cancellable after this point. Abort must drain the true reply. */
        int preflight = 0;
        if (!atomic_compare_exchange_strong(&r->submission, &preflight, 2)) {
            r->reject_abort = true; goto done;
        }
        r->submitted = true;
        atomic_fetch_add(&api_calls, 1);
        if (!strcmp(r->operation, "delete")) {
            GVariant *reply = call(bus, owner, g_dbus_proxy_get_object_path(G_DBUS_PROXY(item)),
                SS ".Item", "Delete", NULL, G_VARIANT_TYPE("(o)"), NULL, &error);
            if (reply) {
                const char *prompt; g_variant_get(reply, "(&o)", &prompt);
                /* No implicit prompt following. A provider demanding one after
                 * submission leaves the effect ambiguous: latch, never retry. */
                if (strcmp(prompt, "/")) { r->code = "uncertain"; failed = true; }
                else r->code = "ok";
                g_variant_unref(reply);
            }
        } else {
            value = secret_value_new((const char *)r->input, (SECRET_SERVICE_FIXTURE && !strcmp(r->operation, "fixture-empty")) ? 0 : (gssize)r->input_len, "application/octet-stream");
            GVariant *encoded = secret_service_encode_dbus_secret(service, value);
            GVariant *reply = NULL;
            if (encoded) g_variant_take_ref(encoded);
            if (encoded && item && !fixture) {
                reply = call(bus, owner, g_dbus_proxy_get_object_path(G_DBUS_PROXY(item)),
                    SS ".Item", "SetSecret", g_variant_new("(@(oayays))", encoded),
                    G_VARIANT_TYPE_UNIT, NULL, &error);
                if (reply) r->code = "ok";
            } else if (encoded) {
                GVariantBuilder properties, attrs;
                g_variant_builder_init(&attrs, G_VARIANT_TYPE("a{ss}"));
                GHashTableIter iter; gpointer key, entry;
                g_hash_table_iter_init(&iter, attributes);
                while (g_hash_table_iter_next(&iter, &key, &entry)) {
                    if (strcmp(key, "xdg:schema")) g_variant_builder_add(&attrs, "{ss}", (char *)key, (char *)entry);
                }
                g_variant_builder_add(&attrs, "{ss}", "xdg:schema", schema.name);
                g_variant_builder_init(&properties, G_VARIANT_TYPE("a{sv}"));
                g_variant_builder_add(&properties, "{sv}", SS ".Item.Label", g_variant_new_string("Vault key slot"));
                g_variant_builder_add(&properties, "{sv}", SS ".Item.Attributes", g_variant_builder_end(&attrs));
                reply = call(bus, owner, g_dbus_proxy_get_object_path(G_DBUS_PROXY(collection)),
                    SS ".Collection", "CreateItem",
                    g_variant_new("(@a{sv}@(oayays)b)", g_variant_builder_end(&properties), encoded, FALSE),
                    G_VARIANT_TYPE("(oo)"), NULL, &error);
                if (reply) {
                    const char *created, *prompt;
                    g_variant_get(reply, "(&o&o)", &created, &prompt);
                    if (strcmp(created, "/") && !strcmp(prompt, "/")) r->code = "ok";
                }
            }
            if (reply) g_variant_unref(reply);
            if (encoded) g_variant_unref(encoded);
        }
        if (strcmp(r->code, "ok")) {
            /* Even an error may follow a submitted effect. No further queries
             * (including status) may reach the backend in this process. */
            failed = true; r->code = "uncertain";
        }
    }
done:
    /* Losing transport during a read/prompt must not silently reconnect on
     * the next call either. Missing service at startup is not transport loss. */
    if ((bus && g_dbus_connection_is_closed(bus)) || (error && (
        g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CLOSED) ||
        g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_DISCONNECTED) ||
        g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NO_REPLY) ||
        (owner && (g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NAME_HAS_NO_OWNER) ||
                   g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_SERVICE_UNKNOWN)))))) failed = true;
    if (error && !r->submitted) {
        if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) r->reject_abort = true;
        else if (strcmp(r->code, "unsupported_session")) {
            if (g_error_matches(error, SECRET_ERROR, SECRET_ERROR_IS_LOCKED)) r->code = "locked";
            else if (g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED)) r->code = "denied";
            else r->code = "unavailable";
        }
    }
    if (failed) {
        r->code = r->submitted ? "uncertain" : "unavailable"; r->output_len = 0;
        /* An owned prompt lost with the transport is not a confirmed abort.
         * Preserve zero-call queued/pre-abort rejection (no bus acquired). */
        if (bus) r->reject_abort = false;
    }
    if (value) secret_value_unref(value);
    g_list_free_full(items, g_object_unref);
    if (attributes) g_hash_table_unref(attributes);
    g_clear_object(&collection); g_clear_object(&service);
    g_clear_object(&bus);
    g_free(owner); g_clear_error(&error);
    erase(r->input, sizeof r->input);
    g_main_context_pop_thread_default(r->context);
    pthread_mutex_unlock(&gate);
}
static void complete(napi_env env, napi_status status, void *data) {
    request *r = data;
    napi_value result, code, signal, listener, method, ignored;
    napi_get_reference_value(env, r->signal, &signal);
    napi_get_reference_value(env, r->listener, &listener);
    napi_get_named_property(env, signal, "removeEventListener", &method);
    napi_value event; napi_create_string_utf8(env, "abort", NAPI_AUTO_LENGTH, &event);
    napi_value args[] = {event, listener};
    napi_call_function(env, signal, method, 2, args, &ignored);
    napi_create_object(env, &result);
    napi_create_string_utf8(env, status == napi_ok ? r->code : (r->submitted ? "uncertain" : "unavailable"), NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, result, "code", code);
    if (status == napi_ok && r->output_len && !strcmp(r->code, "ok")) {
        void *copy = NULL; napi_value array, material;
        if (napi_create_arraybuffer(env, r->output_len, &copy, &array) == napi_ok) {
            memcpy(copy, r->output, r->output_len);
            if (napi_create_typedarray(env, napi_uint8_array, r->output_len, array, 0, &material) == napi_ok)
                napi_set_named_property(env, result, "material", material);
            else erase(copy, r->output_len);
        }
    }
    bool reject = r->reject_abort && !r->submitted;
    napi_value reason;
    if (reject) napi_get_named_property(env, signal, "reason", &reason);
    napi_deferred deferred = r->deferred;
    queue *q = r->owner;
    bool was_head = q->head == r;
    if (r->previous) r->previous->next = r->next;
    else q->head = r->next;
    if (r->next) r->next->previous = r->previous;
    else q->tail = r->previous;
    napi_delete_reference(env, r->signal); napi_delete_reference(env, r->listener);
    napi_delete_async_work(env, r->work);
    g_object_unref(r->cancel); g_main_context_unref(r->context);
    erase(r, sizeof *r); free(r); atomic_fetch_sub(&owned_bytes, sizeof(request));
    if (reject) napi_reject_deferred(env, deferred, reason);
    else napi_resolve_deferred(env, deferred, result);
    if (was_head && q->head && napi_queue_async_work(env, q->head->work) != napi_ok) complete(env, napi_generic_failure, q->head);
}
/* Per-environment FIFO: an outstanding OS prompt must not fill libuv's pool
 * with mutex waiters and starve non-secret services. The gate also covers
 * cooperating Node environments in this process. */
static napi_value run(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value args[6], promise, label, aborted, method, event, listener, ignored;
    queue *q = NULL;
    napi_get_cb_info(env, info, &argc, args, NULL, (void **)&q);
    request *r = calloc(1, sizeof *r);
    if (!r) { napi_throw_error(env, NULL, "Key-slot backend unavailable."); return undefined(env); }
    r->owner = q; r->code = "unavailable";
    atomic_init(&r->aborted, false); atomic_init(&r->submission, 0);
    bool valid = argc == 6 && text_arg(env, args[0], r->operation, sizeof r->operation) &&
        text_arg(env, args[1], r->service, sizeof r->service) && policy_valid_service(r->service) &&
        text_arg(env, args[2], r->account, sizeof r->account) && policy_valid_account(r->service, r->account);
    valid = valid && (write_op(r) || !strcmp(r->operation, "read") || !strcmp(r->operation, "delete") || !strcmp(r->operation, "status"));
    char interaction[16];
    valid = valid && text_arg(env, args[4], interaction, sizeof interaction) &&
        (!strcmp(interaction, "never") || !strcmp(interaction, "allowed"));
    bool typed = false;
    napi_typedarray_type type; size_t length = 0, offset = 0;
    void *bytes = NULL; napi_value array;
    valid = valid && napi_is_typedarray(env, args[3], &typed) == napi_ok && typed &&
        napi_get_typedarray_info(env, args[3], &type, &length, &bytes, &array, &offset) == napi_ok && type == napi_uint8_array &&
        (write_op(r) ? length >= 1 && length <= LIMIT : length == 0);
    napi_valuetype signal_type, method_type, remove_type;
    napi_value remove;
    valid = valid && napi_typeof(env, args[5], &signal_type) == napi_ok && signal_type == napi_object &&
        napi_get_named_property(env, args[5], "addEventListener", &method) == napi_ok &&
        napi_typeof(env, method, &method_type) == napi_ok && method_type == napi_function &&
        napi_get_named_property(env, args[5], "removeEventListener", &remove) == napi_ok &&
        napi_typeof(env, remove, &remove_type) == napi_ok && remove_type == napi_function;
    if (!valid) { erase(r, sizeof *r); free(r); napi_throw_type_error(env, NULL, "Invalid key-slot request."); return undefined(env); }
    napi_get_named_property(env, args[5], "aborted", &aborted);
    bool preaborted = false; napi_get_value_bool(env, aborted, &preaborted);
    napi_create_promise(env, &r->deferred, &promise);
    if (preaborted) {
        napi_value reason; napi_get_named_property(env, args[5], "reason", &reason);
        napi_reject_deferred(env, r->deferred, reason); erase(r, sizeof *r); free(r); return promise;
    }
    r->allowed = !strcmp(interaction, "allowed");
    if (length) memcpy(r->input, bytes, length);
    r->input_len = length;
    r->cancel = g_cancellable_new(); r->context = g_main_context_new();
    napi_create_string_utf8(env, "secret-service-key-slot", NAPI_AUTO_LENGTH, &label);
    if (napi_create_async_work(env, NULL, label, execute, complete, r, &r->work) != napi_ok) {
        g_object_unref(r->cancel); g_main_context_unref(r->context);
        erase(r, sizeof *r); free(r);
        napi_throw_error(env, NULL, "Key-slot backend unavailable."); return undefined(env);
    }
    napi_create_reference(env, args[5], 1, &r->signal);
    napi_create_function(env, "abortKeySlot", NAPI_AUTO_LENGTH, abort_call, r, &listener);
    napi_create_reference(env, listener, 1, &r->listener);
    napi_create_string_utf8(env, "abort", NAPI_AUTO_LENGTH, &event);
    napi_value event_args[] = {event, listener};
    if (napi_call_function(env, args[5], method, 2, event_args, &ignored) != napi_ok) {
        napi_delete_reference(env, r->signal); napi_delete_reference(env, r->listener);
        napi_delete_async_work(env, r->work);
        g_object_unref(r->cancel); g_main_context_unref(r->context);
        erase(r, sizeof *r); free(r); return undefined(env);
    }
    atomic_fetch_add(&owned_bytes, sizeof(request));
    r->previous = q->tail;
    if (q->tail) q->tail->next = r;
    else q->head = r;
    q->tail = r;
    if (r->previous && atomic_load(&r->aborted)) {
        r->reject_abort = true; complete(env, napi_ok, r);
    } else if (q->head == r && napi_queue_async_work(env, r->work) != napi_ok) complete(env, napi_generic_failure, r);
    return promise;
}
static napi_value diagnostics(napi_env env, napi_callback_info info) {
    (void)info; napi_value result, value; napi_create_object(env, &result);
#define COUNTER(name, counter) napi_create_double(env, (double)atomic_load(&counter), &value); napi_set_named_property(env, result, name, value)
    COUNTER("apiCalls", api_calls); COUNTER("unlockCalls", unlock_calls);
    COUNTER("promptCalls", prompt_calls); COUNTER("dismissCalls", dismiss_calls); COUNTER("ownedBytes", owned_bytes);
#undef COUNTER
    return result;
}
static void finalize_queue(napi_env env, void *data, void *hint) {
    (void)env; (void)hint; free(data);
}
static napi_value initialize(napi_env env, napi_value exports) {
    queue *q = calloc(1, sizeof *q);
    if (!q) { napi_throw_error(env, NULL, "Key-slot backend unavailable."); return exports; }
    napi_property_descriptor methods[] = {
        {"run", NULL, run, NULL, NULL, NULL, napi_default, q},
        {"diagnostics", NULL, diagnostics, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
    napi_set_instance_data(env, q, finalize_queue, NULL);
    napi_value fixture; napi_get_boolean(env, SECRET_SERVICE_FIXTURE, &fixture);
    napi_set_named_property(env, exports, "fixture", fixture);
    napi_value abi; napi_create_string_utf8(env, "linux-secret-service-v1", NAPI_AUTO_LENGTH, &abi);
    napi_set_named_property(env, exports, "abi", abi);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
