#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <assert.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

static DWORD open_error, waits[2];
static int opened, closed, waited, queried, time_ok, close_ok;
static ULONGLONG creation;
static HANDLE fake_open(DWORD rights, BOOL inherit, DWORD pid) {
  assert(rights == (PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE));
  assert(!inherit && pid == 4242);
  ++opened;
  return open_error ? NULL : (HANDLE)(ULONG_PTR)42;
}
static DWORD fake_error(void) { return open_error; }
static DWORD fake_wait(HANDLE handle, DWORD timeout) {
  assert(handle == (HANDLE)(ULONG_PTR)42 && timeout == 0 && waited < 2);
  return waits[waited++];
}
static BOOL fake_times(HANDLE handle, LPFILETIME start, LPFILETIME end,
                       LPFILETIME kernel, LPFILETIME user) {
  assert(handle == (HANDLE)(ULONG_PTR)42);
  (void)end; (void)kernel; (void)user;
  ++queried;
  start->dwLowDateTime = (DWORD)creation;
  start->dwHighDateTime = (DWORD)(creation >> 32);
  return time_ok;
}
static HANDLE closed_handle;
static BOOL fake_close(HANDLE handle) {
  assert(handle == (HANDLE)(ULONG_PTR)42 || handle == (HANDLE)(ULONG_PTR)43);
  closed_handle = handle;
  ++closed; return close_ok;
}
static int token_opened, token_ok, info_ok;
/* One spare subauthority: a count-16 SID still fits the padded union. */
static BYTE sid_bytes[SECURITY_MAX_SID_SIZE + sizeof(DWORD)];
static size_t sid_length;
static LONG_PTR sid_shift, returned_delta;
static DWORD attributes;
static HANDLE fake_current(void) { return (HANDLE)(LONG_PTR)-1; }
static BOOL fake_open_token(HANDLE process, DWORD access, PHANDLE token) {
  assert(process == (HANDLE)(LONG_PTR)-1 && access == TOKEN_QUERY);
  ++token_opened;
  if (!token_ok) return FALSE;
  *token = (HANDLE)(ULONG_PTR)43;
  return TRUE;
}
static BOOL fake_token_info(HANDLE token, TOKEN_INFORMATION_CLASS kind,
                            LPVOID buffer, DWORD length, PDWORD returned) {
  BYTE *raw = buffer;
  TOKEN_USER *user = buffer;
  assert(token == (HANDLE)(ULONG_PTR)43 && kind == TokenUser);
  assert(length >= sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE);
  assert(length >= sizeof(TOKEN_USER) + sid_length);
  ++queried;
  memset(raw, 0, sizeof(TOKEN_USER));
  memcpy(raw + sizeof(TOKEN_USER), sid_bytes, sid_length);
  user->User.Sid = raw + sizeof(TOKEN_USER) + sid_shift;
  user->User.Attributes = attributes;
  *returned = (DWORD)((LONG_PTR)(sizeof(TOKEN_USER) + sid_length) + returned_delta);
  return info_ok;
}
static int write_ok = 1, flush_ok = 1, writes, flushes;
static char receipt[256];
static int fake_printf(const char *format, ...) {
  int result;
  va_list args;
  ++writes;
  va_start(args, format);
  result = vsnprintf(receipt, sizeof(receipt), format, args);
  va_end(args);
  return write_ok ? result : -1;
}
static int fake_puts(const char *text) { return fake_printf("%s\n", text); }
static int fake_flush(FILE *stream) {
  assert(stream == stdout);
  ++flushes;
  return flush_ok ? 0 : EOF;
}
#define printf fake_printf
#define puts fake_puts
#define fflush fake_flush
#define OpenProcess fake_open
#define GetLastError fake_error
#define WaitForSingleObject fake_wait
#define GetProcessTimes fake_times
#define CloseHandle fake_close
#define GetCurrentProcess fake_current
#define OpenProcessToken fake_open_token
#define GetTokenInformation fake_token_info
#define PROCESS_IDENTITY_TEST
#include "process-identity.c"

static void reset(void) {
  opened = closed = waited = queried = token_opened = 0;
  closed_handle = NULL;
  open_error = 0; time_ok = close_ok = token_ok = info_ok = 1;
  waits[0] = waits[1] = WAIT_TIMEOUT;
  creation = 134359142061234569ULL;
  sid_shift = returned_delta = 0; attributes = 0;
}
/* Binary SID: revision, count, big-endian 48-bit authority, LE subauthorities. */
static void make_sid(BYTE revision, BYTE count, ULONGLONG authority,
                const DWORD *parts, size_t stored) {
  size_t index;
  reset();
  sid_bytes[0] = revision; sid_bytes[1] = count;
  for (index = 0; index < 6; ++index)
    sid_bytes[2 + index] = (BYTE)(authority >> (8 * (5 - index)));
  for (index = 0; index < stored; ++index)
    memcpy(sid_bytes + 8 + 4 * index, parts + index, sizeof(DWORD));
  sid_length = 8 + 4 * stored;
}
static int principal(char *text) {
  int result;
  memset(text, 'x', SID_TEXT_MAX + 1);
  result = observe_principal(text);
  assert(token_opened == 1 && closed == (token_ok ? 1 : 0));
  /* Only the opened token closes; the current-process pseudo-handle never does. */
  assert(closed_handle == (token_ok ? (HANDLE)(ULONG_PTR)43 : NULL));
  return result;
}
static int run(const char *argument) {
  char program[] = "canopy-process-identity.exe";
  char copy[64];
  char *argv[3];
  argv[0] = program; argv[1] = copy; argv[2] = NULL;
  assert(strlen(argument) < sizeof copy);
  memcpy(copy, argument, strlen(argument) + 1);
  receipt[0] = '\0';
  return dispatch(2, argv);
}
int main(void) {
  ULONGLONG ticks;
  int index;
  DWORD pid;
  size_t bad;
  const char *invalid[] = {"", "0", "1", "-2", "02", "2.0", " 2", "2147483648", "4294967295", "4294967296", "18446744073709551616"};
  assert(parse_pid("2", &pid) == 0 && pid == 2);
  assert(parse_pid("2147483647", &pid) == 0 && pid == 2147483647);
  for (bad = 0; bad < sizeof(invalid) / sizeof(invalid[0]); ++bad)
    assert(parse_pid(invalid[bad], &pid) == 1);
  assert(write_receipt(1, 4242, 0) == 1 && writes == 0 && flushes == 0);
  assert(write_receipt(0, 4242, 134359142061234569ULL) == 0);
  assert(strcmp(receipt, "canopy-process-v1 4242 134359142061234569\n") == 0);
  assert(write_receipt(2, 4242, 0) == 0);
  assert(strcmp(receipt, "canopy-process-v1 absent\n") == 0);
  flush_ok = 0;
  assert(write_receipt(0, 4242, 42) == 1 && flushes == 3);
  write_ok = 0;
  assert(write_receipt(2, 4242, 0) == 1);
  for (index = 0; index < 1000; ++index) {
    reset(); assert(observe_process(4242, &ticks) == 0);
    assert(opened == 1 && closed == 1 && waited == 2 && queried == 1);
    assert(closed_handle == (HANDLE)(ULONG_PTR)42);
    assert(ticks == creation);
  }
  reset(); open_error = ERROR_INVALID_PARAMETER;
  assert(observe_process(4242, &ticks) == 2 && closed == 0);
  reset(); open_error = ERROR_ACCESS_DENIED;
  assert(observe_process(4242, &ticks) == 1 && closed == 0);
  reset(); open_error = ERROR_GEN_FAILURE;
  assert(observe_process(4242, &ticks) == 1 && closed == 0);
  for (index = 0; index < 2; ++index) {
    reset(); waits[index] = WAIT_OBJECT_0;
    assert(observe_process(4242, &ticks) == 1 && closed == 1);
    reset(); waits[index] = WAIT_FAILED;
    assert(observe_process(4242, &ticks) == 1 && closed == 1);
  }
  reset(); time_ok = 0;
  assert(observe_process(4242, &ticks) == 1 && closed == 1 && waited == 1);
  reset(); close_ok = 0;
  assert(observe_process(4242, &ticks) == 1 && closed == 1);
  for (index = 0; index <= 9; ++index) {
    reset(); creation = (ULONGLONG)index;
    assert(observe_process(4242, &ticks) == 1 && closed == 1);
  }
  reset(); creation = 2650467744000000000ULL;
  assert(observe_process(4242, &ticks) == 1 && closed == 1);
  {
    static const DWORD user[] = {21, 1004336348, 1177238915, 682003330, 1001};
    static const DWORD zero[] = {0};
    DWORD max[16];
    char text[SID_TEXT_MAX + 1];
    const char *unsupported[] = {"", "--token-user ", "--TOKEN-USER",
                                 "-token-user", "--token-user=1", "--principal",
                                 "0", "1"};
    for (index = 0; index < 16; ++index) max[index] = 4294967295UL;
    for (index = 0; index < 1000; ++index) {
      make_sid(1, 5, 5, user, 5);
      assert(principal(text) == 0 && queried == 1);
      assert(strcmp(text, "S-1-5-21-1004336348-1177238915-682003330-1001") == 0);
    }
    make_sid(1, 0, 5, NULL, 0);
    assert(principal(text) == 0 && strcmp(text, "S-1-5") == 0);
    make_sid(1, 1, 0, zero, 1);
    assert(principal(text) == 0 && strcmp(text, "S-1-0-0") == 0);
    /* Large authorities stay decimal, never ConvertSidToStringSid's 0x form. */
    make_sid(1, 1, 4294967296ULL, zero, 1);
    assert(principal(text) == 0 && strcmp(text, "S-1-4294967296-0") == 0);
    make_sid(1, 15, 281474976710655ULL, max, 15);
    assert(principal(text) == 0 && strlen(text) == SID_TEXT_MAX);
    assert(strncmp(text, "S-1-281474976710655-4294967295-", 31) == 0);
    /* Revision, count, truncation and placement failures still close once. */
    make_sid(2, 1, 5, zero, 1); assert(principal(text) == 1);
    make_sid(0, 1, 5, zero, 1); assert(principal(text) == 1);
    /* A complete 16-subauthority SID fits the buffer; only the count bound refuses it. */
    make_sid(1, 16, 5, max, 16); assert(principal(text) == 1);
    make_sid(1, 5, 5, user, 4); assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); sid_length = 7; assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); sid_shift = -(LONG_PTR)sizeof(TOKEN_USER);
    assert(principal(text) == 1);
    /* Without the placement guard, Attributes would parse as a valid S-1-0-257. */
    make_sid(1, 1, 5, zero, 1); sid_shift = -8; attributes = 0x0101;
    assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); sid_shift = 13; assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); sid_shift = -4096; assert(principal(text) == 1);
    /* A reported size ending before the SID must not underflow its length. */
    make_sid(1, 1, 5, zero, 1); returned_delta = -(LONG_PTR)(sid_length + 1);
    assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); returned_delta = 1024; assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); token_ok = 0;
    assert(principal(text) == 1 && queried == 0);
    make_sid(1, 1, 5, zero, 1); info_ok = 0; assert(principal(text) == 1);
    make_sid(1, 1, 5, zero, 1); close_ok = 0;
    assert(principal(text) == 1 && queried == 1);
    /* Receipts, fixed dispatch and PID-mode compatibility. */
    write_ok = flush_ok = 1; writes = flushes = 0;
    assert(write_principal("S-1-5-18") == 0 && flushes == 1);
    assert(strcmp(receipt, "canopy-principal-v1 S-1-5-18\n") == 0);
    flush_ok = 0; assert(write_principal("S-1-5-18") == 1);
    flush_ok = 1; write_ok = 0; assert(write_principal("S-1-5-18") == 1);
    write_ok = 1;
    make_sid(1, 5, 5, user, 5);
    assert(run("--token-user") == 0 && token_opened == 1 && closed == 1);
    assert(strcmp(receipt, "canopy-principal-v1 "
                           "S-1-5-21-1004336348-1177238915-682003330-1001\n") == 0);
    make_sid(1, 5, 5, user, 5); info_ok = 0; writes = 0;
    assert(run("--token-user") == 1 && writes == 0 && closed == 1);
    for (bad = 0; bad < sizeof(unsupported) / sizeof(unsupported[0]); ++bad) {
      reset(); writes = 0;
      assert(run(unsupported[bad]) == 1 && writes == 0);
      assert(token_opened == 0 && opened == 0);
    }
    /* The receipt carries the observed time, not ticks read before the query. */
    reset(); writes = 0;
    assert(run("4242") == 0 && opened == 1 && token_opened == 0);
    assert(queried == 1 && closed == 1 && writes == 1);
    assert(strcmp(receipt, "canopy-process-v1 4242 134359142061234569\n") == 0);
    reset(); creation = 2650467743999999999ULL;
    assert(run("4242") == 0);
    assert(strcmp(receipt, "canopy-process-v1 4242 2650467743999999999\n") == 0);
    reset(); open_error = ERROR_INVALID_PARAMETER;
    assert(run("4242") == 0 && closed == 0);
    assert(strcmp(receipt, "canopy-process-v1 absent\n") == 0);
    reset(); time_ok = 0; writes = 0;
    assert(run("4242") == 1 && writes == 0 && closed == 1);
    reset(); close_ok = 0; writes = 0;
    assert(run("4242") == 1 && writes == 0 && queried == 1);
    reset(); assert(dispatch(1, NULL) == 1 && opened == 0 && token_opened == 0);
  }
  return 0;
}
