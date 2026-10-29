/*
 * Owner-only named pipe server for Node on Windows. Every instance is created
 * with an explicit descriptor (owner = token user, protected DACL, one allow
 * ACE for that user), so no default-DACL instance ever exists. Connected
 * instances reach JS as fds in Node's CRT, for `new net.Socket({ fd })`.
 * JS contract: packages/core-platform/src/endpoints/windows-pipe.ts.
 */
#ifndef _WIN32
#error "windows-pipe-security is Windows-only."
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <node_api.h>
#include <uv.h>

#define RING_CAP 32u
#define SID_CAP 256 /* SID text is at most 183 characters */
#define SDDL_CAP 512
#define PIPE_BUFFER 65536

typedef struct {
  WCHAR *path;
  PSECURITY_DESCRIPTOR sd; /* reused for every later instance */
  SECURITY_ATTRIBUTES sa;
  HANDLE pending; /* the instance holding the name until close() */
  HANDLE connect_event, cancel_event, space_event, thread;
  napi_threadsafe_function tsfn;
  CRITICAL_SECTION lock; /* ring, fatal state, and swaps of `pending` */
  HANDLE ring[RING_CAP];
  unsigned head, count;
  DWORD fatal;
  bool fatal_reported, listening, closed;
  int refs; /* the external plus the tsfn; touched on the JS thread only */
} server_t;

static const napi_type_tag SERVER_TAG = {0x6b1f0c2e9d4a4f37ULL, 0xb85e21d7c3a96f04ULL};

static napi_value throw_msg(napi_env env, const char *msg) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, NULL, msg);
  return NULL;
}

static napi_value throw_type(napi_env env, const char *msg) {
  napi_throw_type_error(env, NULL, msg);
  return NULL;
}

/* Fixed text plus the Win32 code; never a path or a SID. */
static napi_value throw_win32(napi_env env, const char *api, DWORD code) {
  char msg[128];
  snprintf(msg, sizeof msg, "%s failed: %lu", api, (unsigned long)code);
  return throw_msg(env, msg);
}

/* Token user SID as a LocalAlloc'd string. Returns the failing API, or NULL. */
static const char *user_sid_text(LPWSTR *text, DWORD *err) {
  union { TOKEN_USER user; BYTE raw[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]; } info;
  HANDLE token;
  DWORD size;
  const char *api = NULL;
  *text = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *err = GetLastError();
    return "OpenProcessToken";
  }
  if (!GetTokenInformation(token, TokenUser, &info, (DWORD)sizeof info, &size)) api = "GetTokenInformation";
  else if (!ConvertSidToStringSidW(info.user.User.Sid, text)) api = "ConvertSidToStringSidW";
  if (api) *err = GetLastError();
  CloseHandle(token);
  return api;
}

/* Copies SID text as JSON-safe ASCII. */
static bool ascii_sid(LPCWSTR text, char *out, size_t cap) {
  size_t i;
  for (i = 0; text[i]; i++) {
    if (i + 1 >= cap || text[i] < 0x20 || text[i] > 0x7e || text[i] == L'"' || text[i] == L'\\') return false;
    out[i] = (char)text[i];
  }
  out[i] = '\0';
  return true;
}

static bool sid_json(PSID sid, char *out, size_t cap) {
  LPWSTR text = NULL;
  bool ok = IsValidSid(sid) && ConvertSidToStringSidW(sid, &text) && ascii_sid(text, out, cap);
  LocalFree(text);
  return ok;
}

static bool ace_sid_json(ACCESS_ALLOWED_ACE *ace, char *out, size_t cap) {
  size_t size = ace->Header.AceSize, off = offsetof(ACCESS_ALLOWED_ACE, SidStart);
  PSID sid = &ace->SidStart;
  return size >= off + offsetof(SID, SubAuthority) && IsValidSid(sid) && GetLengthSid(sid) <= size - off &&
         sid_json(sid, out, cap);
}

typedef struct { char *buf; size_t len, cap; bool ok; } json_t;

#if defined(__GNUC__) || defined(__clang__)
__attribute__((format(printf, 2, 3)))
#endif
static void jput(json_t *j, const char *fmt, ...) {
  va_list ap;
  int n;
  if (!j->ok) return;
  va_start(ap, fmt);
  n = vsnprintf(j->buf + j->len, j->cap - j->len, fmt, ap);
  va_end(ap);
  if (n < 0 || (size_t)n >= j->cap - j->len) j->ok = false;
  else j->len += (size_t)n;
}

static bool wappend(WCHAR *buf, size_t cap, size_t *len, LPCWSTR text) {
  size_t n = wcslen(text);
  if (n >= cap - *len) return false;
  memcpy(buf + *len, text, (n + 1) * sizeof(WCHAR));
  *len += n;
  return true;
}

/* Owner = user, protected DACL, one allow ACE: FILE_GENERIC_READ|FILE_GENERIC_WRITE. */
static const char *make_descriptor(server_t *s, DWORD *err) {
  WCHAR sddl[SDDL_CAP];
  size_t len = 0, i;
  LPWSTR sid;
  bool built = true;
  const char *api = user_sid_text(&sid, err);
  if (api) return api;
  LPCWSTR parts[] = {L"O:", sid, L"D:P(A;;0x0012019f;;;", sid, L")"};
  for (i = 0; built && i < sizeof parts / sizeof parts[0]; i++) built = wappend(sddl, SDDL_CAP, &len, parts[i]);
  LocalFree(sid);
  if (!built) {
    *err = ERROR_INSUFFICIENT_BUFFER;
    return "SDDL";
  }
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &s->sd, NULL)) {
    *err = GetLastError();
    return "ConvertStringSecurityDescriptorToSecurityDescriptorW";
  }
  s->sa.nLength = (DWORD)sizeof s->sa;
  s->sa.lpSecurityDescriptor = s->sd;
  s->sa.bInheritHandle = FALSE;
  return NULL;
}

static HANDLE create_instance(server_t *s, DWORD first) {
  return CreateNamedPipeW(s->path, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | first,
                          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                          PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0, &s->sa);
}

/* ---- accept thread ---- */

/* Pure wake-up: the queue item carries no ownership. False once the tsfn is closing. */
static bool wake(server_t *s) {
  return napi_call_threadsafe_function(s->tsfn, NULL, napi_tsfn_nonblocking) != napi_closing;
}

/* Stops accepting. The pending instance stays open: it holds the name until close(). */
static void fail(server_t *s, DWORD err) {
  EnterCriticalSection(&s->lock);
  s->fatal = err != ERROR_SUCCESS ? err : ERROR_GEN_FAILURE;
  LeaveCriticalSection(&s->lock);
  wake(s);
}

/* Queues a connected handle, waiting for space rather than dropping it. */
static bool ring_push(server_t *s, HANDLE h) {
  HANDLE waits[2] = {s->space_event, s->cancel_event};
  for (;;) {
    bool pushed = false;
    DWORD w, err;
    EnterCriticalSection(&s->lock);
    if (s->count < RING_CAP) {
      s->ring[(s->head + s->count) % RING_CAP] = h;
      s->count++;
      pushed = true;
    }
    LeaveCriticalSection(&s->lock);
    if (pushed) return true;
    if ((w = WaitForMultipleObjects(2, waits, FALSE, INFINITE)) == WAIT_OBJECT_0) continue;
    err = w == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
    CloseHandle(h);
    if (err != ERROR_SUCCESS) fail(s, err);
    return false;
  }
}

/* Hands off the connected pending instance. False when the thread must exit. */
static bool hand_off(server_t *s) {
  HANDLE connected = s->pending, dup;
  /* The successor exists before this instance leaves, so the name never has zero instances. */
  HANDLE next = create_instance(s, 0);
  if (next == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    /* No successor: deliver a duplicate and keep this instance as `pending`, so the
       name stays held until close() even after JS closes its socket. */
    if (DuplicateHandle(GetCurrentProcess(), connected, GetCurrentProcess(), &dup, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      if (!ring_push(s, dup)) return false;
    } else {
      DisconnectNamedPipe(connected);
    }
    fail(s, err);
    return false;
  }
  EnterCriticalSection(&s->lock);
  s->pending = next;
  LeaveCriticalSection(&s->lock);
  return ring_push(s, connected) && wake(s);
}

static DWORD WINAPI accept_thread(LPVOID arg) {
  server_t *s = arg;
  HANDLE waits[2] = {s->connect_event, s->cancel_event};
  for (;;) {
    OVERLAPPED ov;
    DWORD err = ERROR_SUCCESS, n;
    if (WaitForSingleObject(s->cancel_event, 0) == WAIT_OBJECT_0) return 0;
    memset(&ov, 0, sizeof ov);
    ov.hEvent = s->connect_event;
    ResetEvent(ov.hEvent);
    if (!ConnectNamedPipe(s->pending, &ov)) err = GetLastError();
    if (err == ERROR_IO_PENDING) {
      DWORD w = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
      if (w != WAIT_OBJECT_0) {
        /* `ov` lives on this stack: the I/O must finish before the thread returns. */
        err = w == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
        CancelIoEx(s->pending, &ov);
        GetOverlappedResult(s->pending, &ov, &n, TRUE);
        if (err != ERROR_SUCCESS) fail(s, err);
        return 0;
      }
      err = GetOverlappedResult(s->pending, &ov, &n, FALSE) ? ERROR_SUCCESS : GetLastError();
    }
    if (err == ERROR_PIPE_CONNECTED) err = ERROR_SUCCESS; /* the client arrived first */
    if (err == ERROR_NO_DATA) {                           /* the client already left: reuse */
      if (DisconnectNamedPipe(s->pending)) continue;
      err = GetLastError();
    }
    if (err == ERROR_OPERATION_ABORTED && WaitForSingleObject(s->cancel_event, 0) == WAIT_OBJECT_0) return 0;
    if (err != ERROR_SUCCESS) {
      fail(s, err);
      return 0;
    }
    if (!hand_off(s)) return 0;
  }
}

/* ---- lifetime (JS thread) ---- */

static void stop_thread(server_t *s) {
  if (!s->thread) return;
  SetEvent(s->cancel_event);
  WaitForSingleObject(s->thread, INFINITE);
  CloseHandle(s->thread);
  s->thread = NULL;
}

static void server_close(server_t *s) {
  if (s->closed) return;
  s->closed = true;
  stop_thread(s);
  EnterCriticalSection(&s->lock);
  for (; s->count > 0; s->count--, s->head = (s->head + 1) % RING_CAP) CloseHandle(s->ring[s->head]);
  if (s->pending != INVALID_HANDLE_VALUE) CloseHandle(s->pending);
  s->pending = INVALID_HANDLE_VALUE;
  LeaveCriticalSection(&s->lock);
  if (s->tsfn) {
    napi_release_threadsafe_function(s->tsfn, napi_tsfn_abort);
    s->tsfn = NULL;
  }
}

static void server_destroy(server_t *s) {
  if (s->pending != INVALID_HANDLE_VALUE) CloseHandle(s->pending);
  if (s->connect_event) CloseHandle(s->connect_event);
  if (s->cancel_event) CloseHandle(s->cancel_event);
  if (s->space_event) CloseHandle(s->space_event);
  if (s->sd) LocalFree(s->sd);
  DeleteCriticalSection(&s->lock);
  free(s->path);
  free(s);
}

static void server_unref(server_t *s) {
  if (--s->refs == 0) server_destroy(s);
}

static void server_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  server_close(data);
  server_unref(data);
}

/* Env teardown can finalize the tsfn before close(); the thread must not outlive it. */
static void tsfn_finalize(napi_env env, void *data, void *hint) {
  server_t *s = data;
  (void)env;
  (void)hint;
  stop_thread(s);
  s->tsfn = NULL;
  server_unref(s);
}

/* Closes an fd in Node's CRT; this addon's static CRT has its own fd table. */
static void close_node_fd(napi_env env, int fd) {
  uv_loop_t *loop = NULL;
  uv_fs_t req;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == NULL) return;
  uv_fs_close(loop, &req, fd, NULL);
  uv_fs_req_cleanup(&req);
}

/* Delivers one handle as an fd. False when draining must stop. */
static bool deliver(napi_env env, server_t *s, napi_value cb, napi_value recv, napi_value null, HANDLE h) {
  napi_value argv[2];
  bool thrown = false;
  int fd = uv_open_osfhandle(h);
  if (fd < 0) {
    CloseHandle(h);
    return true;
  }
  argv[0] = null;
  if (napi_create_int32(env, fd, &argv[1]) == napi_ok && napi_call_function(env, recv, cb, 2, argv, NULL) == napi_ok)
    return true;
  napi_is_exception_pending(env, &thrown);
  if (!thrown) close_node_fd(env, fd); /* JS never received it */
  if (!s->closed) wake(s);             /* the rest arrive on a later turn */
  return false;
}

static void call_js(napi_env env, napi_value cb, void *context, void *data) {
  server_t *s = context;
  napi_value recv, null;
  (void)data;
  if (env == NULL) return; /* teardown: `context` may already be freed */
  if (s->closed || napi_get_undefined(env, &recv) != napi_ok || napi_get_null(env, &null) != napi_ok) return;
  for (;;) {
    HANDLE h = INVALID_HANDLE_VALUE;
    DWORD fatal = ERROR_SUCCESS;
    bool popped = false;
    EnterCriticalSection(&s->lock);
    if (s->count > 0) {
      h = s->ring[s->head];
      s->head = (s->head + 1) % RING_CAP;
      s->count--;
      popped = true;
    } else if (s->fatal != ERROR_SUCCESS && !s->fatal_reported) {
      /* Read with the ring empty under one lock, so every connection precedes the error. */
      fatal = s->fatal;
      s->fatal_reported = true;
    }
    LeaveCriticalSection(&s->lock);
    if (popped) {
      SetEvent(s->space_event);
      if (!deliver(env, s, cb, recv, null, h) || s->closed) return;
      continue;
    }
    if (fatal != ERROR_SUCCESS) {
      char code[16];
      napi_value argv[2];
      snprintf(code, sizeof code, "%lu", (unsigned long)fatal);
      argv[1] = null;
      if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &argv[0]) == napi_ok)
        napi_call_function(env, recv, cb, 2, argv, NULL);
    }
    return;
  }
}

/* ---- exports ---- */

/* Reads `argc` arguments; the first must be a server from createServer. */
static server_t *server_args(napi_env env, napi_callback_info info, size_t argc, napi_value *argv) {
  napi_valuetype type;
  bool tagged = false;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && napi_typeof(env, argv[0], &type) == napi_ok &&
      type == napi_external && napi_check_object_type_tag(env, argv[0], &SERVER_TAG, &tagged) == napi_ok && tagged &&
      napi_get_value_external(env, argv[0], &data) == napi_ok && data != NULL)
    return data;
  throw_type(env, "Expected a pipe server.");
  return NULL;
}

static napi_value js_user_sid(napi_env env, napi_callback_info info) {
  LPWSTR text;
  DWORD err = ERROR_SUCCESS;
  napi_value result;
  napi_status status;
  const char *api = user_sid_text(&text, &err);
  (void)info;
  if (api) return throw_win32(env, api, err);
  status = napi_create_string_utf16(env, text, NAPI_AUTO_LENGTH, &result);
  LocalFree(text);
  return status == napi_ok ? result : throw_msg(env, "userSid failed.");
}

static napi_value js_create_server(napi_env env, napi_callback_info info) {
  size_t argc = 1, len = 0;
  napi_value arg, result = NULL;
  napi_valuetype type;
  DWORD err = ERROR_SUCCESS;
  const char *api;
  server_t *s;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || napi_typeof(env, arg, &type) != napi_ok ||
      type != napi_string || napi_get_value_string_utf16(env, arg, NULL, 0, &len) != napi_ok || len == 0)
    return throw_type(env, "Expected a pipe path.");
  if ((s = calloc(1, sizeof *s)) == NULL) return throw_msg(env, "Out of memory.");
  InitializeCriticalSection(&s->lock);
  s->pending = INVALID_HANDLE_VALUE;
  s->refs = 1;
  if ((s->path = calloc(len + 1, sizeof(WCHAR))) == NULL) {
    server_destroy(s);
    return throw_msg(env, "Out of memory.");
  }
  /* A NUL inside the path would silently name a different pipe. */
  if (napi_get_value_string_utf16(env, arg, s->path, len + 1, &len) != napi_ok || wcslen(s->path) != len) {
    server_destroy(s);
    return throw_type(env, "Expected a pipe path.");
  }
  if ((api = make_descriptor(s, &err)) == NULL && ((s->connect_event = CreateEventW(NULL, TRUE, FALSE, NULL)) == NULL ||
                                                   (s->cancel_event = CreateEventW(NULL, TRUE, FALSE, NULL)) == NULL ||
                                                   (s->space_event = CreateEventW(NULL, FALSE, FALSE, NULL)) == NULL)) {
    api = "CreateEventW";
    err = GetLastError();
  }
  if (api) {
    server_destroy(s);
    return throw_win32(env, api, err);
  }
  if ((s->pending = create_instance(s, FILE_FLAG_FIRST_PIPE_INSTANCE)) == INVALID_HANDLE_VALUE) {
    err = GetLastError();
    server_destroy(s);
    if (err != ERROR_ACCESS_DENIED && err != ERROR_PIPE_BUSY) return throw_win32(env, "CreateNamedPipeW", err);
    napi_get_null(env, &result); /* the name is taken */
    return result;
  }
  if (napi_create_external(env, s, server_finalize, NULL, &result) != napi_ok) {
    server_destroy(s);
    return throw_msg(env, "napi_create_external failed.");
  }
  if (napi_type_tag_object(env, result, &SERVER_TAG) != napi_ok) {
    server_close(s); /* the external's finalizer frees the rest */
    return throw_msg(env, "napi_type_tag_object failed.");
  }
  return result;
}

static napi_value js_describe(napi_env env, napi_callback_info info) {
  napi_value arg, result = NULL;
  LPWSTR text;
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision, err = ERROR_SUCCESS;
  char user[SID_CAP], sid[SID_CAP];
  json_t j = {NULL, 0, 0, false};
  const char *api;
  bool ok;
  server_t *s = server_args(env, info, 1, &arg);
  if (s == NULL) return NULL;
  if (s->closed) return throw_msg(env, "Pipe server is closed.");
  if ((api = user_sid_text(&text, &err)) != NULL) return throw_win32(env, api, err);
  ok = ascii_sid(text, user, sizeof user);
  LocalFree(text);
  if (!ok) return throw_msg(env, "describe failed.");
  EnterCriticalSection(&s->lock);
  err = GetSecurityInfo(s->pending, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner,
                        NULL, &dacl, NULL, &sd);
  LeaveCriticalSection(&s->lock);
  if (err != ERROR_SUCCESS) return throw_win32(env, "GetSecurityInfo", err);
  if (!GetSecurityDescriptorControl(sd, &control, &revision)) {
    err = GetLastError();
    LocalFree(sd);
    return throw_win32(env, "GetSecurityDescriptorControl", err);
  }
  j.cap = 128 + 2 * SID_CAP + (size_t)(dacl ? dacl->AceCount : 0) * (96 + SID_CAP);
  j.ok = (j.buf = malloc(j.cap)) != NULL;
  jput(&j, "{\"user\":\"%s\",\"owner\":", user);
  if (owner == NULL) jput(&j, "null");
  else if (sid_json(owner, sid, sizeof sid)) jput(&j, "\"%s\"", sid);
  else j.ok = false;
  jput(&j, ",\"protected\":%s,\"aces\":", (control & SE_DACL_PROTECTED) ? "true" : "false");
  if (dacl == NULL) {
    jput(&j, "null"); /* NULL DACL grants everyone access; JS rejects it */
  } else {
    jput(&j, "[");
    for (WORD i = 0; j.ok && i < dacl->AceCount; i++) {
      void *raw = NULL;
      ACCESS_ALLOWED_ACE *ace = GetAce(dacl, i, &raw) ? raw : NULL; /* every ACE type has Mask after its header */
      if (ace == NULL || (size_t)ace->Header.AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK)) {
        j.ok = false;
        break;
      }
      jput(&j, "%s{\"type\":%u,\"flags\":%u,\"mask\":%lu,\"sid\":", i ? "," : "", (unsigned)ace->Header.AceType,
           (unsigned)ace->Header.AceFlags, (unsigned long)ace->Mask);
      if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceType != ACCESS_DENIED_ACE_TYPE)
        jput(&j, "null}");
      else if (ace_sid_json(ace, sid, sizeof sid))
        jput(&j, "\"%s\"}", sid);
      else
        j.ok = false;
    }
    jput(&j, "]");
  }
  jput(&j, "}");
  LocalFree(sd);
  if (!j.ok || napi_create_string_utf8(env, j.buf, j.len, &result) != napi_ok) result = NULL;
  free(j.buf);
  return result ? result : throw_msg(env, "describe failed.");
}

static napi_value js_listen(napi_env env, napi_callback_info info) {
  napi_value argv[2], name;
  napi_valuetype type;
  napi_threadsafe_function tsfn;
  DWORD err;
  server_t *s = server_args(env, info, 2, argv);
  if (s == NULL) return NULL;
  if (s->closed) return throw_msg(env, "Pipe server is closed.");
  if (s->listening) return throw_msg(env, "Pipe server is already listening.");
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_function)
    return throw_type(env, "Expected a connection callback.");
  /* Queue bound 1: items are wake-ups, and each drains the whole ring. */
  if (napi_create_string_utf8(env, "windowsPipeAccept", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_threadsafe_function(env, argv[1], NULL, name, 1, 1, s, tsfn_finalize, s, call_js, &tsfn) != napi_ok)
    return throw_msg(env, "napi_create_threadsafe_function failed.");
  s->tsfn = tsfn;
  s->refs++;
  s->listening = true; /* stays set on failure: the released tsfn finalizes later and would stop a retry */
  /* A dedicated thread: the libuv threadpool must not block on ConnectNamedPipe. */
  if ((s->thread = CreateThread(NULL, 0, accept_thread, s, 0, NULL)) == NULL) {
    err = GetLastError();
    napi_release_threadsafe_function(s->tsfn, napi_tsfn_abort);
    s->tsfn = NULL;
    return throw_win32(env, "CreateThread", err);
  }
  return NULL;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  napi_value arg;
  server_t *s = server_args(env, info, 1, &arg);
  if (s) server_close(s);
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"userSid", NULL, js_user_sid, NULL, NULL, NULL, napi_enumerable, NULL},
      {"createServer", NULL, js_create_server, NULL, NULL, NULL, napi_enumerable, NULL},
      {"describe", NULL, js_describe, NULL, NULL, NULL, napi_enumerable, NULL},
      {"listen", NULL, js_listen, NULL, NULL, NULL, napi_enumerable, NULL},
      {"close", NULL, js_close, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof props / sizeof props[0], props) != napi_ok) return NULL;
  return exports;
}
