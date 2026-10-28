# ITER native runner

The judge lazily builds `runner.cpp` with the configured g++, caching the binary
under the OS temporary directory. No extra dependencies are required. Arguments
are `result.json timeLimitMs memoryLimitMiB executable`; program standard streams
are inherited. A single JSON accounting record is written to the result file.

On Windows the program starts suspended, joins a Job Object, and then resumes.
The job enforces process memory and kills descendants when closed. Completion-port
notifications identify denied allocations. Process times supply CPU milliseconds;
process/job queries supply peak working-set/committed memory in KiB.

On Linux/macOS the helper forks and executes the program with address-space, CPU,
and core-dump limits. `wait4` supplies CPU time and peak resident memory (macOS
bytes are converted to KiB). macOS also samples resident memory with `proc_pidinfo`.
The child's process group is killed on timeout, shutdown, or program exit. POSIX
allocation failures can abort below the resident-memory limit; the judge recognizes
the usual uncaught `bad_alloc` / allocation-error stderr as MLE. Allocation failures
caught and hidden by the program cannot be reliably identified as MLE.

The wall-clock watchdog allows max(100 ms, 15% of TL) before killing; completed
programs exceeding TL in either CPU or wall time still receive TLE. stdout/stderr
limits and file-output limits are enforced by the Node supervisor.

If building or initializing the helper fails, the judge uses direct spawn with
wall-clock limits and leaves `memoryKb` undefined. Interactive programs always use
direct spawn for bidirectional pipes: they have wall-clock/output limits and no
memory measurement or enforcement. Interactive user stderr and interactor stderr
are captured separately. Linux/macOS code needs validation on those platforms.
