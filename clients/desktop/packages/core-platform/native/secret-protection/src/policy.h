/* V-3/V-6 identity rules align with TypeScript policy.ts.
 * D3 selects the login Keychain; D6 limits the fixture to native CI coverage.
 * D4's serialized unlock-only UI is owned by the executor, not this policy.
 */
#ifndef CANOPY_SECRET_PROTECTION_POLICY_H
#define CANOPY_SECRET_PROTECTION_POLICY_H

static bool policy_valid_service(const char *service) {
    const char *brands[] = { "canopy", "unstoppable-code" };
    const char *builds[] = { "stable", "internal", "rc", "dev" };
    char expected[TEXT];
    for (size_t b = 0; b < sizeof brands / sizeof brands[0]; ++b) {
        for (size_t v = 0; v < sizeof builds / sizeof builds[0]; ++v) {
            snprintf(expected, sizeof expected, "%s.%s.vault", brands[b], builds[v]);
            if (!strcmp(service, expected)) return true;
        }
    }
    return false;
}

/* Keep aligned with keychainAccount and authority validation in policy.ts. */
static bool policy_valid_account(const char *service, const char *account) {
    size_t prefix = strlen(service), len = strlen(account);
    size_t authority = prefix + 1, slot = authority + 65;
    if (len < slot + 1 || len > slot + 64 ||
        strncmp(account, service, prefix) || account[prefix] != '/' || account[slot - 1] != '/') return false;
    for (size_t i = authority; i < authority + 64; ++i)
        if (!((account[i] >= 'a' && account[i] <= 'f') || (account[i] >= '0' && account[i] <= '9'))) return false;
    for (size_t i = slot; i < len; ++i) {
        char c = account[i];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (i > slot && c == '-')) continue;
        return false;
    }
    return true;
}

#ifdef __APPLE__
static OSStatus policy_open_keychain(const char *fixture_path, SecKeychainRef *keychain) {
#if KEYCHAIN_FIXTURE
    return SecKeychainOpen(fixture_path, keychain);
#else
    (void)fixture_path;
    /* Explicit login Keychain; never the mutable default or global search list. */
    struct passwd pwd, *found = NULL;
    char storage[16384], path[PATH_SIZE];
    if (getpwuid_r(getuid(), &pwd, storage, sizeof storage, &found) || !found || !found->pw_dir || found->pw_dir[0] != '/')
        return errSecNotAvailable;
    int length = snprintf(path, sizeof path, "%s/Library/Keychains/login.keychain-db", found->pw_dir);
    if (length < 0 || length >= (int)sizeof path) return errSecNotAvailable;
    return SecKeychainOpen(path, keychain);
#endif
}

static OSStatus policy_create_access(CFStringRef service, SecAccessRef *access) {
    /* NULL list restricts the ACL to the creator's designated requirement. */
    return SecAccessCreate(service, NULL, access);
}

#endif /* __APPLE__ */

#endif
