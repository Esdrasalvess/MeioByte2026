// src/lib/irsa.ts
// Limitador único (compartilhado entre rotas) + fetch com retry que respeita cancelamento.

const MAX_CONCURRENT = 4; // se a IRSA devolver muito 429/503, baixe para 3

type Waiter = { resolve: () => void; reject: (e: any) => void };
type Limiter = { active: number; waiting: Waiter[] };

// globalThis: evita que cada rota ganhe sua própria cópia do contador
const g = globalThis as any;
const L: Limiter = (g.__irsaLimiter ||= { active: 0, waiting: [] });

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (L.active < MAX_CONCURRENT) {
    L.active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        L.active++;
        resolve();
      },
      reject,
    };
    const onAbort = () => {
      const i = L.waiting.indexOf(w);
      if (i >= 0) L.waiting.splice(i, 1);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    L.waiting.push(w);
  });
}

export function release() {
  L.active--;
  const next = L.waiting.shift();
  if (next) next.resolve();
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });

// Baixa o corpo inteiro com retry (429, 5xx, timeout e falha de rede). Cancelável.
export async function fetchBuffer(
  url: string,
  opts: { signal?: AbortSignal; tries?: number; timeoutMs?: number } = {}
): Promise<Buffer> {
  const { signal, tries = 2, timeoutMs = 45000 } = opts;
  let lastStatus = 0;

  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw abortError();
    try {
      const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { signal: s });
      if (res.ok) return Buffer.from(await res.arrayBuffer()); // corpo dentro do try: se travar no meio, tenta de novo
      lastStatus = res.status;
      if (res.status < 500 && res.status !== 429) break; // 422 etc: não adianta repetir
    } catch {
      if (signal?.aborted) throw abortError();
      lastStatus = 0; // timeout ou rede
    }
    await sleep(1500 * (i + 1), signal);
  }

  const err: any = new Error(`Erro no cutout IRSA: ${lastStatus || 'timeout/rede'}`);
  err.status = lastStatus;
  throw err;
}