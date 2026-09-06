/*
 * lease-helper: minimal macOS process-identity and advisory-lock helper for
 * the desktop home lease. It never boots DSH, never writes profile data, and
 * never prints argv/env of other processes.
 *
 * Protocol: one JSON object per line on stdout; diagnostics on stderr.
 *
 *   lease-helper identity <pid>
 *       -> {"ok":true,"pid":N,"start":"<bootSec>.<bootUsec>-<startSec>.<startUsec>"}
 *       -> {"ok":false,"error":"unknown"} (permission or missing process)
 *
 *   lease-helper probe <pid> <start>
 *       -> {"ok":true,"status":"same"|"absent"|"different"|"unknown"}
 *
 *   lease-helper scan <excludePidCsv> <entryRealpathCsv>
 *       -> {"ok":true,"result":"none"}
 *       -> {"ok":true,"result":"active","pid":N,"start":"..."}
 *       -> {"ok":true,"result":"unknown"}
 *
 *   lease-helper lock <guardPath> <parentDir> <parentDev> <parentIno> <retryMs>
 *       -> {"ok":true,"locked":true}   then holds flock(LOCK_EX) until stdin
 *          closes or a "release" line arrives, and exits 0.
 *       -> {"ok":false,"error":"busy"|"refused"}
 *
 * The helper exits non-zero on usage errors. On non-macOS builds it reports
 * "unsupported" so callers can degrade to injected probes.
 */

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#endif

static void print_result(const char *json) {
    if (printf("%s\n", json) < 0) exit(1);
    if (fflush(stdout) != 0) exit(1);
}

static void fail_with_errno(const char *error, int errorCode) {
    if (strncmp(error, "refused", 7) == 0 || strcmp(error, "unsupported") == 0 ||
        strcmp(error, "busy") == 0 || strcmp(error, "unknown") == 0) {
        printf("{\"ok\":false,\"error\":\"%s\",\"errno\":%d,\"errnoText\":\"%s\"}\n",
               error, errorCode, strerror(errorCode));
    } else {
        print_result("{\"ok\":false,\"error\":\"internal\"}");
    }
    fprintf(stderr, "lease-helper: %s (errno %d: %s)\n", error, errorCode, strerror(errorCode));
    fflush(stdout);
    exit(1);
}

static void fail(const char *error) {
    fail_with_errno(error, errno);
}

#if defined(__APPLE__)

#define PATH_BUFFER_SIZE PROC_PIDPATHINFO_MAXSIZE

static bool boot_identity(char *out, size_t capacity) {
    struct timeval boottime;
    size_t length = sizeof(boottime);
    int mib[2] = {CTL_KERN, KERN_BOOTTIME};
    if (sysctl(mib, 2, &boottime, &length, NULL, 0) != 0) return false;
    int written = snprintf(out, capacity, "%" PRIdMAX ".%06d",
                           (intmax_t)boottime.tv_sec, (int)boottime.tv_usec);
    return written > 0 && (size_t)written < capacity;
}

static bool process_identity(pid_t pid, char *out, size_t capacity) {
    /* Zero first AND demand a full-length fill: pbi_pid sits at the front of
     * the struct and the start time at the end, so a short proc_pidinfo fill
     * could yield a correct pid with a zero (or garbage) start time and read
     * as a bogus 'different'. Any result that is not exactly sizeof(info) is
     * unidentifiable. */
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) {
        return false;
    }
    if ((pid_t)info.pbi_pid != pid) return false;
    char boot[64];
    if (!boot_identity(boot, sizeof(boot))) return false;
    int written = snprintf(out, capacity, "%s-%" PRIdMAX ".%06" PRIdMAX,
                           boot, (intmax_t)info.pbi_start_tvsec,
                           (intmax_t)info.pbi_start_tvusec);
    return written > 0 && (size_t)written < capacity;
}

static int cmd_identity(const char *pidText) {
    char *end = NULL;
    long value = strtol(pidText, &end, 10);
    if (end == pidText || *end != '\0' || value <= 0) fail("invalid pid");
    char start[128];
    if (!process_identity((pid_t)value, start, sizeof(start))) {
        print_result("{\"ok\":false,\"error\":\"unknown\"}");
        return 1;
    }
    printf("{\"ok\":true,\"pid\":%ld,\"start\":\"%s\"}\n", value, start);
    return fflush(stdout) == 0 ? 0 : 1;
}

static int cmd_probe(const char *pidText, const char *expected) {
    char *end = NULL;
    long value = strtol(pidText, &end, 10);
    if (end == pidText || *end != '\0' || value <= 0) fail("invalid pid");
    char start[128];
    if (!process_identity((pid_t)value, start, sizeof(start))) {
        /* Distinguish "no such process" from "cannot look" (permissions). */
        struct proc_bsdinfo info;
        if (proc_pidinfo((pid_t)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) <= 0 &&
            (errno == ESRCH || errno == EINVAL)) {
            print_result("{\"ok\":true,\"status\":\"absent\"}");
        } else {
            print_result("{\"ok\":true,\"status\":\"unknown\"}");
        }
        return 0;
    }
    print_result(strcmp(start, expected) == 0
                     ? "{\"ok\":true,\"status\":\"same\"}"
                     : "{\"ok\":true,\"status\":\"different\"}");
    return 0;
}

static bool csv_contains(const char *csv, long value) {
    if (csv == NULL || csv[0] == '\0') return false;
    const char *cursor = csv;
    while (*cursor != '\0') {
        char *end = NULL;
        long item = strtol(cursor, &end, 10);
        if (end == cursor) return false;
        if (item == value) return true;
        cursor = (*end == ',') ? end + 1 : end;
    }
    return false;
}

/* Whether a pid is still a live, non-zombie process. Scans use this to skip
 * processes that died between the snapshot and inspection instead of failing
 * the whole scan as unknown: a dead process cannot be a live writer. */
static bool pid_exists(pid_t pid) {
    struct kinfo_proc info;
    size_t length = sizeof(info);
    static int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, 0};
    mib[3] = pid;
    memset(&info, 0, sizeof(info));
    if (sysctl(mib, 4, &info, &length, NULL, 0) != 0) return false;
    return length >= sizeof(info) && info.kp_proc.p_pid == pid &&
           info.kp_proc.p_stat != SZOMB;
}

static int cmd_scan(const char *excludeCsv, const char *entryCsv) {
    static int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t size = 0;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    struct kinfo_proc *processes = malloc(size);
    if (processes == NULL) fail("out of memory");
    if (sysctl(mib, 4, processes, &size, NULL, 0) != 0) {
        free(processes);
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    size_t count = size / sizeof(struct kinfo_proc);
    uid_t selfUid = geteuid();
    pid_t selfPid = getpid();
    char path[PATH_BUFFER_SIZE];
    char resolved[PATH_BUFFER_SIZE];
    for (size_t index = 0; index < count; index += 1) {
        pid_t pid = processes[index].kp_proc.p_pid;
        uid_t uid = processes[index].kp_eproc.e_ucred.cr_uid;
        if (pid == selfPid || uid != selfUid) continue;
        /* Zombies have no executable to resolve and cannot be a live writer. */
        if (processes[index].kp_proc.p_stat == SZOMB) continue;
        if (csv_contains(excludeCsv, (long)pid)) continue;
        int length = 0;
        int diagErrno = 0;
        for (int attempt = 0; attempt < 3 && length <= 0; attempt += 1) {
            errno = 0;
            length = proc_pidpath(pid, path, sizeof(path));
            diagErrno = errno;
            if (length <= 0 && !pid_exists(pid)) break;
            if (length <= 0 && attempt < 2) usleep(3000);
        }
        if (length <= 0) {
            if (!pid_exists(pid)) continue;
            fprintf(stderr, "lease-helper: scan unresolvable pid=%d errno=%d(%s) ppid=%d\n",
                    pid, diagErrno, strerror(diagErrno), processes[index].kp_eproc.e_ppid);
            /* Same-uid live process whose executable cannot be resolved even
             * after short retries: fail closed as unknown. */
            free(processes);
            print_result("{\"ok\":true,\"result\":\"unknown\"}");
            return 0;
        }
        path[length] = '\0';
        const char *cursor = entryCsv;
        while (cursor != NULL && *cursor != '\0') {
            const char *comma = strchr(cursor, ',');
            size_t entryLength = comma == NULL ? strlen(cursor) : (size_t)(comma - cursor);
            char entry[PATH_BUFFER_SIZE];
            if (entryLength >= sizeof(entry)) {
                entryLength = sizeof(entry) - 1;
            }
            memcpy(entry, cursor, entryLength);
            entry[entryLength] = '\0';
            if (strcmp(entry, path) == 0 ||
                (realpath(path, resolved) != NULL && strcmp(entry, resolved) == 0)) {
                char start[128];
                if (!process_identity(pid, start, sizeof(start))) {
                    free(processes);
                    print_result("{\"ok\":true,\"result\":\"unknown\"}");
                    return 0;
                }
                free(processes);
                printf("{\"ok\":true,\"result\":\"active\",\"pid\":%d,\"start\":\"%s\"}\n",
                       pid, start);
                fflush(stdout);
                return 0;
            }
            cursor = comma == NULL ? NULL : comma + 1;
        }
    }
    free(processes);
    print_result("{\"ok\":true,\"result\":\"none\"}");
    return 0;
}

#define ARGV_BUFFER_SIZE (64 * 1024)

/*
 * Match a process when one of its kernel-stored argv strings contains a
 * needle path. Doctor uses this to detect supported Node entrypoints
 * (dsh-native wrapper, CLI child, official dsh bin) that an executable-path
 * scan cannot distinguish from unrelated Node processes. Needle fields are
 * separated by \x1f; argv contents are matched in memory only and never
 * printed.
 */
typedef enum {
    ARGV_NO_MATCH,
    ARGV_MATCH,
    ARGV_UNKNOWN
} argv_match_t;

static argv_match_t argv_matches_needles(pid_t pid, const char *needleCsv) {
    if (needleCsv == NULL || needleCsv[0] == '\0') return ARGV_NO_MATCH;
    static int mib[3] = {CTL_KERN, KERN_PROCARGS2, 0};
    mib[2] = pid;
    size_t size = 0;
    char *buffer = NULL;
    for (int attempt = 0; attempt < 3; attempt += 1) {
        size = 0;
        if (sysctl(mib, 3, NULL, &size, NULL, 0) == 0) {
            if (size > ARGV_BUFFER_SIZE) size = ARGV_BUFFER_SIZE;
            buffer = malloc(size);
            if (buffer == NULL) fail("out of memory");
            if (sysctl(mib, 3, buffer, &size, NULL, 0) == 0) break;
            free(buffer);
            buffer = NULL;
        }
        if (errno == ESRCH) return ARGV_NO_MATCH;
        if (attempt < 2) usleep(3000);
    }
    if (buffer == NULL) return ARGV_UNKNOWN;
    if (size < 5) {
        free(buffer);
        return ARGV_NO_MATCH;
    }
    int argcCount;
    memcpy(&argcCount, buffer, sizeof(argcCount));
    if (argcCount < 0 || argcCount > 4096) {
        free(buffer);
        return ARGV_UNKNOWN;
    }
    size_t position = sizeof(argcCount);
    /* Skip the executable path that precedes argv[0]. */
    while (position < size && buffer[position] != '\0') position += 1;
    position += 1;
    for (int index = 0; index < argcCount && position < size; index += 1) {
        while (position < size && buffer[position] == '\0') position += 1;
        if (position >= size) break;
        const char *argument = buffer + position;
        size_t length = strnlen(argument, size - position);
        position += length + 1;
        const char *cursor = needleCsv;
        while (cursor != NULL && *cursor != '\0') {
            const char *separator = strchr(cursor, '\x1f');
            size_t needleLength =
                separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
            if (needleLength > 0 && needleLength <= length &&
                memmem(argument, length, cursor, needleLength) != NULL) {
                free(buffer);
                return ARGV_MATCH;
            }
            cursor = separator == NULL ? NULL : separator + 1;
        }
    }
    free(buffer);
    return ARGV_NO_MATCH;
}

static int cmd_scanargv(const char *excludeCsv, const char *needleCsv) {
    if (needleCsv == NULL || needleCsv[0] == '\0') {
        print_result("{\"ok\":true,\"result\":\"none\"}");
        return 0;
    }
    static int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t size = 0;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    struct kinfo_proc *processes = malloc(size);
    if (processes == NULL) fail("out of memory");
    if (sysctl(mib, 4, processes, &size, NULL, 0) != 0) {
        free(processes);
        print_result("{\"ok\":true,\"result\":\"unknown\"}");
        return 0;
    }
    size_t count = size / sizeof(struct kinfo_proc);
    uid_t selfUid = geteuid();
    pid_t selfPid = getpid();
    for (size_t index = 0; index < count; index += 1) {
        pid_t pid = processes[index].kp_proc.p_pid;
        uid_t uid = processes[index].kp_eproc.e_ucred.cr_uid;
        if (pid == selfPid || uid != selfUid) continue;
        if (processes[index].kp_proc.p_stat == SZOMB) continue;
        if (csv_contains(excludeCsv, (long)pid)) continue;
        argv_match_t matched = argv_matches_needles(pid, needleCsv);
        if (matched == ARGV_UNKNOWN) {
            if (!pid_exists(pid)) continue;
            free(processes);
            print_result("{\"ok\":true,\"result\":\"unknown\"}");
            return 0;
        }
        if (matched == ARGV_MATCH) {
            char start[128];
            if (!process_identity(pid, start, sizeof(start))) {
                free(processes);
                print_result("{\"ok\":true,\"result\":\"unknown\"}");
                return 0;
            }
            free(processes);
            printf("{\"ok\":true,\"result\":\"active\",\"pid\":%d,\"start\":\"%s\"}\n",
                   pid, start);
            fflush(stdout);
            return 0;
        }
    }
    free(processes);
    print_result("{\"ok\":true,\"result\":\"none\"}");
    return 0;
}

static int cmd_lock(const char *guardPath, const char *parentDir,
                    const char *parentDevText, const char *parentInoText,
                    const char *retryMsText) {
    /* Pin the parent directory by fd before touching the guard: a path-based
     * lstat-then-open sequence could observe a different directory between
     * the two steps. */
    int parentFd = open(parentDir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (parentFd < 0) fail("refused-parent");
    struct stat parent;
    if (fstat(parentFd, &parent) != 0 || !S_ISDIR(parent.st_mode)) {
        close(parentFd);
        fail("refused");
    }
    if ((uintmax_t)parent.st_dev != strtoumax(parentDevText, NULL, 10) ||
        (uintmax_t)parent.st_ino != strtoumax(parentInoText, NULL, 10)) {
        close(parentFd);
        fail("refused");
    }
    const char *separator = strrchr(guardPath, '/');
    const char *guardName = separator == NULL ? guardPath : separator + 1;
    if (guardName[0] == '\0') {
        close(parentFd);
        fail("refused");
    }
    long retryMs = strtol(retryMsText, NULL, 10);
    if (retryMs < 0) retryMs = 0;
    /* macOS mis-reports ENOENT when O_CREAT|O_NOFOLLOW hits a file that
     * concurrently came into existence, so create strictly exclusively and
     * fall back to a plain O_NOFOLLOW open for an already-existing guard. */
    int fd = -1;
    for (int attempt = 0; attempt < 3 && fd < 0; attempt += 1) {
        fd = openat(parentFd, guardName, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
        if (fd >= 0) break;
        if (errno != ENOENT) break;
        fd = openat(parentFd, guardName,
                    O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd >= 0) break;
        if (errno != EEXIST) break;
        fd = -1;
    }
    int openatError = errno;
    close(parentFd);
    if (fd < 0) {
        errno = openatError;
        fail("refused-openat");
    }

    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (retryMs == 0) {
            close(fd);
            print_result("{\"ok\":false,\"error\":\"busy\"}");
            return 3;
        }
        const long stepMs = 20;
        long waited = 0;
        while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
            if (waited >= retryMs) {
                close(fd);
                print_result("{\"ok\":false,\"error\":\"busy\"}");
                return 3;
            }
            usleep((useconds_t)stepMs * 1000);
            waited += stepMs;
        }
    }
    struct stat held;
    if (fstat(fd, &held) != 0 || !S_ISREG(held.st_mode)) {
        close(fd);
        fail("refused");
    }
    print_result("{\"ok\":true,\"locked\":true}");
    char line[32];
    while (fgets(line, sizeof(line), stdin) != NULL) {
        if (strncmp(line, "release", 7) == 0) break;
    }
    close(fd);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "identity") == 0 && argc == 3) {
        return cmd_identity(argv[2]);
    }
    if (argc == 4 && strcmp(argv[1], "probe") == 0) {
        return cmd_probe(argv[2], argv[3]);
    }
    if (argc == 4 && strcmp(argv[1], "scan") == 0) {
        return cmd_scan(argv[2], argv[3]);
    }
    if (argc == 4 && strcmp(argv[1], "scanargv") == 0) {
        return cmd_scanargv(argv[2], argv[3]);
    }
    if (argc == 7 && strcmp(argv[1], "lock") == 0) {
        return cmd_lock(argv[2], argv[3], argv[4], argv[5], argv[6]);
    }
    fail("usage");
    return 1;
}

#else

int main(void) {
    fail("unsupported");
    return 1;
}

#endif
