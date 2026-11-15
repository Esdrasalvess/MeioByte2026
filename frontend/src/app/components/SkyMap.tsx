'use client';
import TimelinePlayer from './TimelinePlayer';
import { parseCoords } from '../../lib/coords';

import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    A?: any;
  }
}

// Célula que avisa quando entra/sai da área visível da faixa (com folga de ~3 thumbnails)
function LazyCell({
  rootRef,
  onEnter,
  onLeave,
  onClick,
  className,
  children,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const cb = useRef({ onEnter, onLeave });
  cb.current = { onEnter, onLeave }; // sempre a versão mais nova, sem recriar o observer

  useEffect(() => {
    const el = elRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? cb.current.onEnter() : cb.current.onLeave()),
      { root, rootMargin: '0px 320px 0px 320px', threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={elRef} onClick={onClick} className={className}>
      {children}
    </div>
  );
}

const CHALLENGE_TARGETS = [
  { name: "Barnard's Star", ra: '269.452075', dec: '4.693391' },
  { name: 'WISE 0855', ra: '133.795129', dec: '-7.245147' },
  { name: 'Epsilon Indi B', ra: '330.840225', dec: '-56.785983' },
  { name: 'RW Aurigae', ra: '76.956542', dec: '30.401444' },
  { name: 'R Draconis', ra: '248.163292', dec: '66.754722' },
];

// "Campo" = tamanho do recorte dos frames (graus). O mapa mostra 3x esse valor.
const FOV_OPTIONS = [0.08, 0.16, 0.24, 0.4];
const MAP_FOV_FACTOR = 3;
const SEARCH_RADIUS = 0.05;
const MAX_PARALLEL = 4;

const ALADIN_SRC = '/aladin.js';
const SURVEYS = [
  { id: 'dss', label: 'DSS2 cor (óptico)', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color' },
];
const surveyUrl = (id: string) => (SURVEYS.find((s) => s.id === id) ?? SURVEYS[0]).url;
type TileStatus = 'loading' | 'ok' | 'nocoverage' | 'error';
type TileState = { status: TileStatus; src?: string; message?: string };
type Center = { ra: string; dec: string; fov: number };
type View = { s: number; x: number; y: number };
type LogLevel = 'info' | 'ok' | 'warn' | 'error';
type LogEntry = { t: string; level: LogLevel; text: string };
type Phase = 'idle' | 'searching' | 'rendering' | 'done' | 'error';
type MapState = 'loading' | 'ready' | 'error';
type Mode = 'map' | 'frame' | 'video';

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

// ---- Carrega o Aladin Lite (script do CDS) só no navegador ----
let aladinPromise: Promise<any> | null = null;

function loadAladin(): Promise<any> {
  if (aladinPromise) return aladinPromise;

  const loadAsScript = () =>
    new Promise<any>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ALADIN_SRC;
      s.async = true;
      s.onload = () => (window.A ? resolve(window.A) : reject(new Error('O script carregou, mas window.A não existe')));
      s.onerror = () => reject(new Error(`Não foi possível baixar ${ALADIN_SRC}`));
      document.head.appendChild(s);
    });

  const load = (async () => {
    let A: any = window.A;

    if (!A) {
      // 1) O arquivo do npm é módulo ES: import() nativo do navegador, fora do bundler
      try {
        const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
        const mod = await dynImport(new URL(ALADIN_SRC, window.location.origin).href);
        A = mod?.default || mod?.A || window.A;
      } catch (e: any) {
        // 2) Plano B: carregar como <script> clássico (formato antigo)
        try {
          A = await loadAsScript();
        } catch (e2: any) {
          throw new Error(`import(): ${e?.message || e} | script: ${e2?.message || e2}`);
        }
      }
    }

    if (!A) throw new Error('O arquivo carregou, mas não exporta o Aladin (default ou A)');
    if (A.init && typeof A.init.then === 'function') await A.init;
    return A;
  })();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timeout de 20s carregando o Aladin Lite')), 20000)
  );

  aladinPromise = Promise.race([load, timeout]).catch((e) => {
    aladinPromise = null; // permite tentar de novo
    throw e;
  });
  return aladinPromise;
}

function setSurvey(aladin: any, A: any, url: string, onError: (m: string) => void) {
  const hips = A.imageHiPS(url, { errorCallback: () => onError(`HiPS não encontrado: ${url}`) });
  aladin.setBaseImageLayer(hips);
}
export default function SkyMap() {
  const [ra, setRa] = useState('269.452075');
  const [picked, setPicked] = useState<{ ra: number; dec: number } | null>(null);
  const [dec, setDec] = useState('4.693391');
  const [fov, setFov] = useState(0.24);
  const [band, setBand] = useState('color');
  const [mode, setMode] = useState<Mode>('map');
  const [mapState, setMapState] = useState<MapState>('loading');
  const [mapMsg, setMapMsg] = useState('Carregando o Aladin Lite...');

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
  const bandRef = useRef(band);
const queueRef = useRef<{ key: string; run: () => Promise<void> }[]>([]);
const stripRef = useRef<HTMLDivElement | null>(null);
const tilesRef = useRef<Record<string, TileState>>({});
  const activeRef = useRef(0);
  const blobUrlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const userPickedRef = useRef(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<any>(null);
  const aRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const pausedRef = useRef(false);

    tilesRef.current = tiles;


  const addLog = useCallback((level: LogLevel, text: string) => {
    const t = new Date().toLocaleTimeString('pt-BR');
    setLog((prev) => [...prev.slice(-299), { t, level, text }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [log, showLog]);

  // ---------------- Aladin ----------------
  const moveMap = useCallback(
    (c: Center) => {
      const al = aladinRef.current;
      const A = aRef.current;
      if (!al || !A) return;
      try {
        const r = parseFloat(c.ra);
        const d = parseFloat(c.dec);
        al.gotoRaDec(r, d);
        const setF = al.setFoV || al.setFov;
        if (setF) setF.call(al, c.fov * MAP_FOV_FACTOR);

        // círculo amarelo = área que será recortada nos frames
        if (!overlayRef.current) {
          overlayRef.current = A.graphicOverlay({ color: '#facc15', lineWidth: 2 });
          al.addOverlay(overlayRef.current);
        } else {
          overlayRef.current.removeAll();
        }
        overlayRef.current.add(A.circle(r, d, c.fov / 2));
      } catch (e: any) {
        addLog('warn', `Aladin (mover mapa): ${e?.message || e}`);
      }
    },
    [addLog]
  );

  const initAladin = useCallback(
    (isCancelled: () => boolean = () => false) => {
      setMapState('loading');
      setMapMsg('Carregando o Aladin Lite...');
      addLog('info', 'Carregando Aladin Lite do CDS...');

      loadAladin()
        .then((A) => {
          if (isCancelled() || aladinRef.current) return;
          const c = centerRef.current;
const bandUrl = surveyUrl(bandRef.current);
          aRef.current = A;
          aladinRef.current = A.aladin('#aladin-lite-div', {
            survey: bandUrl,
            target: `${c.ra} ${c.dec}`,
            fov: c.fov * MAP_FOV_FACTOR,
            projection: 'SIN',
            cooFrame: 'equatorial',
            showCooGrid: false,
            showFullscreenControl: false,
            showSimbadPointerControl: false,
          });

          moveMap(c);
          aladinRef.current.on('click', (e: any) => {
  if (e?.isDragging) return; // arraste não conta como clique
  if (!Number.isFinite(e?.ra) || !Number.isFinite(e?.dec)) return;
  addLog('info', `Clique no mapa: RA ${e.ra.toFixed(5)}, Dec ${e.dec.toFixed(5)}`);
  setPicked({ ra: e.ra, dec: e.dec });
});
          setMapState('ready');
          setMapMsg('Mapa pronto');
          addLog('ok', `Aladin pronto · HiPS ${bandRef.current}`);
        })
        .catch((e: any) => {
          if (isCancelled()) return;
          setMapState('error');
          setMapMsg(e?.message || 'Erro desconhecido');
          addLog('error', `Aladin: ${e?.message || e}`);
        });
    },
    [addLog, moveMap]
  );

  useEffect(() => {
    let cancelled = false;
    initAladin(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Troca de banda (HiPS)
useEffect(() => {
  bandRef.current = band;
  const al = aladinRef.current;
  const A = aRef.current;
  if (!al || !A) return;
  try {
    setSurvey(al, A, surveyUrl(band), (m) => addLog('error', m));
    addLog('info', `Fundo trocado para ${band}`);
  } catch (e: any) {
    addLog('error', `Falha ao trocar HiPS: ${e?.message || e}`);
  }
}, [band, addLog]);

  // ---------------- Frames (fila de recortes) ----------------
  const setTile = useCallback((key: string, state: TileState) => {
    setTiles((prev) => ({ ...prev, [key]: state }));
  }, []);

  const pump = useCallback(() => {
  while (!pausedRef.current && activeRef.current < MAX_PARALLEL && queueRef.current.length > 0) {
    const item = queueRef.current.shift()!;
    activeRef.current++;
    item.run().finally(() => {
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

    queueRef.current.push({
      key,
      run: async () => {
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
          if (res.status === 499) return;
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
      },
    });

    pump();
  },
  [pump, setTile, addLog]
);

// Pedido pela visibilidade: só enfileira se ainda não foi pedido
const enterTile = (frame: any) => {
  const key = frameKey(frame);
  if (tilesRef.current[key]) return;
  if (queueRef.current.some((q) => q.key === key)) return;
  loadTile(key, buildPngUrl(frame, centerRef.current), runRef.current);
};

// Saiu da tela e ainda não começou a baixar: tira da fila
const cancelQueued = (key: string) => {
  const i = queueRef.current.findIndex((q) => q.key === key);
  if (i < 0) return; // já está baixando ou pronto: deixa terminar
  queueRef.current.splice(i, 1);
  setTiles((prev) => {
    const next = { ...prev };
    delete next[key];
    return next;
  });
};

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
    moveMap(c); // o mapa vai para o alvo na hora, sem esperar a IRSA

    setFrames([]);
    setTiles({});
    setSelectedKey(null);
    setView({ s: 1, x: 0, y: 0 });
    setMode('map');
    setPicked(null);
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

      const dbg = data?.debug;
      if (dbg) {
        addLog('info', `Servidor: ${dbg.source}${dbg.stale ? ' (DADOS ANTIGOS)' : ''} em ${dbg.elapsedMs}ms`);
        (dbg.attempts || []).forEach((a: any) =>
          addLog(
            a.status === 200 ? 'ok' : 'warn',
            `  ${a.via || ''} tentativa ${a.n}: ${a.status} em ${a.ms}ms${a.note ? ' · ' + a.note : ''}`
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

  // Seleciona o primeiro frame com cobertura (até o usuário escolher um)
  useEffect(() => {
    if (userPickedRef.current) return;
    const first = frames.find((f) => tiles[frameKey(f)]?.status === 'ok');
    if (first) setSelectedKey(frameKey(first));
  }, [tiles, frames]);

 const handleSearch = (e: React.FormEvent) => {
  e.preventDefault();
  const p = parseCoords(`${ra} ${dec}`);
  if (!p) {
    setPhase('error');
    setStatusMsg('Não entendi as coordenadas. Exemplos: "269.452 4.693" ou "08h55m10.8s -07d14m42s". Dá para colar as duas no campo RA.');
    return;
  }
  const r = String(p.ra);
  const d = String(p.dec);
  setRa(r);
  setDec(d);
  fetchData(r, d, fov);
};

  const selectTarget = (t: { ra: string; dec: string }) => {
    setRa(t.ra);
    setDec(t.dec);
    fetchData(t.ra, t.dec, fov);
  };

  const pickFrame = (key: string) => {
    userPickedRef.current = true;
    setSelectedKey(key);
    setMode('frame');
  };

  const retryTile = (frame: any) => {
    loadTile(frameKey(frame), buildPngUrl(frame, centerRef.current), runRef.current);
  };

  const retryAllErrors = () => {
    frames.forEach((f) => {
      if (tiles[frameKey(f)]?.status === 'error') retryTile(f);
    });
  };

  // ---- Zoom e arraste do visualizador de frame ----
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
const requested = frames.filter((f) => tiles[frameKey(f)]);
const counts = { loading: 0, ok: 0, nocoverage: 0, error: 0 };
requested.forEach((f) => {
  counts[tiles[frameKey(f)].status]++;
});
const done = counts.ok + counts.nocoverage + counts.error;
const allDone = requested.length > 0 && done === requested.length;

let banner: { color: string; text: string };
const blue = 'bg-blue-900/40 border-blue-700 text-blue-200';
if (phase === 'searching') banner = { color: blue, text: '⏳ ' + statusMsg };
else if (phase === 'error') banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ ' + statusMsg };
else if (frames.length === 0) banner = { color: 'bg-gray-800 border-gray-700 text-gray-300', text: statusMsg || 'Pronto.' };
else if (requested.length === 0)
  banner = { color: blue, text: `${frames.length} observações encontradas. Abra "Linha do tempo" para ver como esse pedaço do céu muda.` };
else if (!allDone)
  banner = { color: blue, text: `⏳ Baixando os recortes visíveis: ${done}/${requested.length} (de ${frames.length})` };
else if (counts.ok === 0)
  banner = { color: 'bg-red-900/40 border-red-700 text-red-200', text: '❌ Nenhum recorte funcionou. Veja o log.' };
else if (counts.error > 0)
  banner = { color: 'bg-yellow-900/40 border-yellow-700 text-yellow-200', text: `⚠️ ${counts.ok} ok, mas ${counts.error} falharam.` };
else
  banner = { color: 'bg-green-900/40 border-green-700 text-green-200', text: `✅ ${counts.ok} de ${frames.length} recortes carregados (${counts.nocoverage} sem cobertura). Role a faixa para ver mais.` };
  const loading = phase === 'searching';
  const selectedFrame = frames.find((f) => frameKey(f) === selectedKey) || null;
  const selectedTile = selectedKey ? tiles[selectedKey] : undefined;
  const stripFrames = frames.filter((f) => tiles[frameKey(f)]?.status !== 'nocoverage');

  const mapChip =
    mapState === 'ready'
      ? 'bg-green-900/40 border-green-700 text-green-300'
      : mapState === 'error'
      ? 'bg-red-900/40 border-red-700 text-red-300'
      : 'bg-blue-900/40 border-blue-700 text-blue-300';

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
            <input type="text" value={ra} onChange={(e) => setRa(e.target.value)} className="w-20 bg-transparent text-white text-xs outline-none" />
          </div>
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
            <span className="text-[10px] text-gray-400">Dec:</span>
            <input type="text" value={dec} onChange={(e) => setDec(e.target.value)} className="w-20 bg-transparent text-white text-xs outline-none" />
          </div>
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
            <span className="text-[10px] text-gray-400">Campo:</span>
            <select value={fov} onChange={(e) => setFov(parseFloat(e.target.value))} className="bg-transparent text-white text-xs outline-none">
              {FOV_OPTIONS.map((o) => (
                <option key={o} value={o} className="bg-gray-900">
                  {o}°
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={loading} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-4 py-1 rounded text-xs font-medium transition">
            {loading ? 'Buscando...' : 'Gerar Mapa'}
          </button>
        </form>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Coluna principal */}
        <main className="flex-1 flex flex-col min-w-0 p-4 gap-3">
          {/* Faixa de status dos frames */}
          <div className={`border rounded px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2 ${banner.color}`}>
            <span>{banner.text}</span>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span>RA {center.ra}, Dec {center.dec} · {center.fov}°</span>
              {counts.error > 0 && (
                <button onClick={retryAllErrors} className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white font-sans transition">
                  Tentar erros de novo
                </button>
              )}
              {phase === 'error' && (
                <button onClick={() => fetchData(ra, dec, fov)} className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white font-sans transition">
                  Tentar de novo
                </button>
              )}
            </div>
          </div>

          {/* Barra do mapa */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex rounded overflow-hidden border border-gray-700">
              <button
                onClick={() => setMode('map')}
                className={`px-3 py-1 transition ${mode === 'map' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                🗺️ Mapa do céu
              </button>

              <button
  onClick={() => setMode('video')}
  disabled={frames.length === 0}
  className={`px-3 py-1 transition disabled:opacity-40 ${mode === 'video' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
>
  🎬 Linha do tempo{frames.length ? ` · ${frames.length} obs.` : ''}
</button>
            </div>

            <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 px-2 py-1 rounded">
              <span className="text-[10px] text-gray-400">Fundo do mapa:</span>
              <select value={band} onChange={(e) => setBand(e.target.value)} className="bg-transparent text-white text-xs outline-none">
                {SURVEYS.map((b) => (
                  <option key={b.id} value={b.id} className="bg-gray-900">
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            <span className={`border rounded-full px-2.5 py-0.5 text-[11px] ${mapChip}`}>
              {mapState === 'ready' ? '🟢' : mapState === 'error' ? '🔴' : '🟡'} Aladin: {mapMsg}
            </span>
            {mapState === 'error' && (
              <button onClick={() => initAladin()} className="bg-blue-600 hover:bg-blue-500 px-3 py-0.5 rounded-full text-white transition">
                Tentar Aladin de novo
              </button>
            )}
          </div>

          {requested.length > 0 && !allDone && (
  <div className="h-1.5 w-full bg-gray-800 rounded overflow-hidden">
    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${(done / requested.length) * 100}%` }} />
  </div>
)}

          {/* Área do visualizador: mapa Aladin e frame ficam montados, só alterna a visibilidade */}
          <div className="flex-1 min-h-0 relative bg-black rounded-lg border border-gray-800 overflow-hidden">
            {/* Mapa Aladin */}
            <div className={`absolute inset-0 ${mode === 'map' ? '' : 'invisible pointer-events-none'}`}>
              <div className="absolute inset-0">
  <div id="aladin-lite-div" style={{ width: '100%', height: '100%' }} />
</div>
              {mapState !== 'ready' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-center px-6 z-10">
                  {mapState === 'loading' ? (
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                      <span className="text-xs">{mapMsg}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 max-w-md">
                      <span className="text-sm text-red-400">Não consegui carregar o mapa</span>
                      <span className="text-xs text-gray-400">{mapMsg}</span>
                      <span className="text-[11px] text-gray-500">
                        Os frames individuais continuam funcionando na aba “Frame individual”.
                      </span>
                    </div>
                  )}
                </div>
              )}
              {frames.length > 0 && (
  <button
    onClick={() => setMode('video')}
    className="absolute bottom-3 right-3 z-10 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-4 py-2 rounded-full shadow"
  >
    {picked && (
  <div className="absolute top-3 left-3 z-10 bg-gray-900/95 border border-gray-700 rounded p-3 text-xs flex flex-col gap-2">
    <span className="font-mono text-gray-200">
      RA {picked.ra.toFixed(5)} · Dec {picked.dec.toFixed(5)}
    </span>
    <div className="flex gap-2">
      <button
        onClick={() => {
          const r = picked.ra.toFixed(6);
          const d = picked.dec.toFixed(6);
          setRa(r);
          setDec(d);
          fetchData(r, d, fov);
        }}
        className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded"
      >
        Gerar linha do tempo aqui
      </button>
      <button onClick={() => setPicked(null)} className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded">
        cancelar
      </button>
    </div>
  </div>
)}
    ▶ Ver como esse pedaço do céu muda no tempo
  </button>
)}
              {mapState === 'ready' && (
                <div className="absolute bottom-2 left-3 text-[10px] text-gray-300 font-mono pointer-events-none z-10 drop-shadow">
Fundo: HiPS do CDS · círculo amarelo = área do recorte dos frames                </div>
              )}
            </div>

            {/* Frame individual */}
            <div className={`absolute inset-0 ${mode === 'frame' ? '' : 'invisible pointer-events-none'}`}>
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
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0' }}
                  >
                    <img src={selectedTile.src} alt="Frame SPHEREx" draggable={false} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
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
                          <button onClick={() => retryTile(selectedFrame)} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded">
                            ↻ Tentar de novo
                          </button>
                        )}
                      </div>
                    ) : phase === 'searching' || (phase === 'rendering' && !allDone) ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
                        <span className="text-xs">Montando o frame...</span>
                      </div>
                    ) : (
                      <span className="text-xs">Sem frame para mostrar. Veja o log ao lado.</span>
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
            <div className={`absolute inset-0 ${mode === 'video' ? '' : 'invisible pointer-events-none'}`}>
              <TimelinePlayer
  frames={frames}
  center={center}
  active={mode === 'video'}
  selectedKey={selectedKey}
  onSelect={(k) => { userPickedRef.current = true; setSelectedKey(k); }}
/>
            </div>
          </div>

          {/* Faixa de frames: cada thumbnail só baixa quando se aproxima da área visível */}
<div ref={stripRef} className="h-28 shrink-0 overflow-x-auto overflow-y-hidden">
  <div className="flex gap-2 h-full">
    {stripFrames.map((frame) => {
      const key = frameKey(frame);
      const tile = tiles[key];
      const isSelected = selectedKey === key && mode === 'frame';
      const idx = frames.indexOf(frame);

      return (
        <LazyCell
          key={key}
          rootRef={stripRef}
          onEnter={() => enterTile(frame)}
          onLeave={() => cancelQueued(key)}
          onClick={() => pickFrame(key)}
          className={`shrink-0 w-24 flex flex-col gap-1 p-1 rounded border cursor-pointer transition ${
            isSelected ? 'border-blue-500 bg-gray-800' : 'border-gray-800 bg-gray-900 hover:border-gray-600'
          }`}
        >
          <div className="flex-1 min-h-0 bg-black rounded overflow-hidden flex items-center justify-center">
            {tile?.status === 'ok' && tile.src && (
              <img src={tile.src} alt={`Frame ${idx + 1}`} draggable={false} decoding="async" className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
            )}
            {tile?.status === 'loading' && <div className="h-4 w-4 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />}
            {!tile && <span className="text-[9px] text-gray-700">…</span>}
            {tile?.status === 'error' && (
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
            #{idx + 1} · {frame.date || frame.energy_bandpassname || 'IR'}
          </div>
        </LazyCell>
      );
    })}
  </div>
</div>
        </main>

        {/* Painel lateral */}
        <aside className="w-80 bg-gray-900/95 border-l border-gray-800 flex flex-col z-10 p-4 gap-3 backdrop-blur min-h-0">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Frame selecionado</h3>
            <p className="text-xs text-gray-400 mt-0.5">Clique num frame da faixa para ver o recorte dele.</p>
          </div>

          {selectedFrame ? (
            <div className="bg-gray-800 p-3 rounded-lg border border-gray-700 flex flex-col gap-2">
              <div className="flex flex-col gap-1 text-xs">
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Frame:</span>
                  <span className="font-mono text-gray-200">#{frames.indexOf(selectedFrame) + 1} de {frames.length}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700">
                  <span className="text-gray-400">Data:</span>
                  <span className="font-mono text-gray-200">{selectedFrame.date || selectedFrame.obs_release_date || 'N/A'}</span>
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
                <button onClick={() => setShowLog((s) => !s)} className="text-gray-400 hover:text-white">{showLog ? 'ocultar' : 'mostrar'}</button>
                <button onClick={() => setLog([])} className="text-gray-400 hover:text-white">limpar</button>
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
SPHEREx: IRSA/IPAC · Fundo do mapa: CDS Strasbourg          </div>
        </aside>
      </div>
    </div>
  );
}