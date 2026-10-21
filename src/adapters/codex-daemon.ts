import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnProc, ProcessHandle } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { AgentEvent, RunOptions, RunResult, Usage } from '../types/index.js';

export type ReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | { denied: { rejection: string } }
  | 'timed_out'
  | 'abort';

export class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: any) => void }> = [];
  private closed = false;
  /** Last failure stored by fail(), if any. */
  public error: any = null;

  push(value: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.resolve({ value: undefined as any, done: true });
    }
  }

  fail(err: any) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    // Failure must REACH consumers suspended inside next(): a pending wait resolves with
    // done:false would make the surrounding for-await loop look like a normal, successful end.
    while (this.resolvers.length > 0) {
      const wait = this.resolvers.shift()!;
      wait.reject(err);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.error) throw this.error;
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    if (this.closed) {
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

const SANDBOX: Record<string, string> = {
  'read-only': 'read-only',
  plan: 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

const EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

export interface ActiveTurnContext {
  queue: AsyncQueue<AgentEvent>;
  turnId?: string;
  threadId?: string;
  permissions: string;
  text: string;
  usage: Usage;
  completed?: boolean;
  aborted?: boolean;
}

function failureFromSignal(signal: AbortSignal, message: string): AgentError {
  return signal.reason instanceof AgentError
    ? signal.reason
    : new AgentError('ABORTED', message, { agent: 'codex' });
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(failureFromSignal(signal, message)); return; }
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (fn: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, failureFromSignal(signal, message));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class CodexAppServerDaemon {
  readonly cwd: string;
  readonly envExtra?: Record<string, string>;
  private p!: ProcessHandle;
  private nextReqId = 1;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private activeThreadId?: string;
  public activeTurn?: ActiveTurnContext;
  private isAlive = false;
  private hasSpawned = false;
  private initPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private turnQueue: Promise<void> = Promise.resolve();
  /** Turns started on this daemon that have not finished (queued or running); eviction skips daemons with any. */
  public pendingTurns = 0;
  /** Set by the pool: drop this daemon from the pool when it closes or its process exits. */
  public onGone?: () => void;

  constructor(cwd: string, envExtra?: Record<string, string>) {
    this.cwd = path.resolve(cwd || process.cwd());
    this.envExtra = envExtra;
  }

  get spawned(): boolean {
    return this.hasSpawned;
  }

  get alive(): boolean {
    return this.isAlive && !this.p?.child?.killed && this.p?.child?.exitCode === null;
  }

  async ensureStarted(envExtra?: Record<string, string>, signal?: AbortSignal): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(this.envExtra || {}), ...(envExtra || {}) };
      if (!envExtra?.OPENAI_API_KEY && !this.envExtra?.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
      if (!envExtra?.CODEX_API_KEY && !this.envExtra?.CODEX_API_KEY) delete env.CODEX_API_KEY;

      const p = spawnProc('codex', ['app-server'], {
        cwd: this.cwd,
        env,
        keepStdinOpen: true,
        agent: 'codex',
      });
      this.p = p;
      this.isAlive = true;
      this.hasSpawned = true;

      // Start background reader loop
      this.listenBackground();

      // Handshake: initialize with 30s deadline and abort signal
      await this.sendRpc(
        'initialize',
        { clientInfo: { name: 'agentbridge', version: '0.3.5' } },
        { signal, timeoutMs: 30000 }
      );
      // Send notification initialized
      this.sendNotification('initialized');
      this.refreshIdleTimer();
    })();

    try {
      await this.initPromise;
    } catch (e) {
      this.isAlive = false;
      this.initPromise = undefined;
      if (this.p) {
        try {
          this.p.kill();
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  private sendRaw(obj: any) {
    if (!this.alive) throw new AgentError('AGENT_FAILED', 'Codex app-server daemon process is not running');
    this.p.stdin.write(JSON.stringify(obj) + '\n');
  }

  public sendRpc(
    method: string,
    params: any = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<any> {
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        reject(opts.signal ? failureFromSignal(opts.signal, `Codex RPC "${method}" aborted`) : new AgentError('ABORTED', `Codex RPC "${method}" aborted`, { agent: 'codex' }));
      };
      const cleanup = () => {
        this.pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      if (opts.signal?.aborted) {
        return reject(failureFromSignal(opts.signal, `Codex RPC "${method}" aborted`));
      }
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

      const timeoutMs = opts.timeoutMs ?? 30000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new AgentError('TIMEOUT', `Codex RPC "${method}" timed out after ${timeoutMs}ms`, { agent: 'codex', timedOut: true }));
        }, timeoutMs);
        timer.unref();
      }

      this.pendingRequests.set(id, {
        resolve: (val) => {
          cleanup();
          resolve(val);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  public sendResponse(id: number | string, result: any) {
    this.sendRaw({ jsonrpc: '2.0', id, result });
  }

  private sendNotification(method: string, params: any = {}) {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  private async listenBackground() {
    try {
      for await (const line of this.p.lines) {
        const j = parseJsonLine(line);
        if (!j) continue;
        this.refreshIdleTimer();

        // 1. In-flight Request from Server to Client (id + method)
        if (j.id != null && typeof j.method === 'string') {
          this.handleServerRequest(j.id, j.method, j.params);
          continue;
        }

        // 2. Response to Client Request (id + result / error)
        if (j.id != null && (j.result !== undefined || j.error !== undefined)) {
          const req = this.pendingRequests.get(Number(j.id));
          if (req) {
            this.pendingRequests.delete(Number(j.id));
            if (j.error) req.reject(new Error(j.error.message || JSON.stringify(j.error)));
            else req.resolve(j.result);
          }
          continue;
        }

        // 3. Server Notification (method without id)
        if (typeof j.method === 'string') {
          this.handleServerNotification(j.method, j.params, j);
        }
      }
    } catch (err) {
      if (this.activeTurn && !this.activeTurn.completed) {
        this.activeTurn.queue.fail(err);
      }
    } finally {
      this.isAlive = false;
      this.onGone?.();
      for (const req of this.pendingRequests.values()) {
        req.reject(new AgentError('AGENT_FAILED', 'Codex app-server exited unexpectedly'));
      }
      this.pendingRequests.clear();
      if (this.activeTurn && !this.activeTurn.completed) {
        this.activeTurn.queue.fail(new AgentError('AGENT_FAILED', 'Codex app-server exited unexpectedly before turn completion'));
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: any = {}) {
    const perm = this.activeTurn?.permissions || 'full';
    let decision: ReviewDecision = 'approved';

    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = params?.command || '';
      if (perm === 'read-only' || perm === 'plan') {
        decision = { denied: { rejection: `${perm} permission: command execution denied` } };
      } else {
        decision = 'approved';
      }
      if (this.activeTurn) {
        this.activeTurn.queue.push(
          ev.tool('codex:approval:command', { command: cmd, permissions: perm }, { decision })
        );
      }
    } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      if (perm === 'read-only' || perm === 'plan') {
        decision = { denied: { rejection: `${perm} permission: file modification denied` } };
      } else {
        decision = 'approved';
      }
      if (this.activeTurn) {
        this.activeTurn.queue.push(
          ev.tool('codex:approval:fileChange', { files: params?.fileChanges || params?.path, permissions: perm }, { decision })
        );
      }
    } else if (method === 'item/permissions/requestApproval') {
      decision = perm === 'full' ? 'approved' : { denied: { rejection: 'Permission escalation denied' } };
    }

    this.sendResponse(id, { decision });
  }

  /**
   * Whether a server notification belongs to the currently active turn.
   * Notifications from an orphaned turn (started by a run that was aborted while turn/start
   * was in flight) must not be routed to the next turn's queue. A notification that carries
   * no turn/thread ids at all (legacy shape) is always accepted.
   */
  private ownsNotification(turn: ActiveTurnContext, params: any, raw: any): boolean {
    const p = params || {};
    const rp = raw?.params || {};
    const turnId = p.turnId ?? p.turn?.id ?? rp.turnId ?? rp.turn?.id ?? raw?.turnId ?? raw?.turn?.id;
    const threadId = p.threadId ?? p.thread?.id ?? rp.threadId ?? rp.thread?.id ?? raw?.threadId ?? raw?.thread?.id;
    // turnCtx.turnId is only known after turn/start resolves: pre-turnId notifications are accepted.
    if (turnId != null && turn.turnId != null && turnId !== turn.turnId) return false;
    if (threadId != null && turn.threadId != null && threadId !== turn.threadId) return false;
    return true;
  }

  private handleServerNotification(method: string, params: any = {}, raw: any) {
    if (!this.activeTurn) return;
    if (!this.ownsNotification(this.activeTurn, params, raw)) return;

    this.activeTurn.queue.push(ev.raw(raw));

    if (method === 'item/agentMessage/delta') {
      const delta = params?.delta || '';
      this.activeTurn.text += delta;
      this.activeTurn.queue.push(ev.text(delta));
    } else if (method === 'item/reasoning/delta') {
      this.activeTurn.queue.push(ev.thinking(params?.delta || ''));
    } else if (method === 'item/completed' && params?.item) {
      const it = params.item;
      if (it.type === 'command_execution') {
        this.activeTurn.queue.push({
          ...ev.tool('shell', { command: it.command }, it.aggregated_output),
          id: it.id,
          exitCode: it.exit_code,
        } as any);
      } else if (it.type === 'file_change') {
        this.activeTurn.queue.push({
          ...ev.tool('file_change', { changes: it.changes }, it.status),
          id: it.id,
        } as any);
      }
    } else if (method === 'thread/tokenUsage/updated' && params?.tokenUsage) {
      const tu = params.tokenUsage;
      const src = tu.last || tu.total || tu;
      this.activeTurn.usage = {
        input: src.inputTokens || 0,
        output: src.outputTokens || 0,
        cachedInput: src.cachedInputTokens || 0,
        reasoning: src.reasoningOutputTokens || 0,
      };
    } else if (method === 'turn/completed') {
      const tu = params?.turn?.usage || params?.turn?.tokenUsage || params?.usage || {};
      const src = tu.last || tu.total || tu;
      this.activeTurn.usage = {
        input: src.inputTokens || this.activeTurn.usage.input,
        output: src.outputTokens || this.activeTurn.usage.output,
        cachedInput: src.cachedInputTokens || this.activeTurn.usage.cachedInput,
        reasoning: src.reasoningOutputTokens || this.activeTurn.usage.reasoning,
      };

      const status = params?.turn?.status;
      const turnErr = params?.turn?.error;
      if (status === 'failed' || status === 'error' || turnErr) {
        const msg =
          turnErr?.message ||
          (typeof turnErr === 'string' ? turnErr : `Codex turn completed with error status: ${status}`);
        this.activeTurn.queue.fail(new AgentError('AGENT_FAILED', msg, { agent: 'codex' }));
        return;
      }

      this.activeTurn.completed = true;
      this.activeTurn.queue.push(ev.usage(this.activeTurn.usage.input, this.activeTurn.usage.output));
      this.activeTurn.queue.close();
    }
  }

  private refreshIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // 10 minutes of inactivity -> close daemon
    this.idleTimer = setTimeout(() => {
      if (!this.activeTurn) {
        this.close();
      }
    }, 10 * 60 * 1000);
    this.idleTimer.unref();
  }

  async *runTurn(o: RunOptions, t0: number): AsyncGenerator<AgentEvent, RunResult, void> {
    if (o.signal?.aborted) {
      throw new AgentError('ABORTED', 'Codex turn aborted before starting', { agent: 'codex' });
    }

    const runAbort = new AbortController();
    const relayCallerAbort = () => runAbort.abort(new AgentError('ABORTED', 'Codex turn aborted', { agent: 'codex' }));
    o.signal?.addEventListener('abort', relayCallerAbort, { once: true });
    const deadline = o.timeoutMs && o.timeoutMs > 0 ? t0 + o.timeoutMs : null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (deadline !== null) {
      timeoutTimer = setTimeout(() => {
        runAbort.abort(new AgentError('TIMEOUT', `Codex turn timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true }));
      }, Math.max(0, deadline - Date.now()));
      timeoutTimer.unref();
    }
    const signal = runAbort.signal;
    const expireDeadline = () => {
      if (deadline !== null && Date.now() >= deadline && !signal.aborted) {
        runAbort.abort(new AgentError('TIMEOUT', `Codex turn timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true }));
      }
    };
    const throwIfAborted = () => {
      expireDeadline();
      if (signal.aborted) throw failureFromSignal(signal, 'Codex turn aborted');
    };

    // A03: Serialize turns on this daemon instance to prevent activeTurn overwrite
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const waitPrevious = this.turnQueue;
    this.turnQueue = this.turnQueue.then(
      () => currentLock,
      () => currentLock
    );

    let acquired = false;
    let ownTurnCtx: ActiveTurnContext | undefined;
    let abortListener: (() => void) | undefined;
    this.pendingTurns++;
    try {
      throwIfAborted();
      await awaitWithSignal(waitPrevious, signal, 'Codex turn aborted while queued');
      acquired = true;
      throwIfAborted();

      await this.ensureStarted(o.env, signal);

      throwIfAborted();

      const queue = new AsyncQueue<AgentEvent>();

      const turnCtx: ActiveTurnContext = {
        queue,
        permissions: o.permissions || 'full',
        text: '',
        usage: { input: 0, output: 0 },
      };
      ownTurnCtx = turnCtx;
      this.activeTurn = turnCtx;

      // Abort signal handling
      let interruptSent = false;
      let turnStartInFlight = false;
      const interruptTurn = () => {
        if (interruptSent || !turnCtx?.turnId || !turnCtx.threadId) return;
        interruptSent = true;
        this.sendRpc('turn/interrupt', { threadId: turnCtx.threadId, turnId: turnCtx.turnId }, { timeoutMs: 5000 }).catch(() => {});
      };
      abortListener = () => {
        if (turnCtx) turnCtx.aborted = true;
        if (turnStartInFlight && !turnCtx.turnId) this.close();
        interruptTurn();
        queue.fail(failureFromSignal(signal, 'Codex turn aborted'));
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });

      try {
        throwIfAborted();
        // Manage Thread: new / continue / fork / ephemeral
        const sessionMode = o.session?.mode || 'new';
        let threadId = this.activeThreadId;

        if (sessionMode === 'continue' && o.session?.id) {
          threadId = o.session.id;
          this.activeThreadId = threadId;
        } else if (sessionMode === 'fork' && o.session?.id) {
          const forkRes = await this.sendRpc('thread/fork', { threadId: o.session.id }, { signal });
          throwIfAborted();
          threadId = forkRes?.thread?.id || forkRes?.threadId;
          this.activeThreadId = threadId;
          if (threadId) yield ev.session(threadId);
        } else if (!threadId || sessionMode === 'new' || sessionMode === 'ephemeral') {
          const sb = SANDBOX[o.permissions || 'full'] || 'workspace-write';
          const startRes = await this.sendRpc(
            'thread/start',
            {
              cwd: this.cwd,
              model: o.model || null,
              approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
              sandbox: sb,
              developerInstructions: o.systemPrompt || null,
              ephemeral: sessionMode === 'ephemeral',
            },
            { signal }
          );
          throwIfAborted();
          threadId = startRes?.thread?.id || startRes?.threadId;
          this.activeThreadId = threadId;
          if (threadId && sessionMode !== 'ephemeral') {
            yield ev.session(threadId);
          }
        }

        turnCtx.threadId = threadId;

        throwIfAborted();

        // A59: Support input text and multimodal images
        const turnInput: any[] = [{ type: 'text', text: o.prompt }];
        if (o.images?.length) {
          for (const img of o.images) {
            if (img.data && img.mediaType) {
              turnInput.push({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              });
            }
          }
        }

        // Start Turn
        const turnParams: any = {
          threadId,
          input: turnInput,
          approvalPolicy: o.permissions === 'full' ? 'never' : 'on-request',
        };
        if (o.model) turnParams.model = o.model;
        if (o.effort) turnParams.effort = EFFORT[o.effort];
        if (o.jsonSchema) turnParams.outputSchema = o.jsonSchema;

        turnStartInFlight = true;
        let turnRes: any;
        try {
          turnRes = await this.sendRpc('turn/start', turnParams, { signal });
        } finally {
          turnStartInFlight = false;
        }
        turnCtx.turnId = turnRes?.turn?.id || turnRes?.turnId;
        if (signal.aborted) {
          interruptTurn();
          throwIfAborted();
        }

        // Stream events from queue to caller
        for await (const event of queue) {
          yield event;
        }

        // A failed queue must surface as a failure, never as a normal end-of-stream success
        // (e.g. fail() raced the loop exit).
        if (queue.error) throw queue.error;

        return {
          text: turnCtx.text,
          sessionId: sessionMode === 'ephemeral' ? undefined : threadId,
          usage: turnCtx.usage,
          exitCode: 0,
          model: o.model || 'default',
          durationMs: Date.now() - t0,
          timedOut: false,
          transport: 'app-server',
        };
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      o.signal?.removeEventListener('abort', relayCallerAbort);
      releaseLock();
      this.pendingTurns--;
      if (acquired) {
        if (this.activeTurn === ownTurnCtx) this.activeTurn = undefined;
        this.refreshIdleTimer();
      }
    }
  }

  close() {
    this.isAlive = false;
    this.onGone?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.p) {
      try {
        this.p.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function getDaemonPoolKey(cwd: string, env?: Record<string, string>): string {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const cwdKey = process.platform === 'win32' ? resolvedCwd.toLowerCase() : resolvedCwd;
  const codexHome = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? '';
  const resolvedCodexHome = codexHome ? path.resolve(cwd || process.cwd(), codexHome) : '';
  const codexHomeKey = process.platform === 'win32' ? resolvedCodexHome.toLowerCase() : resolvedCodexHome;
  // ensureStarted strips inherited API keys, so only explicit keys participate in the effective daemon env.
  // Fingerprint them together with endpoint overrides; never retain secret values in the pool key.
  const credentialFingerprint = createHash('sha256').update(JSON.stringify([
    env?.OPENAI_API_KEY || '',
    env?.CODEX_API_KEY || '',
  ])).digest('hex');
  const endpoint = env?.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '';
  const codexEndpoint = env?.CODEX_BASE_URL ?? process.env.CODEX_BASE_URL ?? '';
  const acct = env?.AGENTBRIDGE_ACCOUNT_NAME ?? process.env.AGENTBRIDGE_ACCOUNT_NAME ?? '';
  return JSON.stringify([cwdKey, codexHomeKey, acct, endpoint, codexEndpoint, credentialFingerprint]);
}

/** Global Daemon Pool indexed by resolved workspace path and effective account environment (LRU-capped). */
export class DaemonPool {
  private daemons = new Map<string, CodexAppServerDaemon>(); // insertion order == recency (oldest first)

  constructor(private maxSize: number = Number(process.env.AGENTBRIDGE_CODEX_DAEMON_MAX) || 4) {}

  get size(): number {
    return this.daemons.size;
  }

  setMax(n: number): void {
    this.maxSize = Math.max(1, n);
  }

  get(cwd: string, env?: Record<string, string>): CodexAppServerDaemon {
    const key = getDaemonPoolKey(cwd, env);
    let daemon = this.daemons.get(key);
    if (daemon && daemon.spawned && !daemon.alive) {
      this.daemons.delete(key);
      daemon = undefined;
    }
    if (daemon) {
      this.daemons.delete(key); // refresh recency
      this.daemons.set(key, daemon);
      return daemon;
    }
    const fresh = new CodexAppServerDaemon(cwd, env);
    fresh.onGone = () => {
      if (this.daemons.get(key) === fresh) this.daemons.delete(key);
    };
    this.daemons.set(key, fresh);
    this.evict(fresh);
    return fresh;
  }

  private evict(keep: CodexAppServerDaemon): void {
    for (const [k, d] of [...this.daemons]) {
      if (this.daemons.size <= this.maxSize) break;
      if (d === keep || d.activeTurn || d.pendingTurns > 0) continue; // never kill a busy daemon
      this.daemons.delete(k);
      d.close();
    }
  }

  shutdownAll() {
    const all = [...this.daemons.values()];
    this.daemons.clear();
    for (const daemon of all) daemon.close();
  }
}

export const codexDaemonPool = new DaemonPool();

process.on('exit', () => {
  codexDaemonPool.shutdownAll();
});
