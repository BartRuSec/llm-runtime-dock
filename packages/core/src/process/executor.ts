import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';

/** stdin is ignored; stdout/stderr are piped so output can be captured. */
type PipedChildProcess = ChildProcessByStdio<null, Readable, Readable>;
import { cliError } from '../errors.js';
import type { CliError } from '../errors.js';
import type { Logger } from '../logging.js';
import { nullLogger } from '../logging.js';

/**
 * Process execution (spec §10).
 *
 * Everything takes an argv array. Shell execution is opt-in per call and only
 * reachable from trusted configuration; nothing derived from an HTTP request
 * ever reaches this module (§11, §28).
 */

export interface RunSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Run through the system shell. Off by default and only ever set from a
   * config file that explicitly opted in (`shell: true`). See README security note.
   */
  readonly shell?: boolean;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnSpec extends RunSpec {
  /** Number of output lines retained for `lrd logs`. */
  readonly logBufferLines?: number;
}

export interface StopOptions {
  readonly signal?: NodeJS.Signals;
  /** How long to wait after the graceful signal before SIGKILL. */
  readonly timeoutMs?: number;
}

export interface ManagedProcess {
  readonly pid: number | undefined;
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Resolves when the process exits, for any reason — including failing to
   * spawn at all. A missing executable emits `error` and never `exit`, so that
   * case is normalized here; otherwise every caller racing this promise against
   * a readiness check would wait out the full timeout instead of reporting the
   * real problem.
   */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited(): boolean;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /** Graceful signal, then forced termination after the timeout. */
  stop(options?: StopOptions): Promise<void>;
  /** Recent stdout/stderr lines, newest last. */
  logs(): string[];
  /** The spawn failure, when the process never started (e.g. ENOENT). */
  error(): Error | undefined;
}

export interface ProcessExecutor {
  /** Run to completion and capture output. */
  run(spec: RunSpec): Promise<RunResult>;
  /** Start a long-lived process and track it. */
  spawn(spec: SpawnSpec): ManagedProcess;
  /** Is this executable resolvable on PATH? Used by `lrd doctor`. */
  which(command: string): Promise<boolean>;
}

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_LOG_LINES = 500;

const buildEnv = (overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv => {
  return overrides ? { ...process.env, ...overrides } : process.env;
};

const describe = (spec: RunSpec): string => {
  return [spec.command, ...spec.args].join(' ');
};

interface LogRing {
  push(chunk: string): void;
  snapshot(): string[];
}

const createLogRing = (limit: number): LogRing => {
  const lines: string[] = [];
  let partial = '';

  return {
    push: (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        if (lines.length > limit) lines.shift();
      }
    },
    snapshot: () => (partial ? [...lines, partial] : [...lines]),
  };
};

const createManagedProcess = (
  child: PipedChildProcess,
  command: string,
  args: readonly string[],
  logBufferLines: number,
  logger: Logger,
): ManagedProcess => {
  const ring = createLogRing(logBufferLines);
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => ring.push(chunk));
  child.stderr.on('data', (chunk: string) => ring.push(chunk));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exit) return;
      exit = { code, signal };
      resolve(exit);
    };
    child.once('exit', (code, signal) => settle(code, signal));
    child.once('error', (error: Error) => {
      spawnError = error;
      ring.push(`${error.message}\n`);
      logger.error('process error', { event: 'process.error', error: error.message });
      // ENOENT and friends never produce an `exit` event.
      settle(null, null);
    });
  });

  /**
   * Graceful signal, then forced termination after the timeout.
   *
   * On Windows there is no real distinction: Node has no way to deliver a
   * signal, so any `kill` terminates the process outright and the timeout
   * branch never runs. A runtime that needs to flush state on shutdown can
   * therefore only do so on Unix.
   */
  const stop = async (options: StopOptions = {}): Promise<void> => {
    if (exit) return;
    const graceful = options.signal ?? 'SIGTERM';
    const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    child.kill(graceful);
    const timer = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => resolve('timeout'), timeoutMs);
      void exited.finally(() => clearTimeout(handle));
    });
    const outcome = await Promise.race([exited.then(() => 'exited' as const), timer]);
    if (outcome === 'timeout') {
      logger.warn('process did not exit gracefully; forcing termination', {
        event: 'process.force_kill',
        pid: child.pid,
        durationMs: timeoutMs,
      });
      child.kill('SIGKILL');
      await exited;
    }
  };

  return {
    command,
    args,
    exited,
    // Node assigns the pid synchronously in `spawn` and never changes it, so
    // this needs no getter: a failed spawn leaves it undefined and stays that way.
    pid: child.pid,
    hasExited: () => exit !== undefined,
    exitInfo: () => exit,
    logs: () => ring.snapshot(),
    /** The spawn failure, when the process never started (e.g. ENOENT). */
    error: () => spawnError,
    stop,
  };
};

export const createProcessExecutor = (logger: Logger = nullLogger): ProcessExecutor => {
  const run = async (spec: RunSpec): Promise<RunResult> => {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    logger.debug('running command', { event: 'process.run', command: describe(spec) });
    return await new Promise<RunResult>((resolve, reject) => {
      let child: PipedChildProcess;
      try {
        child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: buildEnv(spec.env),
          shell: spec.shell === true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (cause) {
        reject(executableError(spec, cause));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
      });

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        settled = true;
        reject(
          cliError('CONFIG_INVALID', `command timed out after ${timeoutMs}ms: ${describe(spec)}`, {
            details: { command: spec.command, timeoutMs },
          }),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });

      child.once('error', (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
        reject(executableError(spec, cause));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
        resolve({ code, signal, stdout, stderr });
      });
    });
  };

  const spawnProcess = (spec: SpawnSpec): ManagedProcess => {
    logger.info('spawning process', { event: 'process.spawn', command: describe(spec) });
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: buildEnv(spec.env),
      shell: spec.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    const managed = createManagedProcess(
      child,
      spec.command,
      spec.args,
      spec.logBufferLines ?? DEFAULT_LOG_LINES,
      logger,
    );
    if (spec.signal) {
      spec.signal.addEventListener('abort', () => void managed.stop(), { once: true });
    }
    return managed;
  };

  const which = async (command: string): Promise<boolean> => {
    // `which`/`where` themselves take the command as a single argv element,
    // so nothing is interpolated into a shell string.
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      const result = await run({ command: probe, args: [command], timeoutMs: 5_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  };

  return { run, spawn: spawnProcess, which };
};

const executableError = (spec: RunSpec, cause: unknown): CliError => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return cliError('CONFIG_INVALID', `executable not found: ${spec.command}`, {
      details: { command: spec.command },
      cause,
      hint: `install it or set an absolute path in the configuration`,
    });
  }
  return cliError('CONFIG_INVALID', `failed to run ${describe(spec)}`, {
    details: { command: spec.command },
    cause,
  });
};

/**
 * Is this executable available (§22, §27)?
 *
 * Both path separators count: `C:\\tools\\mtplx.exe` contains no forward slash,
 * so a Windows path would otherwise be looked up on PATH as a bare name and
 * never found. A path is checked on disk; a bare name goes to `which`/`where`.
 */
export const executableAvailable = async (
  executor: ProcessExecutor,
  command: string,
): Promise<boolean> => {
  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');
  return pathLike ? existsSync(command) : executor.which(command);
};
