/*
 * cp-supervise: the Claude Penguin process supervisor shim.
 *
 *   cp-supervise --owner-pid <pid> --record <path> --stop-signal <SIGTERM|SIGINT|SIGQUIT|SIGHUP>
 *                --grace-ms <n> [--cwd <dir>] -- <program> [args...]
 *   cp-supervise guard --owner-pid <pid> [--stop-signal <SIG>] [--grace-ms <n>] -- <program> [args...]
 *   cp-supervise lock <fd>
 *
 * Starts <program> in a new process group (the program is the group leader), forwards
 * SIGTERM/SIGINT/SIGHUP to that group, and watches the owner with kqueue EVFILT_PROC.
 * When the owner exits (or the shim gets SIGUSR1, the controller's "stop now" request)
 * it sends the stop signal to the program, waits the grace period, SIGKILLs the whole
 * group and confirms the group is gone. It exits with the program's status.
 *
 * <record>.child (written atomically after the program starts) holds
 * {"pid":N,"pgid":N,"shimPid":N,"startSec":N} so a later controller can identify the
 * program even if this shim is killed.
 *
 * Exit codes: the program's status (128+signal if signalled); 127 exec failed;
 * 70 internal error or exit could not be confirmed; 71 owner already dead at startup;
 * 64 usage; for `lock`: 0 acquired, 75 held by another description.
 */
#include <errno.h>
#include <libproc.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/file.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define EX_USAGE 64
#define EX_SOFTWARE 70
#define EX_OWNER_DEAD 71
#define EX_TEMPFAIL 75

static pid_t child_pid = -1;
static int stop_signal = SIGTERM;
static int grace_ms = 5000;

static void fail(int code, const char *what) {
  fprintf(stderr, "cp-supervise: %s: %s\n", what, strerror(errno));
  exit(code);
}

static int parse_signal(const char *name) {
  if (!strcmp(name, "SIGTERM")) return SIGTERM;
  if (!strcmp(name, "SIGINT")) return SIGINT;
  if (!strcmp(name, "SIGQUIT")) return SIGQUIT;
  if (!strcmp(name, "SIGHUP")) return SIGHUP;
  return -1;
}

static int group_alive(void) {
  if (child_pid <= 0) return 0;
  return kill(-child_pid, 0) == 0 || errno == EPERM;
}

static long start_seconds(pid_t pid) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  struct kinfo_proc info;
  size_t size = sizeof info;
  memset(&info, 0, sizeof info);
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return 0;
  return (long)info.kp_proc.p_starttime.tv_sec;
}

static void write_sidecar(const char *record) {
  char final_path[4096], tmp_path[4112], body[256];
  if (snprintf(final_path, sizeof final_path, "%s.child", record) >= (int)sizeof final_path) return;
  snprintf(tmp_path, sizeof tmp_path, "%s.tmp%d", final_path, (int)getpid());
  int n = snprintf(body, sizeof body, "{\"pid\":%d,\"pgid\":%d,\"shimPid\":%d,\"startSec\":%ld}\n",
                   (int)child_pid, (int)child_pid, (int)getpid(), start_seconds(child_pid));
  int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return;
  ssize_t written = write(fd, body, (size_t)n);
  close(fd);
  if (written != n || rename(tmp_path, final_path) != 0) unlink(tmp_path);
}

static int run_lock(const char *arg) {
  char *end = NULL;
  long fd = strtol(arg, &end, 10);
  if (!*arg || *end || fd < 0) { fprintf(stderr, "cp-supervise lock: bad descriptor\n"); return EX_USAGE; }
  if (flock((int)fd, LOCK_EX | LOCK_NB) == 0) return 0;
  if (errno == EWOULDBLOCK) return EX_TEMPFAIL;
  fprintf(stderr, "cp-supervise lock: %s\n", strerror(errno));
  return EX_SOFTWARE;
}

static int status_to_exit(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return EX_SOFTWARE;
}

static void usage(void) {
  fprintf(stderr, "usage: cp-supervise --owner-pid <pid> --record <file> --stop-signal <SIG> --grace-ms <n> [--cwd <dir>] -- <program> [args...]\n"
                  "       cp-supervise guard --owner-pid <pid> [--stop-signal <SIG>] [--grace-ms <n>] -- <program> [args...]\n"
                  "       cp-supervise lock <fd>\n"
                  "       cp-supervise pidpath <pid>\n");
  exit(EX_USAGE);
}

/* The kernel's record of the executable (proc_pidpath). Unlike `ps -o comm=`,
 * it is unaffected by programs that rewrite their own process title (Valkey). */
static int run_pidpath(const char *arg) {
  char *end = NULL;
  long pid = strtol(arg, &end, 10);
  if (!end || *end || pid <= 0) usage();
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath((pid_t)pid, path, sizeof path) <= 0) return 1;
  printf("%s\n", path);
  return 0;
}

static long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long)tv.tv_sec * 1000L + tv.tv_usec / 1000L;
}

static int pgrp_alive(pid_t group) {
  return group > 1 && (kill(-group, 0) == 0 || errno == EPERM);
}

/* Closes every descriptor above stderr except `keep` (listed with proc_pidinfo, so a raised
 * descriptor limit costs nothing). */
static void close_others(int keep) {
  int bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes <= 0) return;
  struct proc_fdinfo *fds = malloc((size_t)bytes);
  if (!fds) return;
  bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, bytes);
  for (int k = 0; bytes > 0 && k < bytes / (int)sizeof *fds; k++) {
    if (fds[k].proc_fd > 2 && fds[k].proc_fd != keep) close(fds[k].proc_fd);
  }
  free(fds);
}

/* SIGKILLs what is left of `group` and waits up to 3 s for it to empty. */
static int sweep_group(pid_t group) {
  if (!pgrp_alive(group)) return 0;
  kill(-group, SIGKILL);
  long give_up = now_ms() + 3000;
  while (pgrp_alive(group) && now_ms() < give_up) usleep(10000);
  return pgrp_alive(group) ? -1 : 0;
}

/* The watcher half of `guard` (runs detached, in its own session, with no terminal). */
static void guard_watch(pid_t owner, pid_t target, int ready_fd) {
  int kq = kqueue();
  if (kq < 0) _exit(EX_SOFTWARE);
  struct kevent change;
  int owner_gone = 0, target_gone = 0;
  EV_SET(&change, owner, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) owner_gone = 1;
  EV_SET(&change, target, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) target_gone = 1;
  /* Both watches exist before the program is allowed to exec, so its PID cannot be reused unseen. */
  (void)!write(ready_fd, "1", 1);
  close(ready_fd);

  while (!owner_gone && !target_gone) {
    struct kevent events[2];
    struct timespec wait = {1, 0}; /* bounded: a missed NOTE_EXIT can never wedge the watcher */
    int n = kevent(kq, NULL, 0, events, 2, &wait);
    for (int e = 0; e < n; e++) {
      if ((pid_t)events[e].ident == owner) owner_gone = 1;
      if ((pid_t)events[e].ident == target) target_gone = 1;
    }
    if (n == 0) {
      if (kill(owner, 0) != 0 && errno == ESRCH) owner_gone = 1;
      if (kill(target, 0) != 0 && errno == ESRCH) target_gone = 1;
    }
  }
  if (!target_gone) {
    /* The owner died first: stop the program as the owner itself would, then take its group down. */
    kill(target, stop_signal);
    long deadline = now_ms() + grace_ms;
    while (!target_gone && now_ms() < deadline) {
      struct kevent event;
      long left = deadline - now_ms();
      struct timespec wait = {left / 1000, (left % 1000) * 1000000L};
      if (kevent(kq, NULL, 0, &event, 1, &wait) > 0 && (pid_t)event.ident == target) target_gone = 1;
      else if (kill(target, 0) != 0 && errno == ESRCH) target_gone = 1;
    }
  }
  _exit(sweep_group(target) == 0 ? 0 : EX_SOFTWARE);
}

/*
 * cp-supervise guard --owner-pid <pid> [--stop-signal <SIG>] [--grace-ms <n>] -- <program> [args...]
 *
 * Execs <program> in place, so it keeps this PID, session, terminal and process group, after
 * starting a detached watcher. When the owner exits first, the watcher sends the stop signal to
 * the program, waits the grace period, SIGKILLs the program's process group and confirms it is
 * empty. When the program exits first, the watcher sweeps what is left of its group and exits.
 * For Claude's terminals: node-pty gives each one its own session, outside the engine's group,
 * so a killed engine's own shim cannot reach them. The program must lead its process group.
 */
static int run_guard(int argc, char **argv) {
  pid_t owner = 0;
  stop_signal = SIGTERM;
  grace_ms = 1500;
  int i = 2;
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (i + 1 >= argc) usage();
    if (!strcmp(argv[i], "--owner-pid")) owner = (pid_t)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--stop-signal")) { stop_signal = parse_signal(argv[++i]); if (stop_signal < 0) usage(); }
    else if (!strcmp(argv[i], "--grace-ms")) { grace_ms = atoi(argv[++i]); if (grace_ms < 0) usage(); }
    else usage();
  }
  if (owner <= 1 || i >= argc) usage();
  char **program = argv + i;
  pid_t self = getpid();
  if (getpgrp() != self) {
    fprintf(stderr, "cp-supervise guard: the program must lead its own process group (start it in a new session, as a terminal does)\n");
    return EX_SOFTWARE;
  }
  if (kill(owner, 0) != 0 && errno == ESRCH) {
    fprintf(stderr, "cp-supervise guard: owner %d is not running; not starting the program\n", (int)owner);
    return EX_OWNER_DEAD;
  }
  int ready[2];
  if (pipe(ready) != 0) fail(EX_SOFTWARE, "pipe");
  fcntl(ready[0], F_SETFD, FD_CLOEXEC);
  fcntl(ready[1], F_SETFD, FD_CLOEXEC);
  pid_t middle = fork();
  if (middle < 0) fail(EX_SOFTWARE, "fork");
  if (middle == 0) {
    /* Double fork: the watcher is reparented to launchd and is never the program's child. */
    pid_t watcher = fork();
    if (watcher != 0) _exit(watcher < 0 ? EX_SOFTWARE : 0);
    close(ready[0]);
    setsid(); /* its own session: no terminal, outside the program's group */
    signal(SIGHUP, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);
    int null = open("/dev/null", O_RDWR);
    if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }
    close_others(ready[1]); /* above all, never hold the terminal open after the program exits */
    guard_watch(owner, self, ready[1]);
  }
  close(ready[1]);
  int status = 0;
  while (waitpid(middle, &status, 0) < 0 && errno == EINTR) {}
  char ok = 0;
  ssize_t got;
  while ((got = read(ready[0], &ok, 1)) < 0 && errno == EINTR) {}
  close(ready[0]);
  if (got != 1) { fprintf(stderr, "cp-supervise guard: the watcher did not start\n"); return EX_SOFTWARE; }
  execvp(program[0], program);
  fprintf(stderr, "cp-supervise guard: exec %s: %s\n", program[0], strerror(errno));
  return 127;
}

int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "guard")) return run_guard(argc, argv);
  if (argc >= 2 && !strcmp(argv[1], "pidpath")) {
    if (argc != 3) usage();
    return run_pidpath(argv[2]);
  }
  if (argc >= 2 && !strcmp(argv[1], "lock")) {
    if (argc != 3) usage();
    return run_lock(argv[2]);
  }
  pid_t owner = 0;
  const char *record = NULL, *cwd = NULL;
  int i = 1;
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (i + 1 >= argc) usage();
    if (!strcmp(argv[i], "--owner-pid")) owner = (pid_t)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--record")) record = argv[++i];
    else if (!strcmp(argv[i], "--stop-signal")) { stop_signal = parse_signal(argv[++i]); if (stop_signal < 0) usage(); }
    else if (!strcmp(argv[i], "--grace-ms")) { grace_ms = atoi(argv[++i]); if (grace_ms < 0) usage(); }
    else if (!strcmp(argv[i], "--cwd")) cwd = argv[++i];
    else usage();
  }
  if (owner <= 1 || i >= argc) usage();
  char **program = argv + i;

  int kq = kqueue();
  if (kq < 0) fail(EX_SOFTWARE, "kqueue");

  /* Watch the owner before starting anything: an owner that is already gone means we never start. */
  struct kevent change, result;
  EV_SET(&change, owner, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  int registered = kevent(kq, &change, 1, &result, 1, &(struct timespec){0, 0});
  if (registered < 0) {
    if (errno == ESRCH) { fprintf(stderr, "cp-supervise: owner %d is not running; not starting the program\n", (int)owner); return EX_OWNER_DEAD; }
    fail(EX_SOFTWARE, "watch owner");
  }
  if (registered > 0 && (result.flags & EV_ERROR) && result.data == ESRCH) {
    fprintf(stderr, "cp-supervise: owner %d is not running; not starting the program\n", (int)owner);
    return EX_OWNER_DEAD;
  }
  if (registered > 0 && result.filter == EVFILT_PROC && (result.fflags & NOTE_EXIT)) {
    fprintf(stderr, "cp-supervise: owner %d exited before the program started\n", (int)owner);
    return EX_OWNER_DEAD;
  }

  const int forwarded[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR1};
  sigset_t block, previous;
  sigemptyset(&block);
  for (size_t s = 0; s < sizeof forwarded / sizeof *forwarded; s++) {
    sigaddset(&block, forwarded[s]);
    signal(forwarded[s], SIG_IGN);
    EV_SET(&change, forwarded[s], EVFILT_SIGNAL, EV_ADD | EV_ENABLE, 0, 0, NULL);
    if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) fail(EX_SOFTWARE, "watch signal");
  }
  signal(SIGPIPE, SIG_IGN);
  sigprocmask(SIG_BLOCK, &block, &previous);

  child_pid = fork();
  if (child_pid < 0) fail(EX_SOFTWARE, "fork");
  if (child_pid == 0) {
    setpgid(0, 0);
    for (size_t s = 0; s < sizeof forwarded / sizeof *forwarded; s++) signal(forwarded[s], SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    if (cwd && chdir(cwd) != 0) { fprintf(stderr, "cp-supervise: chdir %s: %s\n", cwd, strerror(errno)); _exit(127); }
    execvp(program[0], program);
    fprintf(stderr, "cp-supervise: exec %s: %s\n", program[0], strerror(errno));
    _exit(127);
  }
  setpgid(child_pid, child_pid); /* also done by the child; whichever runs first wins */
  if (record) write_sidecar(record);

  /* The owner may have died between the check above and the fork; kqueue still reports it. */
  EV_SET(&change, child_pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  kevent(kq, &change, 1, NULL, 0, NULL); /* ESRCH here means it already exited; waitpid below handles it */

  int stopping = 0, killed = 0, child_done = 0, child_status = 0;
  struct timespec poll_wait = {0, 0};
  long deadline_ms = -1; /* absolute, from CLOCK_MONOTONIC-like gettimeofday */
  struct timeval now;
  #define NOW_MS() (gettimeofday(&now, NULL), (long)now.tv_sec * 1000L + now.tv_usec / 1000L)

  for (;;) {
    if (!child_done) {
      pid_t reaped = waitpid(child_pid, &child_status, WNOHANG);
      if (reaped == child_pid) child_done = 1;
    }
    if (child_done) {
      /* Leader gone: sweep whatever it left in the group, then confirm the group is empty. */
      if (group_alive()) {
        kill(-child_pid, SIGKILL);
        long give_up = NOW_MS() + 3000;
        while (group_alive() && NOW_MS() < give_up) usleep(10000);
        if (group_alive()) { fprintf(stderr, "cp-supervise: process group %d did not exit\n", (int)child_pid); return EX_SOFTWARE; }
      }
      return status_to_exit(child_status);
    }
    long wait_ms = 200; /* bounded so a missed NOTE_EXIT can never wedge the loop */
    if (stopping && !killed) {
      long left = deadline_ms - NOW_MS();
      if (left <= 0) {
        kill(-child_pid, SIGKILL);
        killed = 1;
        deadline_ms = NOW_MS() + 5000;
        continue;
      }
      if (left < wait_ms) wait_ms = left;
    } else if (killed && NOW_MS() > deadline_ms) {
      fprintf(stderr, "cp-supervise: program %d did not exit after SIGKILL\n", (int)child_pid);
      return EX_SOFTWARE;
    }
    poll_wait.tv_sec = wait_ms / 1000;
    poll_wait.tv_nsec = (wait_ms % 1000) * 1000000L;
    struct kevent events[8];
    int n = kevent(kq, NULL, 0, events, 8, &poll_wait);
    if (n < 0 && errno != EINTR) fail(EX_SOFTWARE, "kevent");
    for (int e = 0; e < n; e++) {
      if (events[e].filter == EVFILT_PROC && (pid_t)events[e].ident == owner && !stopping) {
        stopping = 1;
        fprintf(stderr, "cp-supervise: owner %d exited; stopping the program\n", (int)owner);
        kill(child_pid, stop_signal);
        deadline_ms = NOW_MS() + grace_ms;
      } else if (events[e].filter == EVFILT_SIGNAL) {
        int sig = (int)events[e].ident;
        if (sig == SIGUSR1) {
          if (!stopping) {
            stopping = 1;
            kill(child_pid, stop_signal);
            deadline_ms = NOW_MS() + grace_ms;
          }
        } else {
          kill(-child_pid, sig);
        }
      }
    }
  }
}
