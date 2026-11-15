// src/lib/timeline.ts
// Funções puras sobre a lista de observações (frames) vinda da consulta.

export type Frame = any;

export const keyOf = (f: Frame): string => f?.access_url || '';

// Detector: tenta o padrão do nome do arquivo (…_<n>D<d>_spx…) e depois a pasta (…/<d>/level2_…)
export const detOf = (f: Frame): string => {
  const k = keyOf(f);
  const m = k.match(/_\d+D(\d)_spx/) || k.match(/\/(\d)\/level2_/);
  return m ? `D${m[1]}` : '?';
};

// Tempo em MJD (ou null se a observação não trouxe data)
export const timeOf = (f: Frame): number | null => {
  const t = parseFloat(f?.time_bounds_lower);
  if (Number.isFinite(t)) return t;
  const d = Date.parse(f?.date || '');
  return Number.isFinite(d) ? d / 86400000 + 40587 : null;
};

export const mjdToDate = (mjd: number): string =>
  new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

export function sortByTime(frames: Frame[]): Frame[] {
  return [...frames].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta === tb) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}

export type Group = { from: number; to: number; t0: number; t1: number }; // índices inclusivos na lista ordenada

// Agrupa observações separadas por lacunas grandes. O limite vem dos próprios dados (8x a lacuna mediana, mínimo 1 dia).
export function groupByGaps(times: number[]): Group[] {
  const n = times.length;
  if (n === 0) return [];
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(times[i] - times[i - 1]);
  const pos = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  const med = pos.length ? pos[pos.length >> 1] : 0;
  const thr = Math.max(med * 8, 1);
  const groups: Group[] = [];
  let from = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || gaps[i - 1] > thr) {
      groups.push({ from, to: i - 1, t0: times[from], t1: times[i - 1] });
      from = i;
    }
  }
  return groups;
}

export type Summary = {
  count: number;
  t0: number | null;
  t1: number | null;
  spanDays: number | null;
  groups: Group[];
};

export function summarize(sorted: Frame[]): Summary {
  const ts = sorted.map(timeOf);
  if (!sorted.length || ts.some((t) => t === null)) {
    return { count: sorted.length, t0: null, t1: null, spanDays: null, groups: [] };
  }
  const t = ts as number[];
  return { count: t.length, t0: t[0], t1: t[t.length - 1], spanDays: t[t.length - 1] - t[0], groups: groupByGaps(t) };
}

// Valores (float, NaN = sem dado) -> pixels. Stretch robusto: mediana e sigma via MAD.
export function renderImage(vals: Float32Array, w: number, h: number, gain: number): ImageData | null {
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(vals.length / 20000));
  for (let k = 0; k < vals.length; k += stride) if (Number.isFinite(vals[k])) sample.push(vals[k]);
  if (!sample.length) return null;
  sample.sort((a, b) => a - b);
  const med = sample[sample.length >> 1];
  const dev = sample.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sigma = 1.4826 * dev[dev.length >> 1] || 1;
  const lo = med - 2 * sigma;
  const range = med + gain * sigma - lo || 1;

  const img = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const v = vals[p];
    let r = 15, g = 15, b = 30; // sem cobertura
    if (Number.isFinite(v)) {
      const t = Math.min(1, Math.max(0, (v - lo) / range));
      r = g = b = Math.floor(Math.sqrt(t) * 255);
    }
    img.data[p * 4] = r;
    img.data[p * 4 + 1] = g;
    img.data[p * 4 + 2] = b;
    img.data[p * 4 + 3] = 255;
  }
  return img;
}