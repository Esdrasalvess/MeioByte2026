// src/lib/frameStore.ts
// Armazém único de frames alinhados (/api/align): cada observação é baixada uma vez
// e todas as telas (miniaturas, imagem grande, vídeo) leem daqui.
import { useSyncExternalStore } from 'react';

export type Loaded = { n: number; data: Float32Array; valid: number; info: Record<string, any> | null };
export type Slot = { status: 'queued' | 'loading' | 'ok' | 'nocov' | 'err'; loaded?: Loaded; message?: string };
type Target = { ra: string; dec: string; fov: number };
type Result =
  | { kind: 'ok'; data: Float32Array; info: Record<string, any> | null }
  | { kind: 'nocov' }
  | { kind: 'err'; message: string };

const MAX_PARALLEL = 3;
const RETRY_DELAYS = [0, 3000, 8000, 15000]; // 1ª tentativa + 3 retries
const ATTEMPT_TIMEOUT = 150000;

const slots = new Map<string, Slot>();
let target: Target = { ra: '', dec: '', fov: 0 };
let ctrl = new AbortController();
let queue: string[] = [];
let running = 0;
let lastWanted: string[] = [];
let version = 0;
let wantedAt = 0; // quando começou o lote atual
let finished = 0; // quantos terminaram desde então (para estimar o tempo que falta)
const listeners = new Set<() => void>();

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getVersion = () => version;
export const getSlot = (key: string): Slot | undefined => slots.get(key);

// Re-renderiza o componente quando qualquer slot muda (devolve só um contador)
export const useFrameStore = () => useSyncExternalStore(subscribe, getVersion, getVersion);

// Andamento do lote pedido por último
export function progress() {
  let done = 0, pending = 0, ok = 0, err = 0, nocov = 0;
  for (const k of lastWanted) {
    const s = slots.get(k);
    if (!s || s.status === 'queued' || s.status === 'loading') pending++;
    else {
      done++;
      if (s.status === 'ok') ok++;
      else if (s.status === 'err') err++;
      else nocov++;
    }
  }
  return { total: lastWanted.length, done, pending, ok, err, nocov, finished, elapsedMs: wantedAt ? Date.now() - wantedAt : 0 };
}

// 0, último, meio, quartos... (cobre o período inteiro cedo, em vez de só o começo)
function spreadOrder(n: number): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const out = [0, n - 1];
  const seen = new Set(out);
  const q: [number, number][] = [[0, n - 1]];
  while (q.length) {
    const [a, b] = q.shift()!;
    const m = (a + b) >> 1;
    if (m === a || m === b || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    q.push([a, m], [m, b]);
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

async function fetchAligned(url: string, signal: AbortSignal): Promise<Result> {
  let message = 'erro desconhecido';
  for (let a = 0; a < RETRY_DELAYS.length; a++) {
    if (RETRY_DELAYS[a]) await sleep(RETRY_DELAYS[a], signal);
    if (signal.aborted) return { kind: 'err', message: 'cancelado' };
    try {
      const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT)]) });
      if (res.status === 422) return { kind: 'nocov' };
      if (res.ok) {
        const buf = await res.arrayBuffer();
        let info: Record<string, any> | null = null;
        try { info = JSON.parse(res.headers.get('X-Align-Info') || 'null'); } catch {}
        return { kind: 'ok', data: new Float32Array(buf), info };
      }
      message = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) return { kind: 'err', message }; // erro do cliente: não adianta repetir
    } catch {
      if (signal.aborted) return { kind: 'err', message: 'cancelado' };
      message = 'tempo esgotado ou falha de rede';
    }
  }
  return { kind: 'err', message };
}

async function run(key: string, t: Target, myCtrl: AbortController) {
  const url = `/api/align?url=${encodeURIComponent(key)}&ra=${t.ra}&dec=${t.dec}&fov=${t.fov}`;
  const r = await fetchAligned(url, myCtrl.signal);
  if (myCtrl !== ctrl) return; // o alvo mudou enquanto baixava: descarta
  finished++;
  if (r.kind === 'ok') {
    let ok = 0;
    for (let i = 0; i < r.data.length; i++) if (Number.isFinite(r.data[i])) ok++;
    slots.set(key, {
      status: 'ok',
      loaded: { n: Math.round(Math.sqrt(r.data.length)), data: r.data, valid: ok / r.data.length, info: r.info },
    });
  } else if (r.kind === 'nocov') {
    slots.set(key, { status: 'nocov' });
  } else {
    slots.set(key, { status: 'err', message: r.message });
  }
  emit();
}

function pump() {
  let changed = false;
  while (running < MAX_PARALLEL && queue.length) {
    const key = queue.shift()!;
    const s = slots.get(key);
    if (!s || s.status !== 'queued') continue;
    slots.set(key, { status: 'loading' });
    running++;
    changed = true;
    run(key, target, ctrl).finally(() => {
      running--;
      pump();
    });
  }
  if (changed) emit();
}

// Novo alvo/campo: cancela o que está baixando e esvazia tudo
export function setTarget(t: Target) {
  if (t.ra === target.ra && t.dec === target.dec && t.fov === target.fov) return;
  target = t;
  ctrl.abort();
  ctrl = new AbortController();
  slots.clear();
  queue = [];
  lastWanted = [];
  wantedAt = 0;
  finished = 0;
  emit();
}

// Declara quais frames (em ordem de data) devem estar baixados. Eles são baixados em ordem espalhada no tempo.
// O que estava na fila e saiu da lista é removido; o que já está baixando termina; o que já terminou fica.
export function want(keys: string[]) {
  if (keys.some((k) => !slots.has(k))) {
    wantedAt = Date.now();
    finished = 0;
  }
  lastWanted = keys;
  const wanted = new Set(keys);
  for (const k of queue) if (!wanted.has(k)) slots.delete(k);
  queue = [];
  for (const i of spreadOrder(keys.length)) {
    const k = keys[i];
    const s = slots.get(k);
    if (!s) {
      slots.set(k, { status: 'queued' });
      queue.push(k);
    } else if (s.status === 'queued') {
      queue.push(k);
    }
  }
  pump();
  emit();
}

export function retryErrors() {
  for (const [k, s] of [...slots.entries()]) if (s.status === 'err') slots.delete(k);
  want(lastWanted);
}