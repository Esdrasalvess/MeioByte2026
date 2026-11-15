// src/app/components/TimelinePlayer.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { keyOf, detOf, timeOf, mjdToDate, sortByTime, summarize, renderImage } from '../../lib/timeline';
import { setTarget, want, retryErrors, getSlot, progress, useFrameStore, type Loaded } from '../../lib/frameStore';
import { Radar, Bar, Skeleton, Steps, useElapsed, fmtEta } from './Feedback';

type Center = { ra: string; dec: string; fov: number };
type ViewMode = 'normal' | 'medsub' | 'mean';
type Crop = { n: number; x: number; y: number; w: number; h: number };
type Status = 'ok' | 'low' | 'pending' | 'loading' | 'err' | 'nocov';

const EXPORT_MIN_SIDE = 720; // lado maior do vídeo exportado, em pixels

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

const TICK_COLOR: Record<Status, string> = {
  ok: 'bg-blue-400',
  low: 'bg-amber-600',
  pending: 'bg-gray-600',
  loading: 'bg-blue-300 animate-pulse',
  err: 'bg-red-500',
  nocov: 'bg-gray-800',
};

// Miniatura desenhada a partir do mesmo dado alinhado do vídeo
// Miniatura desenhada a partir do mesmo dado alinhado do vídeo
function Thumb({ loaded, gain }: { loaded: Loaded; gain: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const img = renderImage(loaded.data, loaded.n, loaded.n, gain);
    if (!img) return;

    cv.width = loaded.n;
    cv.height = loaded.n;

    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.putImageData(img, 0, 0);
  }, [loaded, gain]);

  return (
    <canvas
      ref={ref}
      className="w-full h-full object-contain block"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

export default function TimelinePlayer({
  frames,
  center,
  active,
  visible = true,
  searching = false,
  emptyMessage,
  selectedKey,
  onSelect,
}: {
  frames: any[];
  center: Center;
  active: boolean; // baixar os frames (pode ser true mesmo com a aba escondida: pré-carrega)
  visible?: boolean; // a aba está na tela
  searching?: boolean; // a busca de observações está em andamento
  emptyMessage?: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const version = useFrameStore();
  const pr = progress();
  const searchSecs = useElapsed(searching);

  const [det, setDet] = useState('');
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);
  const [mode, setMode] = useState<ViewMode>('normal');
  const [gain, setGain] = useState(10);
  const [zoom, setZoom] = useState(1);
  const [minValid, setMinValid] = useState(60); // % mínima de pixels com dado para o frame entrar no vídeo
  const [autoCrop, setAutoCrop] = useState(false);
  const [showMark, setShowMark] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [panel, setPanel] = useState<null | 'help' | 'info'>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const selRef = useRef(selectedKey);
  selRef.current = selectedKey;
  const detRef = useRef(det);
  detRef.current = det;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Detectores que existem nos dados (nada fixo no código)
  const dets = useMemo(() => {
    const m = new Map<string, number>();
    frames.forEach((f) => m.set(detOf(f), (m.get(detOf(f)) || 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [frames]);

  // Rótulo da faixa de cor, se a consulta trouxe (energy_bandpassname)
  const bandLabel = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    frames.forEach((f) => {
      const d = detOf(f);
      const b = String(f?.energy_bandpassname || '').trim();
      if (!b || b.toUpperCase() === d) return;
      if (!seen.has(d)) seen.set(d, new Set());
      seen.get(d)!.add(b);
    });
    const out = new Map<string, string>();
    seen.forEach((s, d) => out.set(d, [...s].slice(0, 2).join(' / ').slice(0, 28)));
    return out;
  }, [frames]);

  // Detector inicial: o da observação selecionada, ou o que tem mais frames
  useEffect(() => {
    if (!dets.length || dets.some(([d]) => d === det)) return;
    const selFrame = frames.find((f) => keyOf(f) === selRef.current);
    const pref = selFrame ? detOf(selFrame) : [...dets].sort((a, b) => b[1] - a[1])[0][0];
    setDet(pref);
  }, [dets, det, frames]);

  // Se a seleção vier de fora, acompanha o detector dela
  useEffect(() => {
    if (!selectedKey) return;
    const f = frames.find((x) => keyOf(x) === selectedKey);
    if (f && detOf(f) !== detRef.current) setDet(detOf(f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Escondida: para o play
  useEffect(() => {
    if (!visible) setPlaying(false);
  }, [visible]);

  const list = useMemo(() => sortByTime(frames.filter((f) => detOf(f) === det)), [frames, det]);
  const summary = useMemo(() => summarize(list), [list]);
  const listKey = useMemo(() => list.map(keyOf).join('\n'), [list]);

  // Pede ao armazém os frames do detector atual (ele baixa em ordem espalhada no tempo)
  useEffect(() => {
    setTarget({ ra: center.ra, dec: center.dec, fov: center.fov });
    want(active ? list.map(keyOf) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listKey, center.ra, center.dec, center.fov]);

  const st = useMemo(() => {
    const ready: any[] = [];
    let nocov = 0, err = 0, low = 0, pending = 0;
    for (const f of list) {
      const s = getSlot(keyOf(f));
      if (!s || s.status === 'queued' || s.status === 'loading') pending++;
      else if (s.status === 'nocov') nocov++;
      else if (s.status === 'err') err++;
      else if (s.loaded!.valid * 100 >= minValid) ready.push(f);
      else low++;
    }
    return { ready, nocov, err, low, pending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, version, minValid]);
  const ready = st.ready;

  const statusOf = (f: any): Status => {
    const s = getSlot(keyOf(f));
    if (!s || s.status === 'queued') return 'pending';
    if (s.status === 'loading') return 'loading';
    if (s.status === 'ok') return s.loaded!.valid * 100 >= minValid ? 'ok' : 'low';
    return s.status;
  };

  // Frame atual = o selecionado (se estiver no vídeo), senão o primeiro
  const curIdx = ready.findIndex((f) => keyOf(f) === selectedKey);
  const cur = curIdx >= 0 ? curIdx : 0;
  const curFrame = ready[cur];
  const curKey = curFrame ? keyOf(curFrame) : '';
  const curLoaded = curKey ? getSlot(curKey)?.loaded : undefined;

  // Mantém a seleção dentro do que está no vídeo
  useEffect(() => {
    if (ready.length && curIdx < 0) onSelectRef.current(keyOf(ready[0]));
  }, [ready, curIdx]);

  // Retângulo comum: maior região sem buracos em todos os frames prontos (ou em 80% deles, se ficar pequena demais)
  const crop = useMemo<Crop | null>(() => {
    if (ready.length === 0) return null;
    const first = getSlot(keyOf(ready[0]))!.loaded!;
    const n = first.n;
    const full: Crop = { n, x: 0, y: 0, w: n, h: n };
    if (!autoCrop) return full;
    const arrs = ready.map((f) => getSlot(keyOf(f))!.loaded!).filter((a) => a.n === n);
    const cnt = new Uint16Array(n * n);
    for (const a of arrs) for (let p = 0; p < n * n; p++) if (Number.isFinite(a.data[p])) cnt[p]++;
    let r = largestRect(cnt, n, arrs.length);
    if (r.area < 0.25 * n * n) r = largestRect(cnt, n, Math.ceil(arrs.length * 0.8));
    if (r.area < 0.05 * n * n) return full;
    return { n, x: r.x, y: r.y, w: r.w, h: r.h };
  }, [ready, autoCrop]);

  // Média ou mediana pixel a pixel dos frames prontos
  const stack = useMemo(() => {
    if (mode === 'normal' || ready.length < 2) return null;
    const all = ready.map((f) => getSlot(keyOf(f))!.loaded!);
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
  }, [ready, mode]);

  // Play: avança a seleção (a seleção é única, vale também para a faixa e o painel lateral)
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (!playing || ready.length < 2 || mode === 'mean') return;
    const t = setInterval(() => {
      const r = readyRef.current;
      if (r.length < 2) return;
      const i = r.findIndex((f) => keyOf(f) === selRef.current);
      onSelectRef.current(keyOf(r[(i + 1) % r.length]));
    }, 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, ready.length, mode]);

  // Pixels (já recortados) do frame i
  const buildImage = (i: number): ImageData | null => {
    if (!crop || !ready[i]) return null;
    const e = getSlot(keyOf(ready[i]))?.loaded;
    if (!e || e.n !== crop.n) return null;
    const { n, x, y, w, h } = crop;
    const vals = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let k = 0; k < w; k++) {
        const p = (y + j) * n + (x + k);
        let v = e.data[p];
        if (mode === 'mean' && stack) v = stack[p];
        else if (mode === 'medsub' && stack) v = e.data[p] - stack[p];
        vals[j * w + k] = v;
      }
    }
    return renderImage(vals, w, h, gain);
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
      // O alvo fica no centro da grade original: (n-1)/2, como em sky.ts
      const mx = (crop.n - 1) / 2 - crop.x;
      const my = (crop.n - 1) / 2 - crop.y;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.lineWidth = Math.max(1, Math.max(crop.w, crop.h) / 220);
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(4, Math.max(crop.w, crop.h) * 0.03), 0, Math.PI * 2);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, mode, gain, ready, stack, crop, showMark]);

  // Mantém a miniatura atual visível na faixa (só com a aba na tela)
  useEffect(() => {
    if (!visible) return;
    const i = list.findIndex((f) => keyOf(f) === curKey);
    if (i < 0) return;
    stripRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [curKey, visible, list]);

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
        const label = mode === 'mean' ? `${det} · média de ${ready.length} frames` : `${det} · ${ready[i]?.date || ''}`;
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
        await new Promise<void>((res) => out.toBlob((b) => { if (b) saveBlob(b, `${baseName}.png`); res(); }, 'image/png'));
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        alert('Este navegador não suporta gravação de vídeo. Use Chrome, Edge ou Firefox.');
        return;
      }
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
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

  // Eixo do tempo: posição de cada observação pela data (ou espaçada igualmente se faltarem datas)
  const axis = useMemo(() => {
    const n = list.length;
    const ts = list.map(timeOf);
    const ok = n > 0 && ts.every((t) => t !== null);
    const t0 = ok ? Math.min(...(ts as number[])) : 0;
    const t1 = ok ? Math.max(...(ts as number[])) : 0;
    const span = t1 - t0;
    const pos = list.map((_, i) => (ok && span > 0 ? ((ts[i] as number) - t0) / span : n > 1 ? i / (n - 1) : 0.5));
    const bands = ok && span > 0 ? summary.groups.map((g) => ({ l: (g.t0 - t0) / span, w: (g.t1 - g.t0) / span })) : [];
    return { pos, bands };
  }, [list, summary]);

  const pick = (f: any) => {
    if (statusOf(f) !== 'ok') return; // só frames já prontos e com cobertura suficiente
    setPlaying(false);
    onSelect(keyOf(f));
  };
  const goto = (i: number) => {
    if (!ready.length) return;
    onSelect(keyOf(ready[Math.max(0, Math.min(ready.length - 1, i))]));
  };

  const eta =
    pr.finished >= 2 && pr.pending > 0
      ? `falta ${fmtEta((pr.elapsedMs / pr.finished) * pr.pending)}`
      : 'cada frame leva 10–25 s na IRSA';

  const sel = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none';
  const aspect = crop ? crop.w / crop.h : 1;
  const sumText =
    summary.t0 !== null
      ? `${mjdToDate(summary.t0)} → ${mjdToDate(summary.t1!)} (${Math.round(summary.spanDays!)} dias) · ${summary.groups.length} período(s) de observação`
      : 'observações sem data na consulta';

  const showLoadingPanel = !det || (list.length > 0 && st.pending > 0);

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      {/* Controles */}
      <div className="flex flex-wrap items-center gap-2 p-2 text-xs bg-gray-900/90 border-b border-gray-800">
        <select
          value={det}
          onChange={(e) => setDet(e.target.value)}
          className={sel}
          title="Cada detector cobre uma faixa de cor do infravermelho. Compare frames do mesmo detector."
        >
          {dets.map(([d, n]) => (
            <option key={d} value={d} className="bg-gray-900">
              {d}
              {bandLabel.get(d) ? ` · ${bandLabel.get(d)}` : ''} ({n})
            </option>
          ))}
        </select>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ViewMode)}
          className={sel}
          title="Normal: como veio. − mediana: tira o que é fixo e deixa só o que se move ou varia. Empilhada: média de todas as datas, para ver coisas fracas."
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
        <label className="flex items-center gap-1 text-gray-400" title="Frames em que o detector cobre menos que isso da área ficam fora do vídeo">
          cobertura mín.
          <input type="range" min={0} max={100} step={5} value={minValid} onChange={(e) => setMinValid(+e.target.value)} />
          {minValid}%
        </label>
        <label
  className="flex items-center gap-1 text-gray-400"
  title="Remove as bordas sem cobertura comum entre os frames. Desativado, mostra a grade completa."
>
          <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} />
          recorte automático
        </label>
        <label className="flex items-center gap-1 text-gray-400" title="Círculo amarelo na posição digitada (catálogo, época J2000)">
          <input type="checkbox" checked={showMark} onChange={(e) => setShowMark(e.target.checked)} />
          marcar alvo
        </label>
        <button
          onClick={exportMedia}
          disabled={exporting || ready.length === 0}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-3 py-0.5 rounded-full text-white"
          title="Grava os frames mostrados em um vídeo (.webm). Na visão Empilhada, baixa um PNG."
        >
          {exporting ? `Gravando... ${exportPct}%` : mode === 'mean' || ready.length < 2 ? 'Baixar PNG' : 'Baixar vídeo (.webm)'}
        </button>
        {st.err > 0 && (
          <button onClick={retryErrors} className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white">
            Tentar {st.err} erros de novo
          </button>
        )}
        <span className="flex-1" />
        <button onClick={() => setPanel((p) => (p === 'help' ? null : 'help'))} className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700">? ajuda</button>
        <button onClick={() => setPanel((p) => (p === 'info' ? null : 'info'))} className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700">ⓘ detalhes</button>
      </div>

      {/* Resumo calculado dos dados */}
      <div className="px-3 py-1 text-[11px] text-gray-300 bg-gray-900/60 border-b border-gray-800 font-mono truncate">
        {det || '—'}: {summary.count} observações · {sumText}
      </div>

      {/* Imagem */}
      <div className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center">
        {frames.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-gray-400 px-6 text-center">
            {searching ? (
              <>
                <Radar size={64} />
                <span>Buscando observações na IRSA… {searchSecs}s</span>
                <span className="text-[11px] text-gray-600">pode levar até 30 s se a IRSA estiver lenta</span>
              </>
            ) : (
              <span className="max-w-lg leading-relaxed">{emptyMessage || 'Nenhuma observação para esse alvo.'}</span>
            )}
          </div>
        ) : ready.length > 0 ? (
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
        ) : showLoadingPanel ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
            <Radar size={64} />
            <Steps
              items={[
                { label: `${frames.length} observações encontradas · ${list.length} no detector ${det || '…'}`, state: 'done' },
                { label: `Baixando e alinhando frames (${pr.done}/${pr.total})`, state: 'active' },
                { label: 'Montando o vídeo', state: 'todo' },
              ]}
            />
            <div className="w-72">
              <Bar value={pr.total ? pr.done / pr.total : 0} indeterminate={pr.done === 0} />
            </div>
            <span className="text-[11px] text-gray-500">{eta}</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 px-6 text-center">
            {list.length === 0
              ? 'Nenhum frame deste detector para esse alvo.'
              : st.low > 0 && st.pending === 0
              ? `${st.low} frame(s) chegaram, mas todos têm cobertura abaixo de ${minValid}%. Reduza a "cobertura mín.".`
              : `Nenhum frame deste detector ficou disponível: ${st.err} erro(s), ${st.nocov} sem cobertura. Tente outro detector${st.err ? ' ou use "Tentar de novo"' : ''}.`}
          </div>
        )}

        {/* O vídeo já toca, mas ainda chegam frames */}
        {ready.length > 0 && pr.pending > 0 && (
          <div className="absolute left-2 bottom-2 z-10 w-60 bg-gray-900/90 border border-gray-700 rounded p-2 flex flex-col gap-1 pointer-events-none">
            <span className="text-[10px] text-gray-300 font-mono">
              Baixando mais frames: {pr.done}/{pr.total} · {eta}
            </span>
            <Bar value={pr.total ? pr.done / pr.total : 0} />
          </div>
        )}

        {panel === 'help' && (
          <div className="absolute top-2 left-2 right-2 max-w-xl z-10 bg-gray-900/95 border border-gray-700 rounded p-3 text-[11px] text-gray-300 leading-relaxed">
            <b className="text-white">Como ler esta tela.</b> O ponto que você escolheu foi fotografado várias vezes pelo SPHEREx.
            Cada traço no eixo de tempo é uma observação; os blocos cinza são períodos de observação seguidos, agrupados
            automaticamente, e os vazios entre eles são lacunas. A imagem mostra o mesmo pedaço do céu em cada data:
            o que é fixo fica parado, e o que se move entre datas é candidato a asteroide, cometa ou estrela próxima.
            O modo "− mediana" apaga o que não muda e deixa só o que varia. Cada detector vê uma faixa de cor do infravermelho,
            e a cor muda dentro da imagem, então compare frames do mesmo detector. Clique num traço ou numa miniatura para ir à observação.
          </div>
        )}
        {panel === 'info' && (
          <div className="absolute top-2 right-2 w-96 max-h-[80%] overflow-auto z-10 bg-gray-900/95 border border-gray-700 rounded p-3 text-[10px] text-gray-300 font-mono">
            <div className="text-white mb-1">Frame atual: {curFrame?.date || '—'} · {det}</div>
            <pre className="whitespace-pre-wrap break-all">
              {curLoaded?.info ? JSON.stringify(curLoaded.info, null, 1) : 'Sem metadados (atualize o /api/align para a versão nova).'}
            </pre>
          </div>
        )}
      </div>

      {/* Eixo do tempo */}
      <div className="px-3 pt-2 bg-gray-900/90 border-t border-gray-800">
        <div className="relative h-8 mx-1" title="Cada traço é uma observação, na posição da sua data">
          {axis.bands.map((b, i) => (
            <div key={i} className="absolute top-2.5 h-3 rounded bg-gray-800" style={{ left: `${b.l * 100}%`, width: `${Math.max(b.w * 100, 0.8)}%` }} />
          ))}
          {list.map((f, i) => {
            const k = keyOf(f);
            const isCur = k === curKey;
            return (
              <button
                key={k}
                onClick={() => pick(f)}
                title={`${f.date || 'sem data'} · ${statusOf(f)}`}
                className={`absolute -translate-x-1/2 rounded-sm ${isCur ? 'bg-white top-0 h-8 w-[3px] z-10' : `${TICK_COLOR[statusOf(f)]} top-0.5 h-7 w-[5px]`}`}
                style={{ left: `${axis.pos[i] * 100}%` }}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 font-mono mx-1">
          <span>{summary.t0 !== null ? mjdToDate(summary.t0) : ''}</span>
          <span>{summary.t1 !== null ? mjdToDate(summary.t1) : ''}</span>
        </div>
      </div>

      {/* Reprodução */}
      <div className="p-2 bg-gray-900/90 flex items-center gap-3 text-xs">
        <button
          onClick={() => setPlaying((p) => !p)}
          disabled={ready.length < 2 || mode === 'mean'}
          className="w-16 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded py-1 text-white"
        >
          {playing ? '⏸ Pausar' : '▶ Play'}
        </button>
        <button onClick={() => goto(cur - 1)} className="px-2 py-1 bg-gray-800 rounded">◀</button>
        <input
          type="range"
          min={0}
          max={Math.max(0, ready.length - 1)}
          value={cur}
          onChange={(e) => { setPlaying(false); goto(+e.target.value); }}
          className="flex-1"
        />
        <button onClick={() => goto(cur + 1)} className="px-2 py-1 bg-gray-800 rounded">▶</button>
        <span className="font-mono text-gray-300 min-w-56 text-right">
          {mode === 'mean'
            ? `média de ${ready.length} frames`
            : ready.length
            ? `${cur + 1}/${ready.length} · ${curFrame?.date || '—'}${curLoaded ? ` · ${Math.round(curLoaded.valid * 100)}% cob.` : ''}`
            : '—'}
        </span>
        <span className="font-mono text-gray-500">
          {ready.length}/{list.length} ok
          {st.pending > 0 ? ` · ${st.pending} baixando` : ''}
          {st.low ? ` · ${st.low} descartados` : ''}
          {st.nocov ? ` · ${st.nocov} sem cob.` : ''}
          {st.err ? ` · ${st.err} erros` : ''}
        </span>
      </div>

      {/* Miniaturas (mesmo dado do vídeo, em ordem de data) */}
      <div ref={stripRef} className="h-28 shrink-0 flex gap-1.5 overflow-x-auto overflow-y-hidden p-2 bg-gray-950 border-t border-gray-800">
        {list.map((f, i) => {
          const k = keyOf(f);
          const s = getSlot(k);
          const status = statusOf(f);
          return (
            <div
              key={k}
              data-i={i}
              onClick={() => pick(f)}
              className={`shrink-0 w-20 flex flex-col gap-0.5 p-0.5 rounded border ${
                k === curKey ? 'border-blue-500 bg-gray-800' : 'border-gray-800 bg-gray-900'
              } ${status === 'ok' ? 'cursor-pointer hover:border-gray-600' : 'opacity-80'}`}
            >
              <div className="h-20 bg-black rounded overflow-hidden flex items-center justify-center p-0.5">
                {s?.status === 'ok' ? (
                  <div className="sx-fade w-full h-full">
                    <Thumb loaded={s.loaded!} gain={gain} />
                  </div>
                ) : status === 'err' ? (
                  <span className="text-[9px] text-red-400">erro</span>
                ) : status === 'nocov' ? (
                  <span className="text-[9px] text-gray-600">sem cob.</span>
                ) : (
                  <div className="relative w-full h-full">
                    <Skeleton className="absolute inset-0" />
                    {status === 'loading' && (
                      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin" />
                    )}
                  </div>
                )}
              </div>
              <div className="text-[9px] text-gray-400 font-mono truncate">{f.date || `#${i + 1}`}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}