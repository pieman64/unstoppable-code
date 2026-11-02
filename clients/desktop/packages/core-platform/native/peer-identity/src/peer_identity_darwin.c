// Launcher-channel peer identity (Darwin only).
//
// In the daemon, claims the inherited launcher channel on fd 3 and captures
// the launcher's evidence from it. In the launcher, checks the code identity
// of the audit token the owned-child addon captured for its spawned daemon.
// The fd never reaches JS. Errors carry fixed text: no paths or input.
#ifndef __APPLE__
#error "core-peer-identity supports Darwin only"
#endif

#include <node_api.h>

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define CHANNEL_FD 3
#define MAX_CHANNEL_BYTES (64 * 1024)
#define MAX_REQUIREMENT_BYTES 4096
// Dynamic code-signing status bits (kern/cs_blobs.h).
#define CS_STATUS_VALID 0x00000001u
#define CS_STATUS_RUNTIME 0x00010000u

typedef struct {
  // CHANNEL_FD once claimed and until closed, else -1.
  int fd;
  uint64_t received;
  // The parent and its pidversion when the channel was claimed.
  pid_t launcher;
  int launcher_version;
} channel;

// One claim attempt per process image: fd 3 is meaningful only at startup,
// before anything else can have opened it.
static bool claim_attempted = false;
static channel claimed = {-1, 0, 0, 0};

static const napi_type_tag CHANNEL_TAG = {0x706565722d696465ULL,
                                          0x6e746974792d6368ULL};

static void throw_code(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

static void invalid_call(napi_env env) {
  throw_code(env, "ERR_PEER_IDENTITY_ARGUMENT", "Peer identity call is invalid.");
}

static napi_value make_int(napi_env env, int64_t value) {
  napi_value out;
  napi_create_int64(env, value, &out);
  return out;
}

static napi_value make_null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static napi_value make_bool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

static napi_value make_state(napi_env env, const char *state) {
  napi_value out, text;
  napi_create_object(env, &out);
  napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "state", text);
  return out;
}

static napi_value refused(napi_env env, const char *reason) {
  napi_value out = make_state(env, "refused"), text;
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "reason", text);
  return out;
}

static bool task_pidversion(pid_t pid, int *version) {
  mach_port_t name = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &name) != KERN_SUCCESS)
    return false;
  audit_token_t token;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t status =
      task_info(name, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
  mach_port_deallocate(mach_task_self(), name);
  if (status != KERN_SUCCESS || audit_token_to_pid(token) != pid) return false;
  *version = audit_token_to_pidversion(token);
  return true;
}

// An unnamed AF_UNIX address: socketpair ends have no path.
static bool unnamed(const struct sockaddr_un *address, socklen_t size) {
  return address->sun_family == AF_UNIX &&
         (size <= offsetof(struct sockaddr_un, sun_path) ||
          address->sun_path[0] == '\0');
}

// fd 3 must be a connected, unnamed AF_UNIX stream socket: a socketpair end,
// not a client of a published endpoint. A listener has no peer address.
static bool socketpair_end(int fd) {
  struct stat info;
  int type = 0;
  socklen_t size = sizeof type;
  if (fstat(fd, &info) != 0 || !S_ISSOCK(info.st_mode) ||
      getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) != 0 ||
      type != SOCK_STREAM)
    return false;
  struct sockaddr_un local, peer;
  socklen_t local_size = sizeof local, peer_size = sizeof peer;
  memset(&local, 0, sizeof local);
  memset(&peer, 0, sizeof peer);
  return getsockname(fd, (struct sockaddr *)&local, &local_size) == 0 &&
         unnamed(&local, local_size) &&
         getpeername(fd, (struct sockaddr *)&peer, &peer_size) == 0 &&
         unnamed(&peer, peer_size);
}

typedef enum {
  CODE_SATISFIED,
  CODE_UNAVAILABLE,
  CODE_REQUIREMENT,
  CODE_RUNTIME,
  CODE_INVALID,
} code_verdict;

static const char *verdict_reason(code_verdict verdict) {
  switch (verdict) {
    case CODE_UNAVAILABLE:
      return "code_unavailable";
    case CODE_REQUIREMENT:
      return "requirement_unsatisfied";
    case CODE_RUNTIME:
      return "runtime_missing";
    default:
      return NULL;
  }
}

static napi_value cf_text(napi_env env, CFTypeRef value) {
  char bytes[4097];
  napi_value out;
  if (!value || CFGetTypeID(value) != CFStringGetTypeID() ||
      !CFStringGetCString(value, bytes, sizeof bytes, kCFStringEncodingUTF8))
    return make_null(env);
  napi_create_string_utf8(env, bytes, NAPI_AUTO_LENGTH, &out);
  return out;
}

static void set_text(napi_env env, napi_value out, const char *key, const char *text) {
  napi_value value;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, out, key, value);
}

// Snapshot the same SecCode used for the verdict, never a path-based recheck.
static napi_value capture_code(napi_env env, SecCodeRef code,
                               const audit_token_t *token,
                               const char *requirement, uint32_t status) {
  CFDictionaryRef signing = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing) != errSecSuccess)
    return NULL;
  CFDataRef digest = CFDictionaryGetValue(signing, kSecCodeInfoUnique);
  if (!digest || CFGetTypeID(digest) != CFDataGetTypeID() || CFDataGetLength(digest) != 20) {
    CFRelease(signing);
    return NULL;
  }
  char hex[41];
  const UInt8 *bytes = CFDataGetBytePtr(digest);
  const char *digits = "0123456789abcdef";
  for (int i = 0; i < 20; i++) {
    hex[2*i] = digits[bytes[i] >> 4];
    hex[2*i+1] = digits[bytes[i] & 15];
  }
  hex[40] = 0;
  napi_value out, identity, process, verdict;
  napi_create_object(env, &out);
  napi_create_object(env, &identity);
  napi_create_object(env, &process);
  napi_create_object(env, &verdict);
  set_text(env, out, "kind", "captured");
  napi_set_named_property(env, process, "pid", make_int(env, audit_token_to_pid(*token)));
  napi_set_named_property(env, process, "pidversion", make_int(env, (uint32_t)audit_token_to_pidversion(*token)));
  napi_set_named_property(env, out, "token", process);
  napi_set_named_property(env, out, "codeToken", process);
  napi_set_named_property(env, identity, "teamId", cf_text(env, CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier)));
  napi_set_named_property(env, identity, "identifier", cf_text(env, CFDictionaryGetValue(signing, kSecCodeInfoIdentifier)));
  CFTypeRef plist = CFDictionaryGetValue(signing, kSecCodeInfoPList);
  CFTypeRef build = plist && CFGetTypeID(plist) == CFDictionaryGetTypeID()
      ? CFDictionaryGetValue(plist, CFSTR("CanopyBuildId")) : NULL;
  napi_set_named_property(env, identity, "buildId", cf_text(env, build));
  napi_set_named_property(env, identity, "codeFlags", make_int(env, status));
  set_text(env, identity, "cdhash", hex);
  napi_set_named_property(env, out, "signing", identity);
  set_text(env, verdict, "text", requirement);
  napi_set_named_property(env, verdict, "satisfied", make_bool(env, true));
  napi_set_named_property(env, out, "requirement", verdict);
  set_text(env, out, "staticCheck", "not-run");
  CFRelease(signing);
  return out;
}

// The audit token pins the exact process instance: a token whose pidversion
// is no longer current (exec, exit) has no code.
static code_verdict check_code(const audit_token_t *token,
                               const char *requirement_text, napi_env env,
                               napi_value *capture) {
  code_verdict verdict = CODE_UNAVAILABLE;
  CFStringRef text = CFStringCreateWithCString(NULL, requirement_text,
                                               kCFStringEncodingUTF8);
  CFDataRef audit =
      CFDataCreate(NULL, (const UInt8 *)token, sizeof *token);
  SecRequirementRef requirement = NULL;
  SecCodeRef code = NULL;
  CFDictionaryRef attributes = NULL, signing = NULL;
  if (!text ||
      SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) !=
          errSecSuccess) {
    verdict = CODE_INVALID;
    goto done;
  }
  if (!audit) goto done;
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {audit};
  attributes = CFDictionaryCreate(NULL, keys, values, 1,
                                  &kCFTypeDictionaryKeyCallBacks,
                                  &kCFTypeDictionaryValueCallBacks);
  if (!attributes ||
      SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags,
                                     &code) != errSecSuccess)
    goto done;
  if (SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) !=
      errSecSuccess) {
    verdict = CODE_REQUIREMENT;
    goto done;
  }
  verdict = CODE_RUNTIME;
  uint32_t status = 0;
  if (SecCodeCopySigningInformation(code, kSecCSDynamicInformation,
                                    &signing) != errSecSuccess)
    goto done;
  CFTypeRef value = CFDictionaryGetValue(signing, kSecCodeInfoStatus);
  if (value && CFGetTypeID(value) == CFNumberGetTypeID() &&
      CFNumberGetValue(value, kCFNumberSInt32Type, &status) &&
      (status & (CS_STATUS_VALID | CS_STATUS_RUNTIME)) ==
          (CS_STATUS_VALID | CS_STATUS_RUNTIME))
    verdict = CODE_SATISFIED;
  if (verdict == CODE_SATISFIED && capture) {
    *capture = capture_code(env, code, token, requirement_text, status);
    if (!*capture) verdict = CODE_UNAVAILABLE;
  }
done:
  if (signing) CFRelease(signing);
  if (code) CFRelease(code);
  if (attributes) CFRelease(attributes);
  if (requirement) CFRelease(requirement);
  if (audit) CFRelease(audit);
  if (text) CFRelease(text);
  return verdict;
}

// Copies a bounded JS string without embedded NULs, or returns NULL.
static char *copy_requirement(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok ||
      size < 1 || size > MAX_REQUIREMENT_BYTES)
    return NULL;
  char *text = calloc(size + 1, 1);
  size_t copied = 0;
  if (!text ||
      napi_get_value_string_utf8(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || strlen(text) != size) {
    free(text);
    return NULL;
  }
  return text;
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)data;
  (void)hint;
}

// claimLauncherChannel() -> { state: 'channel', handle } |
// { state: 'refused', reason }. CLOEXEC is set first, before any check, so
// no later spawn can co-hold fd 3 whatever it turns out to be.
static napi_value claim_channel(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok ||
      argc != 0) {
    invalid_call(env);
    return NULL;
  }
  // Atomic: worker threads load this addon into the same process.
  if (__atomic_exchange_n(&claim_attempted, true, __ATOMIC_SEQ_CST)) {
    throw_code(env, "ERR_PEER_IDENTITY_CLAIMED",
               "Launcher channel was already claimed.");
    return NULL;
  }
  int flags = fcntl(CHANNEL_FD, F_GETFD);
  if (flags == -1) return refused(env, "no_channel");
  if (fcntl(CHANNEL_FD, F_SETFD, flags | FD_CLOEXEC) != 0)
    return refused(env, "no_channel");
  if (!socketpair_end(CHANNEL_FD)) return refused(env, "wrong_channel_type");
  pid_t launcher = getppid();
  if (launcher <= 1) return refused(env, "reparented");
  int version = 0;
  if (!task_pidversion(launcher, &version))
    return refused(env, "code_unavailable");
  int on = 1;
  int status = fcntl(CHANNEL_FD, F_GETFL);
  if (status == -1 ||
      fcntl(CHANNEL_FD, F_SETFL, status | O_NONBLOCK) != 0 ||
      setsockopt(CHANNEL_FD, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on) != 0)
    return refused(env, "wrong_channel_type");
  napi_value handle;
  if (napi_create_object(env, &handle) != napi_ok ||
      napi_type_tag_object(env, handle, &CHANNEL_TAG) != napi_ok ||
      napi_wrap(env, handle, &claimed, finalize_handle, NULL, NULL) !=
          napi_ok)
    return NULL;
  claimed.fd = CHANNEL_FD;
  claimed.launcher = launcher;
  claimed.launcher_version = version;
  napi_value out = make_state(env, "channel");
  napi_set_named_property(env, out, "handle", handle);
  return out;
}

// Resolves (handle, ...) for an open claimed channel; `extra` arguments follow.
static channel *channel_args(napi_env env, napi_callback_info info,
                             napi_value *extra, size_t count, bool open) {
  size_t argc = 3;
  napi_value argv[3];
  bool tagged = false;
  void *data = NULL;
  napi_valuetype type;
  if (count > 2 ||
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != count + 1 || napi_typeof(env, argv[0], &type) != napi_ok ||
      type != napi_object ||
      napi_check_object_type_tag(env, argv[0], &CHANNEL_TAG, &tagged) !=
          napi_ok ||
      !tagged || napi_unwrap(env, argv[0], &data) != napi_ok ||
      data != &claimed) {
    invalid_call(env);
    return NULL;
  }
  if (open && claimed.fd < 0) {
    throw_code(env, "ERR_PEER_IDENTITY_CHANNEL",
               "Launcher channel is unavailable.");
    return NULL;
  }
  for (size_t n = 0; n < count; n++) extra[n] = argv[n + 1];
  return &claimed;
}

static void close_channel(channel *ch) {
  if (ch->fd < 0) return;
  close(ch->fd);
  ch->fd = -1;
}

static void channel_failed(napi_env env, channel *ch) {
  close_channel(ch);
  throw_code(env, "ERR_PEER_IDENTITY_CHANNEL",
             "Launcher channel is unavailable.");
}

// channelRead(handle, max) -> Buffer (empty while nothing is ready) | null at
// end of stream.
static napi_value channel_read(napi_env env, napi_callback_info info) {
  napi_value extra[1];
  channel *ch = channel_args(env, info, extra, 1, true);
  if (!ch) return NULL;
  int64_t max = 0;
  if (napi_get_value_int64(env, extra[0], &max) != napi_ok || max < 1 ||
      max > MAX_CHANNEL_BYTES) {
    invalid_call(env);
    return NULL;
  }
  char bytes[MAX_CHANNEL_BYTES];
  ssize_t n;
  do {
    n = read(ch->fd, bytes, (size_t)max);
  } while (n < 0 && errno == EINTR);
  if (n == 0) return make_null(env);
  if (n < 0 && errno != EAGAIN) {
    channel_failed(env, ch);
    return NULL;
  }
  size_t size = n > 0 ? (size_t)n : 0;
  ch->received += size;
  napi_value out;
  if (napi_create_buffer_copy(env, size, bytes, NULL, &out) != napi_ok)
    return NULL;
  return out;
}

// channelWrite(handle, Uint8Array) -> bytes written; 0 while the launcher is
// not reading.
static napi_value channel_write(napi_env env, napi_callback_info info) {
  napi_value extra[1];
  channel *ch = channel_args(env, info, extra, 1, true);
  if (!ch) return NULL;
  bool typed = false;
  napi_typedarray_type type;
  size_t length = 0;
  void *bytes = NULL;
  if (napi_is_typedarray(env, extra[0], &typed) != napi_ok || !typed ||
      napi_get_typedarray_info(env, extra[0], &type, &length, &bytes, NULL,
                               NULL) != napi_ok ||
      type != napi_uint8_array || length < 1 || length > MAX_CHANNEL_BYTES) {
    invalid_call(env);
    return NULL;
  }
  ssize_t n;
  do {
    n = write(ch->fd, bytes, length);
  } while (n < 0 && errno == EINTR);
  if (n < 0 && errno != EAGAIN) {
    channel_failed(env, ch);
    return NULL;
  }
  return make_int(env, n > 0 ? n : 0);
}

// channelClose(handle) -> true; idempotent.
static napi_value channel_close(napi_env env, napi_callback_info info) {
  channel *ch = channel_args(env, info, NULL, 0, false);
  if (!ch) return NULL;
  close_channel(ch);
  return make_bool(env, true);
}

// launcherEvidence(handle, requirement) -> { state: 'launcher', pid,
// pidversion } | { state: 'refused', reason }. The kernel reports the last
// process to use the launcher's end, so this follows the launcher's frame.
static napi_value launcher_evidence(napi_env env, napi_callback_info info) {
  napi_value extra[1];
  channel *ch = channel_args(env, info, extra, 1, true);
  if (!ch) return NULL;
  char *requirement = copy_requirement(env, extra[0]);
  if (!requirement) {
    invalid_call(env);
    return NULL;
  }
  const char *reason = NULL;
  audit_token_t token;
  socklen_t size = sizeof token;
  if (ch->received == 0)
    reason = "no_frame";
  else if (getsockopt(ch->fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) !=
               0 ||
           size != sizeof token)
    reason = "not_connected";
  else if (getppid() != ch->launcher)
    reason = "reparented";
  else if (audit_token_to_pid(token) != ch->launcher)
    reason = "pid_mismatch";
  else if (audit_token_to_pidversion(token) != ch->launcher_version)
    reason = "pidversion_changed";
  napi_value capture = NULL;
  code_verdict verdict =
      reason ? CODE_UNAVAILABLE : check_code(&token, requirement, env, &capture);
  free(requirement);
  if (verdict == CODE_INVALID) {
    invalid_call(env);
    return NULL;
  }
  if (reason || verdict != CODE_SATISFIED)
    return refused(env, reason ? reason : verdict_reason(verdict));
  napi_value out = make_state(env, "launcher"), snapshot, fd;
  napi_create_object(env, &snapshot);
  napi_create_object(env, &fd);
  set_text(env, snapshot, "os", "darwin");
  napi_set_named_property(env, snapshot, "launched", make_bool(env, true));
  set_text(env, fd, "family", "AF_UNIX");
  set_text(env, fd, "type", "SOCK_STREAM");
  napi_set_named_property(env, snapshot, "fd3", fd);
  napi_set_named_property(env, snapshot, "fd3CloexecAtStartup", make_bool(env, true));
  napi_set_named_property(env, snapshot, "startupParentPid", make_int(env, ch->launcher));
  napi_set_named_property(env, snapshot, "captureParentPid", make_int(env, getppid()));
  napi_set_named_property(env, snapshot, "peer", capture);
  napi_set_named_property(env, out, "capture", snapshot);
  napi_set_named_property(env, out, "pid", make_int(env, ch->launcher));
  napi_set_named_property(env, out, "pidversion",
                          make_int(env, ch->launcher_version));
  return out;
}

// checkGuest(token, requirement) -> { state: 'satisfied' } |
// { state: 'refused', reason }, for a token the owned-child addon captured.
static napi_value check_guest_impl(napi_env env, napi_callback_info info, bool with_capture) {
  size_t argc = 2;
  napi_value argv[2];
  bool buffer = false;
  void *bytes = NULL;
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2 || napi_is_buffer(env, argv[0], &buffer) != napi_ok ||
      !buffer ||
      napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok ||
      length != sizeof(audit_token_t)) {
    invalid_call(env);
    return NULL;
  }
  char *requirement = copy_requirement(env, argv[1]);
  if (!requirement) {
    invalid_call(env);
    return NULL;
  }
  audit_token_t token;
  memcpy(&token, bytes, sizeof token);
  napi_value capture = NULL;
  code_verdict verdict = check_code(&token, requirement, env, with_capture ? &capture : NULL);
  free(requirement);
  if (verdict == CODE_INVALID) {
    invalid_call(env);
    return NULL;
  }
  if (verdict == CODE_SATISFIED && with_capture) {
    napi_value out = make_state(env, "satisfied");
    napi_set_named_property(env, out, "capture", capture);
    return out;
  }
  return verdict == CODE_SATISFIED ? make_state(env, "satisfied")
                                   : refused(env, verdict_reason(verdict));
}

static napi_value check_guest(napi_env env, napi_callback_info info) {
  return check_guest_impl(env, info, false);
}
static napi_value capture_guest(napi_env env, napi_callback_info info) {
  return check_guest_impl(env, info, true);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"claimLauncherChannel", NULL, claim_channel, NULL, NULL, NULL,
       napi_enumerable, NULL},
      {"channelRead", NULL, channel_read, NULL, NULL, NULL, napi_enumerable,
       NULL},
      {"channelWrite", NULL, channel_write, NULL, NULL, NULL, napi_enumerable,
       NULL},
      {"channelClose", NULL, channel_close, NULL, NULL, NULL, napi_enumerable,
       NULL},
      {"launcherEvidence", NULL, launcher_evidence, NULL, NULL, NULL,
       napi_enumerable, NULL},
      {"captureGuest", NULL, capture_guest, NULL, NULL, NULL, napi_enumerable, NULL},
      {"checkGuest", NULL, check_guest, NULL, NULL, NULL, napi_enumerable,
       NULL},
  };
  if (napi_define_properties(env, exports, sizeof methods / sizeof *methods,
                             methods) != napi_ok)
    return NULL;
  return exports;
}
