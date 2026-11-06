/* CAN-4501: Node-API only. No Electron, subprocess, logging or fallback.
 * File Keychain interaction is disabled except during serialized unlock-only UI.
 * A query's authentication-UI flag alone does not suppress legacy Keychain UI.
 */
#include <node_api.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <pthread.h>
#include <pwd.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef KEYCHAIN_FIXTURE
#define KEYCHAIN_FIXTURE 0
#endif
#define LIMIT 1024
#define TEXT 512
#define PATH_SIZE 4096

#include "policy.h"

static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static _Atomic bool interaction_owned = false;
static pthread_once_t interaction_once = PTHREAD_ONCE_INIT;
static _Atomic unsigned long interactive_calls = 0;
static _Atomic unsigned long api_calls = 0;
// The JS thread must never wait on a gate held across Security.framework calls.
static _Atomic size_t owned_bytes = 0;

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    char operation[16], service[TEXT], account[TEXT];
    char fixture_path[PATH_SIZE];
#if KEYCHAIN_FIXTURE
    char fixture_unlock[16];
#endif
    unsigned char input[LIMIT], output[LIMIT];
    size_t input_len, output_len;
    const char *code;
} request;

static void erase(void *memory, size_t size) {
    volatile unsigned char *p = memory;
    while (size--) *p++ = 0;
}

static napi_value undefined(napi_env env) {
    napi_value value;
    napi_get_undefined(env, &value);
    return value;
}

static bool text_arg(napi_env env, napi_value value, char *out, size_t size) {
    napi_valuetype type;
    size_t length = 0, copied = 0;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
        length == 0 || length >= size ||
        napi_get_value_string_utf8(env, value, out, size, &copied) != napi_ok)
        return false;
    return copied == length && strlen(out) == length;
}

static bool mutation(const request *r) {
    return !strcmp(r->operation, "create") || !strcmp(r->operation, "replace") || !strcmp(r->operation, "delete");
}

/* Only documented, unambiguous statuses become absence or refusal. */
static const char *outcome(OSStatus status, const request *r) {
    if (status == errSecSuccess) return "ok";
    if (!strcmp(r->operation, "unlock") &&
        (status == errSecAuthFailed || status == errSecUserCanceled ||
         status == errSecInteractionNotAllowed || status == errSecInteractionRequired)) return "locked";
    if (status == errSecItemNotFound) {
        if (!strcmp(r->operation, "read") || !strcmp(r->operation, "delete")) return "absent";
        if (!strcmp(r->operation, "replace")) return "conflict";
    }
    if (status == errSecDuplicateItem && !strcmp(r->operation, "create")) return "conflict";
    if (status == errSecInteractionNotAllowed || status == errSecInteractionRequired) return "interaction_required";
    if (status == errSecAuthFailed || status == errSecUserCanceled) return "denied";
    if (status == errSecNotAvailable || status == errSecNoSuchKeychain || status == errSecInvalidKeychain) return "unavailable";
    if (status == errSecDecode && !strcmp(r->operation, "read")) return "corrupt";
    return mutation(r) ? "uncertain" : "unavailable";
}

/* Instrument every potentially interactive API entry, not an assumed zero.
 * If another embedding library changes the process-wide policy, refuse before
 * entering one. Only the unlock-only phase may enable interaction under gate.
 */
static bool may_enter(void) {
    Boolean allowed = true;
    if (!interaction_owned || SecKeychainGetUserInteractionAllowed(&allowed) != errSecSuccess) return false;
    atomic_fetch_add(&api_calls, 1);
    if (allowed) return false;
    return true;
}

static OSStatus unlock_keychain(request *r, SecKeychainRef keychain) {
    atomic_fetch_add(&interactive_calls, 1);
#if KEYCHAIN_FIXTURE
    /* Fixture builds NEVER enable UI, even if a test accidentally asks for it. */
    if (!strcmp(r->fixture_unlock, "success")) {
        const char *password = "disposable-test-keychain";
        return SecKeychainUnlock(keychain, (UInt32)strlen(password), password, true);
    }
    if (!strcmp(r->fixture_unlock, "deny")) return errSecAuthFailed;
    if (!strcmp(r->fixture_unlock, "unavailable")) return errSecNotAvailable;
    if (!strcmp(r->fixture_unlock, "unknown")) return errSecParam;
    return errSecUserCanceled;
#else
    (void)r;
    OSStatus status = SecKeychainSetUserInteractionAllowed(true);
    if (status == errSecSuccess) status = SecKeychainUnlock(keychain, 0, NULL, false);
    /* No slot API runs here, and gate is held until suppression is restored. */
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) {
        interaction_owned = false;
        return errSecNotAvailable;
    }
    return status;
#endif
}

static void execute(napi_env env, void *data) {
    (void)env;
    request *r = data;
    SecKeychainRef keychain = NULL;
    CFMutableDictionaryRef query = NULL, attributes = NULL;
    CFStringRef service = NULL, account = NULL;
    CFDataRef bytes = NULL;
    CFTypeRef found = NULL;
    CFArrayRef search = NULL;
    SecAccessRef access = NULL;
    OSStatus status;
    bool observing = !strcmp(r->operation, "status");
    if (!observing) pthread_mutex_lock(&gate);
    r->code = "unavailable";
    if (!interaction_owned) goto done;
    /* SecKeychainOpen/GetStatus observe only; never inspect the interaction
     * switch or wait on the slot gate while an unlock dialog is up. */
    if (!observing && !may_enter()) goto done;
    status = policy_open_keychain(r->fixture_path, &keychain);
    if (status != errSecSuccess) { r->code = outcome(status, r); goto done; }
    SecKeychainStatus keychain_status = 0;
    status = SecKeychainGetStatus(keychain, &keychain_status);
    if (status != errSecSuccess) { r->code = outcome(status, r); goto done; }
    if (!strcmp(r->operation, "unlock")) {
        if (keychain_status & kSecUnlockStateStatus) { r->code = "ok"; goto done; }
        status = unlock_keychain(r, keychain);
        r->code = outcome(status, r);
        goto done;
    }
    if (!(keychain_status & kSecUnlockStateStatus)) { r->code = "locked"; goto done; }
    if (!strcmp(r->operation, "status")) { r->code = "ok"; goto done; }

    service = CFStringCreateWithCString(NULL, r->service, kCFStringEncodingUTF8);
    account = CFStringCreateWithCString(NULL, r->account, kCFStringEncodingUTF8);
    query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    const void *keys[] = { keychain };
    search = CFArrayCreate(NULL, keys, 1, &kCFTypeArrayCallBacks);
    if (!service || !account || !query || !search) goto done;
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, service);
    CFDictionarySetValue(query, kSecAttrAccount, account);
    CFDictionarySetValue(query, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
    CFDictionarySetValue(query, kSecMatchSearchList, search);

    if (!strcmp(r->operation, "read")) {
        CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
        CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
        if (!may_enter()) goto done;
        status = SecItemCopyMatching(query, &found);
        r->code = outcome(status, r);
        if (status == errSecSuccess) {
            if (!found || CFGetTypeID(found) != CFDataGetTypeID()) { r->code = "corrupt"; goto done; }
            CFIndex size = CFDataGetLength(found);
            if (size < 1 || size > LIMIT) { r->code = "corrupt"; goto done; }
            memcpy(r->output, CFDataGetBytePtr(found), (size_t)size);
            r->output_len = (size_t)size;
        }
    } else if (!strcmp(r->operation, "delete")) {
        if (!may_enter()) goto done;
        r->code = outcome(SecItemDelete(query), r);
    } else {
        bytes = CFDataCreateWithBytesNoCopy(NULL, r->input, (CFIndex)r->input_len, kCFAllocatorNull);
        if (!bytes) goto done;
        if (!strcmp(r->operation, "create")) {
            CFDictionaryRemoveValue(query, kSecMatchSearchList);
            CFDictionarySetValue(query, kSecUseKeychain, keychain);
            if (!may_enter()) goto done;
            status = policy_create_access(service, &access);
            if (status != errSecSuccess) { r->code = outcome(status, r); goto done; }
            CFDictionarySetValue(query, kSecAttrAccess, access);
            CFDictionarySetValue(query, kSecValueData, bytes);
            if (!may_enter()) goto done;
            r->code = outcome(SecItemAdd(query, NULL), r);
        } else {
            attributes = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            if (!attributes) goto done;
            CFDictionarySetValue(attributes, kSecValueData, bytes);
            if (!may_enter()) goto done;
            r->code = outcome(SecItemUpdate(query, attributes), r);
        }
    }
done:
    if (access) CFRelease(access);
    if (found) CFRelease(found); /* Security.framework's copies are not owned by us. */
    if (bytes) CFRelease(bytes);
    if (attributes) CFRelease(attributes);
    if (query) CFRelease(query);
    if (search) CFRelease(search);
    if (account) CFRelease(account);
    if (service) CFRelease(service);
    if (keychain) CFRelease(keychain);
    erase(r->input, sizeof r->input);
    if (!observing) pthread_mutex_unlock(&gate);
}

static void complete(napi_env env, napi_status status, void *data) {
    request *r = data;
    napi_value result, code, material = NULL;
    napi_create_object(env, &result);
    napi_create_string_utf8(env, status == napi_ok ? r->code : (mutation(r) ? "uncertain" : "unavailable"), NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, result, "code", code);
    if (status == napi_ok && r->output_len) {
        void *copy = NULL;
        napi_value array;
        bool delivered = false;
        if (napi_create_arraybuffer(env, r->output_len, &copy, &array) == napi_ok) {
            memcpy(copy, r->output, r->output_len);
            delivered = napi_create_typedarray(env, napi_uint8_array, r->output_len, array, 0, &material) == napi_ok &&
                napi_set_named_property(env, result, "material", material) == napi_ok;
        }
        if (!delivered) {
            if (copy) erase(copy, r->output_len);
            napi_create_string_utf8(env, "unavailable", NAPI_AUTO_LENGTH, &code);
            napi_set_named_property(env, result, "code", code);
        }
    }
    napi_async_work work = r->work;
    napi_deferred deferred = r->deferred;
    erase(r, sizeof *r);
    free(r);
    atomic_fetch_sub(&owned_bytes, sizeof(request));
    napi_delete_async_work(env, work);
    /* No operation or owned mutation bytes remain when the promise settles. */
    napi_resolve_deferred(env, deferred, result);
}

static napi_value run(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value args[6], promise, label;
    request *r = calloc(1, sizeof *r);
    if (!r) { napi_throw_error(env, NULL, "Key-slot backend unavailable."); return undefined(env); }
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    bool valid = argc == (KEYCHAIN_FIXTURE ? 6u : 4u) &&
        text_arg(env, args[0], r->operation, sizeof r->operation) &&
        text_arg(env, args[1], r->service, sizeof r->service) &&
        text_arg(env, args[2], r->account, sizeof r->account) &&
        policy_valid_service(r->service);
    bool write = !strcmp(r->operation, "create") || !strcmp(r->operation, "replace");
    bool observing = !strcmp(r->operation, "status") || !strcmp(r->operation, "unlock");
    valid = valid && (write || !strcmp(r->operation, "read") || !strcmp(r->operation, "delete") || observing);
    valid = valid && (observing || policy_valid_account(r->service, r->account));
#if KEYCHAIN_FIXTURE
    valid = valid && text_arg(env, args[4], r->fixture_path, sizeof r->fixture_path) && r->fixture_path[0] == '/';
    valid = valid && text_arg(env, args[5], r->fixture_unlock, sizeof r->fixture_unlock) &&
        (!strcmp(r->fixture_unlock, "cancel") || !strcmp(r->fixture_unlock, "success") ||
         !strcmp(r->fixture_unlock, "deny") || !strcmp(r->fixture_unlock, "unavailable") ||
         !strcmp(r->fixture_unlock, "unknown"));
#endif
    bool typed = false;
    napi_typedarray_type type;
    size_t length = 0, offset = 0;
    void *data = NULL;
    napi_value array;
    if (valid && napi_is_typedarray(env, args[3], &typed) == napi_ok && typed &&
        napi_get_typedarray_info(env, args[3], &type, &length, &data, &array, &offset) == napi_ok && type == napi_uint8_array &&
        (write ? (length >= 1 && length <= LIMIT) : length == 0)) {
        if (length) memcpy(r->input, data, length);
        r->input_len = length;
    } else valid = false;
    if (!valid) {
        erase(r, sizeof *r); free(r);
        napi_throw_type_error(env, NULL, "Invalid key-slot request."); return undefined(env);
    }
    napi_create_string_utf8(env, "key-slot", NAPI_AUTO_LENGTH, &label);
    napi_create_promise(env, &r->deferred, &promise);
    if (napi_create_async_work(env, NULL, label, execute, complete, r, &r->work) != napi_ok) {
        erase(r, sizeof *r); free(r);
        napi_throw_error(env, NULL, "Key-slot backend unavailable."); return undefined(env);
    }
    atomic_fetch_add(&owned_bytes, sizeof(request));
    if (napi_queue_async_work(env, r->work) != napi_ok) {
        napi_delete_async_work(env, r->work);
        atomic_fetch_sub(&owned_bytes, sizeof(request));
        erase(r, sizeof *r); free(r);
        napi_throw_error(env, NULL, "Key-slot backend unavailable."); return undefined(env);
    }
    return promise;
}

#if KEYCHAIN_FIXTURE
/* Test-only exports: absent from the product binary and refused by its loader. */
static napi_value fixture_control(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], result;
    char operation[16], path[PATH_SIZE];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (argc != 2 || !text_arg(env, args[0], operation, sizeof operation) || !text_arg(env, args[1], path, sizeof path) || path[0] != '/') {
        napi_throw_type_error(env, NULL, "Invalid fixture request."); return undefined(env);
    }
    SecKeychainRef keychain = NULL;
    OSStatus status;
    pthread_mutex_lock(&gate);
    const char *password = "disposable-test-keychain";
    if (!may_enter()) {
        pthread_mutex_unlock(&gate);
        napi_throw_error(env, NULL, "Fixture interaction policy unavailable."); return undefined(env);
    }
    if (!strcmp(operation, "create")) {
        /* Noninteractive SecKeychainSetSettings can fail after creation succeeds.
         * Keep default settings; lock/unlock tests control state explicitly. */
        status = SecKeychainCreate(path, (UInt32)strlen(password), password, false, NULL, &keychain);
    } else {
        status = SecKeychainOpen(path, &keychain);
        if (status == errSecSuccess) {
            if (!strcmp(operation, "lock")) status = SecKeychainLock(keychain);
            else if (!strcmp(operation, "unlock")) status = SecKeychainUnlock(keychain, (UInt32)strlen(password), password, true);
            else if (!strcmp(operation, "delete")) status = SecKeychainDelete(keychain);
            else status = errSecParam;
        }
    }
    if (!strcmp(operation, "delete") && status == errSecNoSuchKeychain) status = errSecSuccess;
    if (keychain) CFRelease(keychain);
    pthread_mutex_unlock(&gate);
    napi_create_int32(env, status, &result);
    return result;
}

static napi_value map_status(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], result;
    request r = {0};
    int32_t status = 0;
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (argc != 2 || !text_arg(env, args[0], r.operation, sizeof r.operation) ||
        napi_get_value_int32(env, args[1], &status) != napi_ok) {
        napi_throw_type_error(env, NULL, "Invalid fixture request."); return undefined(env);
    }
    napi_create_string_utf8(env, outcome(status, &r), NAPI_AUTO_LENGTH, &result);
    return result;
}

static napi_value diagnostics(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result, value;
    napi_create_object(env, &result);
    napi_create_double(env, (double)atomic_load(&interactive_calls), &value);
    napi_set_named_property(env, result, "prompts", value);
    napi_create_double(env, (double)atomic_load(&api_calls), &value);
    napi_set_named_property(env, result, "apiCalls", value);
    napi_create_double(env, (double)atomic_load(&owned_bytes), &value);
    napi_set_named_property(env, result, "ownedBytes", value);
    return result;
}
#endif

static void own_interaction(void) {
    interaction_owned = SecKeychainSetUserInteractionAllowed(false) == errSecSuccess;
}

static napi_value initialize(napi_env env, napi_value exports) {
    pthread_once(&interaction_once, own_interaction);
    napi_property_descriptor methods[] = {
        { "run", NULL, run, NULL, NULL, NULL, napi_default, NULL },
#if KEYCHAIN_FIXTURE
        { "control", NULL, fixture_control, NULL, NULL, NULL, napi_default, NULL },
        { "diagnostics", NULL, diagnostics, NULL, NULL, NULL, napi_default, NULL },
        { "mapStatus", NULL, map_status, NULL, NULL, NULL, napi_default, NULL },
#endif
    };
    napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
    napi_value fixture;
    napi_get_boolean(env, KEYCHAIN_FIXTURE, &fixture);
    napi_set_named_property(env, exports, "fixture", fixture);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
