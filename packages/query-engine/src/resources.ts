/**
 * Resource manager (Part 2 §32) — admission control in front of every engine.
 *
 * The rule it exists to enforce: **no single tool may take the whole box**. SpiderFoot asking for
 * eight workers and 2 GB is not a reason for the other four engines to starve, and on the Hidden
 * Cloud (§33) there may be no cgroup, no Docker and no way to be rescued by the platform — so the
 * ceiling has to live in our own process.
 *
 * It is a pure accountant: it grants or refuses, it never spawns anything. The caller holds a
 * lease and releases it; a refused request is a `Refusal` with a reason an analyst can read, which
 * the run surfaces as a skipped step rather than a crash (U5).
 */

export interface ResourceBudget {
  readonly cpu: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly processes: number;
  readonly concurrency: number;
  readonly networkRequests: number;
  readonly executionMs: number;
}

export const DEFAULT_RESOURCE_BUDGET: ResourceBudget = {
  cpu: 2,
  memoryMb: 1_024,
  diskMb: 2_048,
  processes: 8,
  concurrency: 6,
  networkRequests: 240,
  executionMs: 120_000,
};

export interface ResourceRequest {
  readonly engine: string;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
  readonly processes?: number;
  readonly networkRequests?: number;
  readonly executionMs?: number;
  /** Per-engine slot ceiling (§31 concurrency limit). */
  readonly maxConcurrent?: number;
}

export interface Lease {
  readonly id: number;
  readonly engine: string;
  release: () => void;
}

export interface Refusal {
  readonly reason:
    | 'cpu'
    | 'memory'
    | 'disk'
    | 'processes'
    | 'concurrency'
    | 'engine-concurrency'
    | 'network'
    | 'execution-time';
  readonly message: string;
}

export type Grant =
  | { readonly ok: true; readonly lease: Lease }
  | ({ readonly ok: false } & Refusal);

export interface ResourceUsage {
  readonly cpu: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly processes: number;
  readonly inFlight: number;
  readonly networkRequests: number;
  readonly byEngine: Readonly<Record<string, number>>;
}

export interface ResourceManager {
  readonly budget: ResourceBudget;
  acquire(request: ResourceRequest): Grant;
  usage(): ResourceUsage;
}

const need = (value: number | undefined, fallback: number): number => value ?? fallback;

/** A share nobody may exceed even when the box is idle: fairness, not just safety. */
const FAIR_SHARE = 0.6;

export const createResourceManager = (
  budget: ResourceBudget = DEFAULT_RESOURCE_BUDGET,
): ResourceManager => {
  let cpu = 0;
  let memoryMb = 0;
  let diskMb = 0;
  let processes = 0;
  let networkRequests = 0;
  let nextId = 1;
  const byEngine = new Map<string, number>();

  const refuse = (reason: Refusal['reason'], message: string): Grant => ({
    ok: false,
    reason,
    message,
  });

  const acquire = (request: ResourceRequest): Grant => {
    const wantCpu = need(request.cpu, 0.25);
    const wantMemory = need(request.memoryMb, 128);
    const wantDisk = need(request.diskMb, 0);
    const wantProcesses = need(request.processes, 1);
    const wantNetwork = need(request.networkRequests, 0);
    const wantMs = need(request.executionMs, 0);
    const engineInFlight = byEngine.get(request.engine) ?? 0;
    const inFlight = [...byEngine.values()].reduce((sum, count) => sum + count, 0);

    if (wantMs > budget.executionMs) {
      return refuse(
        'execution-time',
        `${request.engine} asks for ${String(wantMs)} ms, over the ${String(budget.executionMs)} ms ceiling`,
      );
    }
    if (inFlight + 1 > budget.concurrency) {
      return refuse('concurrency', `all ${String(budget.concurrency)} run slots are busy`);
    }
    const engineCeiling = Math.max(
      1,
      Math.min(
        need(request.maxConcurrent, budget.concurrency),
        Math.floor(budget.concurrency * FAIR_SHARE),
      ),
    );
    if (engineInFlight + 1 > engineCeiling) {
      return refuse(
        'engine-concurrency',
        `${request.engine} already holds ${String(engineInFlight)} of its ${String(engineCeiling)} slots`,
      );
    }
    if (cpu + wantCpu > budget.cpu) return refuse('cpu', 'not enough CPU left in the budget');
    if (memoryMb + wantMemory > budget.memoryMb) {
      return refuse('memory', `only ${String(budget.memoryMb - memoryMb)} MB of RAM left`);
    }
    if (diskMb + wantDisk > budget.diskMb) return refuse('disk', 'not enough scratch disk left');
    if (processes + wantProcesses > budget.processes) {
      return refuse('processes', `the ${String(budget.processes)} process ceiling is reached`);
    }
    if (networkRequests + wantNetwork > budget.networkRequests) {
      return refuse('network', 'the network request budget for this run is spent');
    }

    cpu += wantCpu;
    memoryMb += wantMemory;
    diskMb += wantDisk;
    processes += wantProcesses;
    networkRequests += wantNetwork;
    byEngine.set(request.engine, engineInFlight + 1);

    const id = nextId;
    nextId += 1;
    let released = false;
    return {
      ok: true,
      lease: {
        id,
        engine: request.engine,
        release: () => {
          if (released) return;
          released = true;
          cpu -= wantCpu;
          memoryMb -= wantMemory;
          diskMb -= wantDisk;
          processes -= wantProcesses;
          byEngine.set(request.engine, Math.max(0, (byEngine.get(request.engine) ?? 1) - 1));
        },
      },
    };
  };

  return {
    budget,
    acquire,
    usage: () => ({
      cpu,
      memoryMb,
      diskMb,
      processes,
      networkRequests,
      inFlight: [...byEngine.values()].reduce((sum, count) => sum + count, 0),
      byEngine: Object.fromEntries(byEngine),
    }),
  };
};
