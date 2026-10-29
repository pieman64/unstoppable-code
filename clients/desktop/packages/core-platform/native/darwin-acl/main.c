#include "operation.h"
#include <signal.h>
#include <stdlib.h>
#include <string.h>

static int ignore_sigpipe(void) {
    struct sigaction action = {0};
    action.sa_handler = SIG_IGN;
    if (sigemptyset(&action.sa_mask) != 0) return -1;
    return sigaction(SIGPIPE, &action, NULL);
}

static int attributes(int fd, struct attrlist *query, void *buffer,
                      size_t size, unsigned long options) {
    return fgetattrlist(fd, query, buffer, size, (unsigned int)options);
}

/* No runtime injection or fault selection in the product executable. */
static const struct acl_operations real_operations = {
    malloc, free, filesec_init, filesec_free, filesec_set_property,
    fstatx_np, fchmodx_np, filesec_query_property, filesec_get_property,
    acl_valid, acl_free, attributes, write, close, ignore_sigpipe
};

int main(int argc, const char **argv) {
    int code = acl_helper_run(argc, argv, &real_operations);
    const char *message = code == 64 ? "ACL helper usage\n" :
                          code == 70 ? "ACL helper operation failed\n" :
                          "ACL helper output failed\n";
    if (code) (void)write(2, message, strlen(message));
    return code;
}
