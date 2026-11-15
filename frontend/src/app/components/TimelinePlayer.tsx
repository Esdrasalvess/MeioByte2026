// src/app/components/TimelinePlayer.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Center = { ra: string; dec: string; fov: number };
type Loaded = { n: number; data: Float32Array; valid: number }; // valid: fração 0..1 de pixels com dado
type Entry = Loaded | 'nocov' | 'err';
type ViewMode = 'normal' | 'medsub' | 'mean';
type Crop = { n: number; x: number; y: number; w: number; h: number };

const DETECTORS = [
  { id: 'D1', label: 'D1 · ≈0.75–1.1 µm' },
  { id: 'D2', label: 'D2 · ≈1.1–1.6 µm' },
  { id: 'D3', label: 'D3 · ≈1.6–2.4 µm' },
  { id: 'D4', label: 'D4 · ≈2.4–3.8 µm' },
  { id: 'D5', label: 'D5 · ≈3.8–4.4 µm' },
  { id: 'D6', label: 'D6 · ≈4.4–5.0 µm' },
];

const WORKERS = 3;
const RETRY_DELAYS = [0, 3000, 8000, 15000]; // 1ª tentativa + 3 retries
const ATTEMPT_TIMEOUT = 150000;
const EXPORT_MIN_SIDE = 720; // lado maior do vídeo exportado, em pixels

const keyOf = (f: any): string => f?.access_url || '';
const detOf = (f: any): string => {
  const m = keyOf(f).match(/_\d+D(\d)_spx/);
  return m ? `D${m[1]}` : '';
};
const timeOf = (f: any): number => {
  const t = parseFloat(f?.time_bounds_lower);
  if (Number.isFinite(t)) return t;
  const d = Date.parse(f?.date || '');
  return Number.isFinite(d) ? d / 86400000 + 40587 : 0;
};

const abortErr = () => new DOMException('aborted', 'AbortError');

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Pede o frame alinhado; repete sozinho em erro de servidor/rede/timeout
async function fetchAligned(url: string, signal: AbortSignal): Promise<Float32Array | 'nocov' | 'err'> {
  for (let a = 0; a < RETRY_DELAYS.length; a++) {
    if (RETRY_DELAYS[a]) await sleep(RETRY_DELAYS[a], signal);
    if (signal.aborted) throw abortErr();
    try {
      const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT)]) });
      if (res.status === 422) return 'nocov';
      if (res.ok) return new Float32Array(await res.arrayBuffer());
      if (res.status < 500 && res.status !== 429) return 'err'; // erro do cliente: não adianta repetir
    } catch {
      if (signal.aborted) throw abortErr();
    }
  }
  return 'err';
}

// Maior retângulo em que todos os pixels têm cnt >= min (algoritmo do histograma, O(n²))
function largestRect(cnt: Uint16Array, n: number, min: number) {
  const h = new Int32Array(n + 1);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const st: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) h[x] = cnt[y * n + x] >= min ? h[x] + 1 : 0;
    h[n] = 0;
    st.length = 0;
    for (let x = 0; x <= n; x++) {
      while (st.length && h[st[st.length - 1]] >= h[x]) {
        const height = h[st.pop() as number];
        const left = st.length ? st[st.length - 1] + 1 : 0;
        const width = x - left;
        const area = height * width;
        if (area > best.area) best = { x: left, y: y - height + 1, w: width, h: height, area };
      }
      st.push(x);
    }
  }
  return best;
}

function saveBlob(b: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export default function TimelinePlayer({
  frames,
  center,
  active,
}: {
  frames: any[];
  center: Center;
  active: boolean;
}) {
  const [det, setDet] = useState('D3');
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);
  const [mode, setMode] = useState<ViewMode>('normal');
  const [gain, setGain] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [tick, setTick] = useState(0);
  const [reload, setReload] = useState(0);
  const [minValid, setMinValid] = useState(60); // % mínima de pixels com dado para o frame entrar no vídeo
  const [autoCrop, setAutoCrop] = useState(true);
  const [showMark, setShowMark] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);

  const cacheRef = useRef(new Map<string, Entry>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const ck = (f: any) => `${keyOf(f)}|${center.ra}|${center.dec}|${center.fov}`;

  // Nova busca (outro alvo/campo): limpa tudo
  useEffect(() => {
    cacheRef.current.clear();
    setIdx(0);
    setTick((t) => t + 1);
  }, [center.ra, center.dec, center.fov]);

  // Se o detector escolhido não tem frames, vai para o primeiro que tem
  useEffect(() => {
    if (frames.length && !frames.some((f) => detOf(f) === det)) {
      const first = DETECTORS.find((d) => frames.some((f) => detOf(f) === d.id));
      if (first) setDet(first.id);
    }
  }, [frames, det]);

  const list = useMemo(
    () => frames.filter((f) => detOf(f) === det).sort((a, b) => timeOf(a) - timeOf(b)),
    [frames, det]
  );

  // Baixa (3 por vez) os frames alinhados do detector escolhido
  useEffect(() => {
    if (!active || list.length === 0) return;
    const ac = new AbortController();
    const todo = list.filter((f) => !cacheRef.current.has(ck(f)));
    let next = 0;

    const worker = async () => {
      while (next < todo.length && !ac.signal.aborted) {
        const f = todo[next++];
        const k = ck(f);
        const url = `/api/align?url=${encodeURIComponent(keyOf(f))}&ra=${center.ra}&dec=${center.dec}&fov=${center.fov}`;
        try {
          const r = await fetchAligned(url, ac.signal);
          if (r === 'nocov' || r === 'err') cacheRef.current.set(k, r);
          else {
            let ok = 0;
            for (let i = 0; i < r.length; i++) if (Number.isFinite(r[i])) ok++;
            cacheRef.current.set(k, { n: Math.round(Math.sqrt(r.length)), data: r, valid: ok / r.length });
          }
        } catch {
          return; // cancelado
        }
        setTick((t) => t + 1);
      }
    };
    for (let i = 0; i < WORKERS; i++) worker();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, list, center.ra, center.dec, center.fov, reload]);

  // Frames que chegaram (inclui os que serão descartados por cobertura baixa)
  const loaded = useMemo(
    () => list.filter((f) => {
      const e = cacheRef.current.get(ck(f));
      return e && typeof e === 'object';
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, tick, center.ra, center.dec, center.fov]
  );

  // Frames que entram no vídeo: cobertura >= limite escolhido
  const ready = useMemo(
    () => loaded.filter((f) => (cacheRef.current.get(ck(f)) as Loaded).valid * 100 >= minValid),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, minValid]
  );

  const stats = useMemo(() => {
    let nocov = 0, err = 0;
    list.forEach((f) => {
      const e = cacheRef.current.get(ck(f));
      if (e === 'nocov') nocov++;
      if (e === 'err') err++;
    });
    return { nocov, err, low: loaded.length - ready.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, loaded, ready, tick, center.ra, center.dec, center.fov]);

  // Retângulo comum: maior região sem buracos em todos os frames prontos (ou em 80% deles, se a região ficar pequena demais)
  const crop = useMemo<Crop | null>(() => {
    if (ready.length === 0) return null;
    const first = cacheRef.current.get(ck(ready[0])) as Loaded;
    const n = first.n;
    const full: Crop = { n, x: 0, y: 0, w: n, h: n };
    if (!autoCrop) return full;
    const arrs = ready.map((f) => cacheRef.current.get(ck(f)) as Loaded).filter((a) => a.n === n);
    const cnt = new Uint16Array(n * n);
    for (const a of arrs) {
      for (let p = 0; p < n * n; p++) if (Number.isFinite(a.data[p])) cnt[p]++;
    }
    let r = largestRect(cnt, n, arrs.length);
    if (r.area < 0.25 * n * n) r = largestRect(cnt, n, Math.ceil(arrs.length * 0.8));
    if (r.area < 0.05 * n * n) return full;
    return { n, x: r.x, y: r.y, w: r.w, h: r.h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, autoCrop, center.ra, center.dec, center.fov]);

  // Média ou mediana pixel a pixel de todos os frames prontos
  const stack = useMemo(() => {
    if (mode === 'normal' || ready.length < 2) return null;
    const all = ready.map((f) => cacheRef.current.get(ck(f)) as Loaded);
    const n = all[0].n;
    const arrs = all.filter((a) => a.n === n);
    const out = new Float32Array(n * n);
    const buf: number[] = [];
    for (let p = 0; p < n * n; p++) {
      buf.length = 0;
      for (const a of arrs) {
        const v = a.data[p];
        if (Number.isFinite(v)) buf.push(v);
      }
      if (!buf.length) { out[p] = NaN; continue; }
      if (mode === 'mean') {
        let s = 0;
        for (const v of buf) s += v;
        out[p] = s / buf.length;
      } else {
        buf.sort((x, y) => x - y);
        out[p] = buf[buf.length >> 1];
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode]);

  // Play (toca o que já estiver pronto, mesmo com o resto ainda baixando)
  useEffect(() => {
    if (!playing || ready.length < 2 || mode === 'mean') return;
    const t = setInterval(() => setIdx((i) => (i + 1) % ready.length), 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, ready.length, mode]);

  const cur = ready.length ? Math.min(idx, ready.length - 1) : 0;

  // Monta os pixels (já recortados) do frame i, com o stretch aplicado
  const buildImage = (i: number): ImageData | null => {
    if (!crop || !ready[i]) return null;
    const entry = cacheRef.current.get(ck(ready[i])) as Loaded | undefined;
    if (!entry || typeof entry !== 'object' || entry.n !== crop.n) return null;
    const { n, x, y, w, h } = crop;

    const vals = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const p = (y + j) * n + (x + k);
        let v = entry.data[p];
        if (mode === 'mean' && stack) v = stack[p];
        else if (mode === 'medsub' && stack) v = entry.data[p] - stack[p];
        vals[j * w + k] = v;
      }
    }

    // Stretch robusto: mediana e sigma via MAD
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
  };

  // Desenho na tela
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !crop) return;
    const img = buildImage(cur);
    if (!img) return;
    cv.width = crop.w;
    cv.height = crop.h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(img, 0, 0);
    if (showMark) {
      // O alvo fica no centro da grade original (n/2, n/2)
      const mx = crop.n / 2 - crop.x;
      const my = crop.n / 2 - crop.y;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.lineWidth = Math.max(1, Math.max(crop.w, crop.h) / 220);
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(4, Math.max(crop.w, crop.h) * 0.03), 0, Math.PI * 2);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, mode, gain, ready, stack, crop, showMark]);

  // Exporta: vídeo .webm (ou PNG na visão "Empilhada")
  const exportMedia = async () => {
    if (!crop || ready.length === 0 || exporting) return;
    setExporting(true);
    setExportPct(0);
    try {
      const scale = Math.max(1, Math.ceil(EXPORT_MIN_SIDE / Math.max(crop.w, crop.h)));
      const W = crop.w * scale;
      const H = crop.h * scale;
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const octx = out.getContext('2d');
      const tmp = document.createElement('canvas');
      tmp.width = crop.w;
      tmp.height = crop.h;
      const tctx = tmp.getContext('2d');
      if (!octx || !tctx) throw new Error('canvas indisponível');

      const fontPx = Math.max(12, Math.round(H / 32));
      const drawFrame = (i: number) => {
        const img = buildImage(i);
        if (!img) return;
        tctx.putImageData(img, 0, 0);
        octx.imageSmoothingEnabled = false;
        octx.drawImage(tmp, 0, 0, W, H);
        const label =
          mode === 'mean'
            ? `${det} · média de ${ready.length} frames`
            : `${det} · ${ready[i]?.date || ''}`;
        octx.font = `${fontPx}px ui-monospace, monospace`;
        octx.textBaseline = 'bottom';
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fillRect(0, H - fontPx * 1.6, octx.measureText(label).width + fontPx, fontPx * 1.6);
        octx.fillStyle = '#fff';
        octx.fillText(label, fontPx / 2, H - fontPx * 0.3);
      };

      const baseName = `spherex_${center.ra}_${center.dec}_${det}_${mode}`;

      if (mode === 'mean' || ready.length < 2) {
        drawFrame(cur);
        await new Promise<void>((res) =>
          out.toBlob((b) => { if (b) saveBlob(b, `${baseName}.png`); res(); }, 'image/png')
        );
        return;
      }

      if (typeof MediaRecorder === 'undefined') {
        alert('Este navegador não suporta gravação de vídeo. Use Chrome, Edge ou Firefox.');
        return;
      }
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      );
      if (!mime) {
        alert('Este navegador não grava .webm. Use Chrome, Edge ou Firefox.');
        return;
      }

      const stream = out.captureStream(fps);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });

      drawFrame(0);
      rec.start();
      for (let i = 0; i < ready.length; i++) {
        drawFrame(i);
        setExportPct(Math.round(((i + 1) / ready.length) * 100));
        await wait(1000 / fps);
      }
      await wait(1000 / fps);
      rec.stop();
      await stopped;
      saveBlob(new Blob(chunks, { type: 'video/webm' }), `${baseName}.webm`);
    } catch (e: any) {
      alert(`Não consegui exportar: ${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  };

  const curFrame = ready[cur];
  const curEntry = curFrame ? (cacheRef.current.get(ck(curFrame)) as Loaded | undefined) : undefined;
  const pending = list.length - loaded.length - stats.nocov - stats.err;
  const retryErrors = () => {
    list.forEach((f) => {
      if (cacheRef.current.get(ck(f)) === 'err') cacheRef.current.delete(ck(f));
    });
    setReload((r) => r + 1);
  };

  const sel = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none';
  const aspect = crop ? crop.w / crop.h : 1;

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      {/* Controles */}
      <div className="flex flex-wrap items-center gap-2 p-2 text-xs bg-gray-900/90 border-b border-gray-800">
        <select
          value={det}
          onChange={(e) => { setDet(e.target.value); setIdx(0); }}
          className={sel}
          title="Cada detector enxerga uma faixa de cor (comprimento de onda) diferente"
        >
          {DETECTORS.map((d) => (
            <option key={d.id} value={d.id} className="bg-gray-900">
              {d.label} ({frames.filter((f) => detOf(f) === d.id).length})
            </option>
          ))}
        </select>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ViewMode)}
          className={sel}
          title="Normal: imagens como vieram. − mediana: tira o que é fixo e deixa só o que se move ou varia. Empilhada: soma tudo para ver coisas fracas."
        >
          <option value="normal" className="bg-gray-900">Normal</option>
          <option value="medsub" className="bg-gray-900">− mediana (realça o que se move)</option>
          <option value="mean" className="bg-gray-900">Empilhada (média)</option>
        </select>
        <label className="flex items-center gap-1 text-gray-400">
          vel.
          <input type="range" min={1} max={12} value={fps} onChange={(e) => setFps(+e.target.value)} />
          {fps} fps
        </label>
        <label className="flex items-center gap-1 text-gray-400" title="Quanto mais alto, mais objetos fracos aparecem (e mais ruído)">
          contraste
          <input type="range" min={3} max={40} value={gain} onChange={(e) => setGain(+e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-gray-400">
          zoom
          <input type="range" min={1} max={8} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          {zoom}x
        </label>
        <label
          className="flex items-center gap-1 text-gray-400"
          title="Frames em que o detector cobre menos que isso da área são deixados de fora do vídeo"
        >
          cobertura mín.
          <input type="range" min={0} max={100} step={5} value={minValid} onChange={(e) => setMinValid(+e.target.value)} />
          {minValid}%
        </label>
        <label className="flex items-center gap-1 text-gray-400" title="Corta o vídeo na maior área que tem dado em todos os frames">
          <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} />
          recorte automático
        </label>
        <label className="flex items-center gap-1 text-gray-400" title="Círculo amarelo na posição do alvo (coordenadas digitadas)">
          <input type="checkbox" checked={showMark} onChange={(e) => setShowMark(e.target.checked)} />
          marcar alvo
        </label>
        <button
          onClick={exportMedia}
          disabled={exporting || ready.length === 0}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-0.5 rounded-full text-white"
          title="Grava os frames mostrados em um arquivo de vídeo (.webm). Na visão Empilhada, baixa uma imagem PNG."
        >
          {exporting
            ? `Gravando... ${exportPct}%`
            : mode === 'mean' || ready.length < 2
            ? 'Baixar PNG'
            : 'Baixar vídeo (.webm)'}
        </button>
        {stats.err > 0 && (
          <button onClick={retryErrors} className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white">
            Tentar {stats.err} erros de novo
          </button>
        )}
      </div>

      {/* Imagem */}
      <div className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center">
        {ready.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-gray-500 px-6 text-center">
            {list.length === 0 ? (
              'Nenhum frame deste detector para esse alvo.'
            ) : loaded.length > 0 ? (
              <span>
                {loaded.length} frame(s) chegaram, mas todos têm cobertura abaixo de {minValid}%. Reduza a "cobertura mín.".
              </span>
            ) : (
              <>
                <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                <span>Alinhando frames... {pending} na fila (cada um leva 10–25 s na IRSA)</span>
              </>
            )}
          </div>
        ) : (
          <div
            className="relative"
            style={{
              aspectRatio: `${aspect}`,
              height: aspect <= 1 ? '100%' : undefined,
              width: aspect > 1 ? '100%' : undefined,
              maxWidth: '100%',
              maxHeight: '100%',
              transform: `scale(${zoom})`,
            }}
          >
            <canvas ref={canvasRef} className="w-full h-full" style={{ imageRendering: 'pixelated' }} />
          </div>
        )}
      </div>

      {/* Linha do tempo */}
      <div className="p-2 bg-gray-900/90 border-t border-gray-800 flex items-center gap-3 text-xs">
        <button
          onClick={() => setPlaying((p) => !p)}
          disabled={ready.length < 2 || mode === 'mean'}
          className="w-16 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded py-1 text-white"
        >
          {playing ? '⏸ Pausar' : '▶ Play'}
        </button>
        <button onClick={() => setIdx((i) => Math.max(0, Math.min(i, ready.length - 1) - 1))} className="px-2 py-1 bg-gray-800 rounded">◀</button>
        <input
          type="range"
          min={0}
          max={Math.max(0, ready.length - 1)}
          value={cur}
          onChange={(e) => { setPlaying(false); setIdx(+e.target.value); }}
          className="flex-1"
        />
        <button onClick={() => setIdx((i) => Math.min(ready.length - 1, Math.min(i, ready.length - 1) + 1))} className="px-2 py-1 bg-gray-800 rounded">▶</button>
        <span className="font-mono text-gray-300 min-w-56 text-right">
          {mode === 'mean'
            ? `média de ${ready.length} frames`
            : ready.length
            ? `${cur + 1}/${ready.length} · ${curFrame?.date || '—'}${curEntry ? ` · ${Math.round(curEntry.valid * 100)}% cob.` : ''}`
            : '—'}
        </span>
        <span className="font-mono text-gray-500">
          {ready.length}/{list.length} ok
          {pending > 0 ? ` · ${pending} baixando` : ''}
          {stats.low ? ` · ${stats.low} descartados` : ''}
          {stats.nocov ? ` · ${stats.nocov} sem cob.` : ''}
          {stats.err ? ` · ${stats.err} erros` : ''}
        </span>
      </div>
    </div>
  );
}