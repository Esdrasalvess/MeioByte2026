// src/app/components/SkyMap.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const CHALLENGE_TARGETS = [
  { name: "Barnard's Star", ra: '269.452075', dec: '4.693391' },
  { name: 'WISE 0855', ra: '133.795129', dec: '-7.245147' },
  { name: 'Epsilon Indi B', ra: '330.840225', dec: '-56.785983' },
  { name: 'RW Aurigae', ra: '76.956542', dec: '30.401444' },
  { name: 'R Draconis', ra: '248.163292', dec: '66.754722' },
];

const FOV_OPTIONS = [0.08, 0.16, 0.24, 0.4]; // graus (tamanho do recorte)
const SEARCH_RADIUS = 0.05; // graus (raio da busca na IRSA)
const MAX_PARALLEL = 4;

type TileStatus = 'loading' | 'ok' | 'nocoverage' | 'error';
type TileState = { status: TileStatus; src?: string; message?: string };
type Center = { ra: string; dec: string; fov: number };
type View = { s: number; x: number; y: number };
type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogEntry = { t: string; level: LogLevel; text: string };
type Phase = 'idle' | 'searching' | 'rendering' | 'done' | 'error';

const frameKey = (f: any): string => f?.access_url || f?.accessUrl || f?.url || f?.fileUrl || '';
const shortName = (key: string) => (key.split('?')[0].split('/').pop() || key).slice(-34);

const buildPngUrl = (frame: any, c: Center) => {
  const raw = frameKey(frame);
  if (!raw) return '';
  const sep = raw.includes('?') ? '&' : '?';
  const cutout = `${raw}${sep}center=${c.ra},${c.dec}&size=${c.fov}`;
  return `/api/fits-to-png?url=${encodeURIComponent(cutout)}`;
};

const LOG_COLORS: Record<LogLevel, string> = {
  info: 'text-gray-400',
  ok: 'text-green-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

export default function SkyMap() {
  const [ra, setRa] = useState('269.452075');
  const [dec, setDec] = useState('4.693391');
  const [fov, setFov] = useState(0.24);
  const [center, setCenter] = useState<Center>({ ra: '269.452075', dec: '4.693391', fov: 0.24 });
  const [frames, setFrames] = useState<any[]>([]);
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(true);

  const runRef = useRef(0);
  const centerRef = useRef<Center>(center);
  const queueRef = useRef<(() => Promise<void>)[]>([]);
  const activeRef = useRef(0);
  const blobUrlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const userPickedRef = useRef(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((level: LogLevel, text: string) => {
    const t = new Date().toLocaleTimeString('pt-BR');
    setLog((prev) => [...prev.slice(-299), { t, level, text }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [log, showLog]);

  const setTile = useCallback((key: string, state: TileState) => {
    setTiles((prev) => ({ ...prev, [key]: state }));
  }, []);

  // Fila: no máximo MAX_PARALLEL jobs ao mesmo tempo
  const pump = useCallback(() => {
    while (activeRef.current < MAX_PARALLEL && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      activeRef.current++;
      job().finally(() => {
        activeRef.current--;
        pump();
      });
    }
  }, []);

  const loadTile = useCallback(
    (key: string, url: string, runId: number) => {
      if (!url) {
        setTile(key, { status: 'error', message: 'Sem URL' });
        return;
      }
      setTile(key, { status: 'loading' });

      queueRef.current.push(async () => {
        if (runId !== runRef.current) return;
        const signal = abortRef.current?.signal;
        const t0 = Date.now();
        try {
          const res = await fetch(url, { signal });
          if (runId !== runRef.current) return;
          const secs = ((Date.now() - t0) / 1000).toFixed(1);

          if (res.status === 422) {
            setTile(key, { status: 'nocoverage' });
            addLog('info', `${shortName(key)}: sem cobertura (${secs}s)`);
            return;
          }
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
              const j = await res.json();
              if (j?.error) detail += ` · ${j.error}`;
            } catch {}
            throw new Error(detail);
          }

          const blob = await res.blob();
          if (runId !== runRef.current) return;
          const src = URL.createObjectURL(blob);
          blobUrlsRef.current.push(src);
          setTile(key, { status: 'ok', src });
          addLog('ok', `${shortName(key)}: ok (${secs}s)`);
        } catch (err: any) {
          if (err?.name === 'AbortError' || runId !== runRef.current) return;
          const msg = err?.message || 'Erro desconhecido';
          setTile(key, { status: 'error', message: msg });
          addLog('error', `${shortName(key)}: ${msg}`);
        }
      });

      pump();
    },
    [pump, setTile, addLog]
  );

  const fetchData = async (targetRa: string, targetDec: string, targetFov: number) => {
    const runId = ++runRef.current;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    queueRef.current = [];
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current = [];
    userPickedRef.current = false;

    const cleanRa = parseFloat(targetRa);
    const cleanDec = parseFloat(targetDec);
    if (isNaN(cleanRa) || isNaN(cleanDec)) {
      setPhase('error');
      setStatusMsg('Coordenadas RA e Dec inválidas. Use graus decimais, por exemplo 269.452075.');
      addLog('error', 'Coordenadas inválidas');
      return;
    }

    const c: Center = { ra: String(cleanRa), dec: String(cleanDec), fov: targetFov };
    centerRef.current = c;
    setCenter(c);
    setFrames([]);
    setTiles({});
    setSelectedKey(null);
    setView({ s: 1, x: 0, y: 0 });
    setPhase('searching');
    setStatusMsg('Consultando a IRSA (pode levar até 30 s se ela estiver lenta)...');
    addLog('info', `Busca: RA ${c.ra}, Dec ${c.dec}, campo ${c.fov}°`);

    const t0 = Date.now();
    try {
      const res = await fetch(`/api/spherex?ra=${c.ra}&dec=${c.dec}&size=${SEARCH_RADIUS}`, {
        signal: abortRef.current.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (runId !== runRef.current) return;

      // Debug vindo do servidor
      const dbg = data?.debug;
      if (dbg) {
        addLog('info', `Servidor: ${dbg.source}${dbg.stale ? ' (DADOS ANTIGOS)' : ''} em ${dbg.elapsedMs}ms`);
        (dbg.attempts || []).forEach((a: any) =>
          addLog(
            a.status === 200 ? 'ok' : 'warn',
            `  tentativa ${a.n}: ${a.status} em ${a.ms}ms${a.note ? ' · ' + a.note : ''}`
          )
        );
      }

      if (!res.ok) {
        throw new Error(
          `${data?.error || 'Falha na busca'} (HTTP ${res.status}${dbg?.error ? ' · ' + dbg.error : ''})`
        );
      }

      const items = (data.data || []).filter((f: any) => frameKey(f));
      setFrames(items);
      addLog(items.length ? 'ok' : 'warn', `${items.length} observações em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (items.length === 0) {
        setPhase('done');
        setStatusMsg('Nenhuma observação do SPHEREx cobre essa coordenada.');
        return;
      }

      setPhase('rendering');
      setStatusMsg(`${items.length} observações encontradas. Baixando recortes...`);
      items.forEach((f: any) => loadTile(frameKey(f), buildPngUrl(f, c), runId));
    } catch (err: any) {
      if (err?.name === 'AbortError' || runId !== runRef.current) return;
      console.error(err);
      setPhase('error');
      setStatusMsg(err?.message || 'Erro ao buscar dados.');
      addLog('error', err?.message || 'Erro ao buscar dados');
    }
  };

  useEffect(() => {
    fetchData(ra, dec, fov);
    return () => {
      abortRef.current?.abort();
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seleciona automaticamente o primeiro frame com cobertura (até o usuário escolher um)
  useEffect(() => {
    if (userPickedRef.current) return;
    const first = frames.find((f) => tiles[frameKey(f)]?.status === 'ok');
    if (first) setSelectedKey(frameKey(first));
  }, [tiles, frames]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchData(ra, dec, fov);
  };

  const selectTarget = (t: { ra: string; dec: string }) => {
    setRa(t.ra);
    setDec(t.dec);
    fetchData(t.ra, t.dec, fov);
  };

  const pickFrame = (key: string) => {
    userPickedRef.current = true;
    setSelectedKey(key);
  };

  const retryTile = (frame: any) => {
    loadTile(frameKey(frame), buildPngUrl(frame, centerRef.current), runRef.current);
  };

  const retryAllErrors = () => {
    frames.forEach((f) => {
      if (tiles[frameKey(f)]?.status === 'error') retryTile(f);
    });
  };

  // ---- Zoom e arraste ----
  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const s = Math.min(16, Math.max(1, v.s * factor));
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  };

  const zoomButton = (factor: number) => {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(factor, rect.width / 2, rect.height / 2);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.px), y: d.vy + (e.clientY - d.py) }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  // ---- Contadores e estado geral ----
  const counts = { loading: 0, ok: 0, nocoverage: 0, error: 0 };
  frames.forEach((f) => {
    counts[tiles[frameKey(f)]?.status || 'loading']++;
  });
  const done = counts.ok + counts.nocoverage + counts.error;
  const allDone = frames.length > 0 && done === frames.length;

  let banner: { color: string; text: string };
  if (phase === 'searching') banner = { color: 'bg-blue-900/40 border-blue-700 text-blue-200', text: '⏳ ' + statusMsg };
  else if (phase === 'error') banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ ' + statusMsg };
  else if (phase === 'rendering' && !allDone)
    banner = { color: 'bg-blue-900/40 border-blue-700 text-blue-200', text: `⏳ Baixando recortes: ${done}/${frames.length}` };
  else if (allDone && counts.ok === 0)
    banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ Nenhum recorte funcionou. Veja o log abaixo.' };
  else if (allDone && counts.error > 0)
    banner = { color: 'bg-yellow-900/40 border-yellow-700 text-yellow-200', text: `⚠️ ${counts.ok} ok, mas ${counts.error} falharam. Dá para tentar de novo.` };
  else if (allDone)
    banner = { color: 'bg-green-900/40 border-green-700 text-green-200', text: `✅ ${counts.ok} imagens carregadas (${counts.nocoverage} sem cobertura).` };
  else banner = { color: 'bg-gray-800 border-gray-700 text-gray-300', text: statusMsg || 'Pronto.' };

  const loading = phase === 'searching';
  const selectedFrame = frames.find((f) => frameKey(f) === selectedKey) || null;
  const selectedTile = selectedKey ? tiles[selectedKey] : undefined;
  const stripFrames = frames.filter((f) => tiles[frameKey(f)]?.status !== 'nocoverage');

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Topo */}
      <header className="flex flex-wrap items-center justify-between gap-4 p-3 bg-gray-900 border-b border-gray-800 shadow-md">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-blue-400">SPHEREx Sky Explorer</h1>
          <div className="hidden md:flex gap-1">
            {CHALLENGE_TARGETS.map((t) => (
              <button
                key={t.name}
                onClick={() => selectTarget(t)}
                className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 px-2.5 py-1 rounded transition"
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2 items-center text-sm">
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
            <span className="text-[10px] text-gray-400">RA:</span>
            <input
              type="text"
              value={ra}
              onChange={(e) => setRa(e.target.value)}
              className="w-20 bg-transparent text-white text-xs outline-none"
            />
          </div>
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
            <span className="text-[10px] text-gray-400">Dec:</span>
            <input
              type="text"
              value={dec}
              onChange={(e) => setDec(e.target.value)}
              className="w-20 bg-transparent text-white text-xs outline-none"
            />
          </div>
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
            <span className="text-[10px] text-gray-400">Campo:</span>
            <select
              value={fov}
              onChange={(e) => setFov(parseFloat(e.target.value))}
              className="bg-transparent text-white text-xs outline-none"
            >
              {FOV_OPTIONS.map((o) => (
                <option key={o} value={o} className="bg-gray-900">
                  {o}°
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-4 py-1 rounded text-xs font-medium transition"
          >
            {loading ? 'Buscando...' : 'Gerar Mapa'}
          </button>
        </form>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Coluna principal */}
        <main className="flex-1 flex flex-col min-w-0 p-4 gap-3">
          <div className={`border rounded px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2 ${banner.color}`}>
            <span>{banner.text}</span>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span>RA {center.ra}, Dec {center.dec} · {center.fov}°</span>
              {counts.error > 0 && (
                <button
                  onClick={retryAllErrors}
                  className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white font-sans transition"
                >
                  Tentar erros de novo
                </button>
              )}
              {phase === 'error' && (
                <button
                  onClick={() => fetchData(ra, dec, fov)}
                  className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white font-sans transition"
                >
                  Tentar de novo
                </button>
              )}
            </div>
          </div>

          {frames.length > 0 && !allDone && (
            <div className="h-1.5 w-full bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${(done / frames.length) * 100}%` }}
              />
            </div>
          )}

          {/* Mapa principal */}
          <div className="flex-1 min-h-0 relative bg-black rounded-lg border border-gray-800 overflow-hidden">
            <div
              ref={viewerRef}
              className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none select-none"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {selectedTile?.status === 'ok' && selectedTile.src ? (
                <div
                  className="absolute inset-0"
                  style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                    transformOrigin: '0 0',
                  }}
                >
                  <img
                    src={selectedTile.src}
                    alt="Mapa do céu"
                    draggable={false}
                    className="w-full h-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  {/* Mira no centro (posição do alvo) */}
                  <div
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-yellow-400/80 pointer-events-none"
                    style={{ width: `${28 / view.s}px`, height: `${28 / view.s}px`, borderWidth: `${1 / view.s}px` }}
                  />
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm px-6 text-center">
                  {selectedTile?.status === 'error' ? (
                    <div className="flex flex-col items-center gap-2">
                      <span className="text-xs text-red-400">{selectedTile.message}</span>
                      {selectedFrame && (
                        <button
                          onClick={() => retryTile(selectedFrame)}
                          className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded"
                        >
                          ↻ Tentar de novo
                        </button>
                      )}
                    </div>
                  ) : phase === 'searching' || (phase === 'rendering' && !allDone) ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                      <span className="text-xs">{phase === 'searching' ? 'Consultando a IRSA...' : 'Montando o mapa...'}</span>
                    </div>
                  ) : (
                    <span className="text-xs">Sem imagem para mostrar. Veja o log ao lado.</span>
                  )}
                </div>
              )}
            </div>

            <div className="absolute top-3 right-3 flex flex-col gap-1">
              <button onClick={() => zoomButton(1.5)} className="w-8 h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-lg leading-none">+</button>
              <button onClick={() => zoomButton(1 / 1.5)} className="w-8 h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-lg leading-none">−</button>
              <button onClick={() => setView({ s: 1, x: 0, y: 0 })} className="w-8 h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 rounded text-[10px]">1:1</button>
            </div>

            <div className="absolute bottom-2 left-3 text-[10px] text-gray-500 font-mono pointer-events-none">
              zoom {view.s.toFixed(1)}x · roda do mouse = zoom · arraste = mover · círculo = alvo
            </div>
          </div>

          {/* Faixa de frames */}
          <div className="h-28 shrink-0 overflow-x-auto overflow-y-hidden">
            <div className="flex gap-2 h-full">
              {stripFrames.map((frame) => {
                const key = frameKey(frame);
                const tile = tiles[key] || { status: 'loading' as TileStatus };
                const isSelected = selectedKey === key;
                const idx = frames.indexOf(frame);

                return (
                  <div
                    key={key}
                    onClick={() => pickFrame(key)}
                    className={`shrink-0 w-24 flex flex-col gap-1 p-1 rounded border cursor-pointer transition ${
                      isSelected ? 'border-blue-500 bg-gray-800' : 'border-gray-800 bg-gray-900 hover:border-gray-600'
                    }`}
                  >
                    <div className="flex-1 min-h-0 bg-black rounded overflow-hidden flex items-center justify-center">
                      {tile.status === 'ok' && tile.src && (
                        <img
                          src={tile.src}
                          alt={`Frame ${idx + 1}`}
                          draggable={false}
                          className="w-full h-full object-cover"
                          style={{ imageRendering: 'pixelated' }}
                        />
                      )}
                      {tile.status === 'loading' && (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                      )}
                      {tile.status === 'error' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            retryTile(frame);
                          }}
                          className="text-[10px] text-red-400 hover:text-red-300"
                        >
                          ↻ erro
                        </button>
                      )}
                    </div>
                    <div className="text-[9px] text-gray-400 font-mono truncate">
                      #{idx + 1} · {frame.energy_bandpassname || 'IR'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        {/* Painel lateral */}
        <aside className="w-80 bg-gray-900/95 border-l border-gray-800 flex flex-col z-10 p-4 gap-3 backdrop-blur min-h-0">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Frame selecionado</h3>
            <p className="text-xs text-gray-400 mt-0.5">Escolha outro na faixa embaixo do mapa.</p>
          </div>

          {selectedFrame ? (
            <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 flex flex-col gap-2">
              <div className="flex flex-col gap-1 text-xs">
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Frame:</span>
                  <span className="font-mono text-gray-200">
                    #{frames.indexOf(selectedFrame) + 1} de {frames.length}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Data:</span>
                  <span className="font-mono text-gray-200">
                    {selectedFrame.date || selectedFrame.obs_release_date || 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Banda:</span>
                  <span className="font-mono text-gray-200">{selectedFrame.energy_bandpassname || 'N/A'}</span>
                </div>
              </div>
              <a
                href={selectedFrame.access_url}
                target="_blank"
                rel="noreferrer"
                className="text-center bg-blue-600 hover:bg-blue-500 text-white py-2 rounded text-xs font-medium transition block shadow"
              >
                📥 Baixar FITS Original Bruto
              </a>
            </div>
          ) : (
            <div className="text-xs text-gray-500 py-4 text-center">Nenhum frame selecionado.</div>
          )}

          {/* Log de debug */}
          <div className="flex-1 min-h-0 flex flex-col border-t border-gray-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-xs text-gray-300">Log de debug</h3>
              <div className="flex gap-2 text-[10px]">
                <button onClick={() => setShowLog((s) => !s)} className="text-gray-400 hover:text-white">
                  {showLog ? 'ocultar' : 'mostrar'}
                </button>
                <button onClick={() => setLog([])} className="text-gray-400 hover:text-white">
                  limpar
                </button>
              </div>
            </div>
            {showLog && (
              <div className="flex-1 min-h-0 overflow-y-auto bg-black/60 border border-gray-800 rounded p-2 font-mono text-[10px] leading-relaxed">
                {log.length === 0 && <span className="text-gray-600">Sem eventos ainda.</span>}
                {log.map((l, i) => (
                  <div key={i} className={LOG_COLORS[l.level]}>
                    <span className="text-gray-600">{l.t}</span> {l.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>

          <div className="text-[10px] text-center text-gray-500 border-t border-gray-800 pt-3">
            SPHEREx Explorer • Dados: NASA/IPAC IRSA
          </div>
        </aside>
      </div>
    </div>
  );
}