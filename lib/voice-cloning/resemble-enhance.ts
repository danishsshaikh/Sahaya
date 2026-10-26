import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { getVoiceEnhancementConfig, type VoiceEnhancementConfig } from '@/lib/voice-cloning/config';
import { validateEnhancedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import { createLogger } from '@/lib/logger';

const log = createLogger('ResembleEnhance');

export interface VoiceEnhancementResult {
  audio: Uint8Array;
  format: 'wav';
  backend: 'resemble-enhance';
  processingMs: number;
  originalDurationSeconds: number;
  enhancedDurationSeconds: number;
}

export interface VoiceEnhancementInput {
  audio: Uint8Array;
  format: string;
}

interface WorkerResponse {
  event: 'ready' | 'healthy' | 'fatal' | 'result';
  id?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

export interface VoiceEnhancementWorker {
  enhance(input: VoiceEnhancementInput): Promise<VoiceEnhancementResult>;
  close(reason?: string): void;
}

type WorkerFactory = () => VoiceEnhancementWorker;

interface PendingPoolRequest {
  input: VoiceEnhancementInput;
  resolve: (result: VoiceEnhancementResult) => void;
  reject: (error: unknown) => void;
}

interface WorkerSlot {
  worker?: VoiceEnhancementWorker;
  busy: boolean;
}

function extensionForFormat(format: string): string {
  const normalized = format.trim().toLowerCase();
  return /^[a-z0-9]+$/.test(normalized) ? normalized : 'wav';
}

function enhancementKey(input: VoiceEnhancementInput, config: VoiceEnhancementConfig): string {
  return createHash('sha256')
    .update(input.audio)
    .update(
      JSON.stringify({
        format: input.format,
        backend: config.backend,
        device: config.device,
        nfe: config.nfe,
        solver: config.solver,
        denoiseStrength: config.denoiseStrength,
        priorTemperature: config.priorTemperature,
      }),
    )
    .digest('hex');
}

class PersistentResembleEnhanceWorker implements VoiceEnhancementWorker {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadlineInterface;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private pending?: {
    id: string;
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private closed = false;

  constructor(private readonly config: VoiceEnhancementConfig) {}

  async enhance(input: VoiceEnhancementInput): Promise<VoiceEnhancementResult> {
    if (this.pending) throw new Error('Resemble Enhance worker is already processing audio');
    const startedAt = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sahaya-resemble-enhance-'));
    try {
      const inputPath = path.join(tempDir, `input.${extensionForFormat(input.format)}`);
      const outputPath = path.join(tempDir, 'enhanced.wav');
      await fs.writeFile(inputPath, input.audio);
      await this.waitUntilReady();
      const response = await this.request({ inputPath, outputPath });
      if (!response.ok) throw new Error(response.error || 'Resemble Enhance inference failed');
      const enhancedAudio = new Uint8Array(await fs.readFile(outputPath));
      const validation = await validateEnhancedVoiceAudio({
        originalAudio: input.audio,
        originalFormat: input.format,
        enhancedAudio,
        enhancedFormat: 'wav',
      });
      return {
        audio: enhancedAudio,
        format: 'wav',
        backend: 'resemble-enhance',
        processingMs: Date.now() - startedAt,
        ...validation,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  close(reason = 'Resemble Enhance worker closed'): void {
    this.closed = true;
    const error = new Error(reason);
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      forceKill.unref();
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (!this.ready) this.start();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ready!,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.close('Resemble Enhance worker startup timed out');
            reject(new Error('Resemble Enhance worker startup timed out'));
          }, this.config.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private start(): void {
    this.closed = false;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const child = spawn(
      this.config.pythonExecutable,
      [this.config.workerPath, '--device', this.config.device],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const detail = String(chunk).trim();
      if (detail) log.info('[VoiceEnhancementWorker]', { event: 'stderr', detail });
    });
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        new Error(`Resemble Enhance worker exited (${signal || String(code ?? 'unknown')})`),
      );
    });
  }

  private request(paths: { inputPath: string; outputPath: string }): Promise<WorkerResponse> {
    if (!this.child || this.closed) throw new Error('Resemble Enhance worker is unavailable');
    const id = randomUUID();
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(`Resemble Enhance inference timed out after ${this.config.timeoutMs}ms`);
        reject(new Error(`Resemble Enhance inference timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      const payload = {
        id,
        ...paths,
        nfe: this.config.nfe,
        solver: this.config.solver,
        denoiseStrength: this.config.denoiseStrength,
        priorTemperature: this.config.priorTemperature,
      };
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) this.handleExit(error);
      });
    });
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      log.warn('[VoiceEnhancementWorker]', {
        event: 'invalid-response',
        detail: line.slice(0, 300),
      });
      return;
    }
    if (response.event === 'ready') {
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (response.event === 'fatal') {
      this.handleExit(new Error(response.error || 'Resemble Enhance worker failed to start'));
      return;
    }
    if (response.event !== 'result' || !this.pending || response.id !== this.pending.id) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private handleExit(error: Error): void {
    if (this.child || this.pending || this.rejectReady) {
      log.warn('[VoiceEnhancementWorker]', { event: 'unavailable', error: error.message });
    }
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    this.ready = undefined;
    this.closed = true;
  }
}

export class ResembleEnhancePool {
  private readonly slots: WorkerSlot[];
  private readonly queue: PendingPoolRequest[] = [];
  private readonly inFlight = new Map<string, Promise<VoiceEnhancementResult>>();

  constructor(
    private readonly config: VoiceEnhancementConfig,
    private readonly factory: WorkerFactory = () => new PersistentResembleEnhanceWorker(config),
  ) {
    this.slots = Array.from({ length: config.maxConcurrency }, () => ({ busy: false }));
  }

  enhance(input: VoiceEnhancementInput): Promise<VoiceEnhancementResult> {
    const key = enhancementKey(input, this.config);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = new Promise<VoiceEnhancementResult>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.drain();
    });
    this.inFlight.set(key, request);
    request.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return request;
  }

  close(): void {
    for (const slot of this.slots) {
      slot.worker?.close();
      slot.worker = undefined;
      slot.busy = false;
    }
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(new Error('Resemble Enhance pool closed'));
    }
    this.inFlight.clear();
  }

  private drain(): void {
    for (const slot of this.slots) {
      const next = this.queue.shift();
      if (!next) return;
      if (slot.busy) {
        this.queue.unshift(next);
        continue;
      }
      slot.busy = true;
      slot.worker ??= this.factory();
      slot.worker
        .enhance(next.input)
        .then(next.resolve, (error) => {
          slot.worker?.close(error instanceof Error ? error.message : 'Enhancement failed');
          slot.worker = undefined;
          next.reject(error);
        })
        .finally(() => {
          slot.busy = false;
          this.drain();
        });
    }
  }
}

const globalEnhancement = globalThis as typeof globalThis & {
  __sahayaResembleEnhancePool?: { key: string; pool: ResembleEnhancePool };
};

function singletonPool(config: VoiceEnhancementConfig): ResembleEnhancePool {
  const key = JSON.stringify(config);
  if (globalEnhancement.__sahayaResembleEnhancePool?.key !== key) {
    globalEnhancement.__sahayaResembleEnhancePool?.pool.close();
    globalEnhancement.__sahayaResembleEnhancePool = {
      key,
      pool: new ResembleEnhancePool(config),
    };
  }
  return globalEnhancement.__sahayaResembleEnhancePool.pool;
}

export async function enhanceGeneratedVoiceAudio(
  input: VoiceEnhancementInput,
): Promise<VoiceEnhancementResult> {
  const config = getVoiceEnhancementConfig();
  if (!config.enabled) throw new Error('Voice enhancement is disabled');
  return singletonPool(config).enhance(input);
}

export function closeVoiceEnhancementPoolForTests(): void {
  globalEnhancement.__sahayaResembleEnhancePool?.pool.close();
  delete globalEnhancement.__sahayaResembleEnhancePool;
}
