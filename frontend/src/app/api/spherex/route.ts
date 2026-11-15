// app/api/spherex/route.ts
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, string>;
type Attempt = { n: number; ms: number; status: number | string; note?: string; via?: string };

const cache = new Map<string, { at: number; data: Row[] }>();
const inflight = new Map<string, Promise<{ rows: Row[]; attempts: Attempt[]; via: string }>>();
const CACHE_TTL = 10 * 60 * 1000;

// Versões atuais (QR2 está superado e não é mais pesquisável)
const COLLECTIONS = ['spherex_dr1', 'spherex_qr3'];
const isCurrentRelease = (url: string) => /\/(dr1|qr3)\//.test(url);
const isLevel2Fits = (url: string) => /\.fits$/i.test(url) && url.includes('/level2/');

// ---- Cache em disco (sobrevive a reinícios do servidor) ----
const CACHE_DIR = path.join(process.cwd(), '.cache');
const diskPath = (key: string) => path.join(CACHE_DIR, `spherex-${key.replace(/[^\w.-]/g, '_')}.json`);
function diskRead(key: string): Row[] | null {
  try {
    return JSON.parse(fs.readFileSync(diskPath(key), 'utf8'));
  } catch {
    return null;
  }
}
function diskWrite(key: string, data: Row[]) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(diskPath(key), JSON.stringify(data));
  } catch {}
}

// ---- Semente de emergência (dev): frames do Barnard's Star vistos no log, usados só se TAP e SIA caírem ----
const SEED = { ra: 269.452075, dec: 4.693391 };
const B = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/';
const SEED_URLS = [
  `${B}2025W35_1A/l2b-v27-2026-230/6/level2_2025W35_1A_0484_2D6_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/6/level2_2025W35_1A_0484_1D6_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/2/level2_2025W35_1A_0511_1D2_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/3/level2_2025W35_1A_0484_1D3_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0658_1D1_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/3/level2_2025W35_1A_0484_2D3_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0511_1D5_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/4/level2_2025W35_1A_0658_1D4_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0658_2D1_spx_l2b-v27-2026-230.fits`,
  `${B}2025W35_1A/l2b-v27-2026-230/4/level2_2025W35_1A_0658_2D4_spx_l2b-v27-2026-230.fits`,
  `${B}2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_2D6_spx_l2b-v27-2026-228.fits`,
];
function seedRows(ra: number, dec: number): Row[] {
  if (Math.abs(ra - SEED.ra) > 0.01 || Math.abs(dec - SEED.dec) > 0.01) return [];
  return SEED_URLS.map((u) => ({
    access_url: u,
    date: '',
    energy_bandpassname: `D${u.match(/\/(\d)\/level2_/)?.[1] ?? '?'}`,
  }));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function csvToRows(text: string): Row[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const obj: Row = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
    return obj;
  });
}

// GET com retry e registro de cada tentativa
async function getWithRetry(url: string, via: string, attempts: Attempt[], tries: number, timeoutMs: number) {
  let lastDetail = '';
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      const ms = Date.now() - t0;
      const isHtml = text.trim().startsWith('<');
      if (res.ok && !isHtml) {
        attempts.push({ n: attempts.length + 1, ms, status: res.status, via });
        return text;
      }
      const title = text.match(/<title>(.*?)<\/title>/i)?.[1];
      const note = title || text.replace(/\s+/g, ' ').slice(0, 160);
      lastDetail = `${via}: HTTP ${res.status}${title ? ` (${title})` : ''}`;
      attempts.push({ n: attempts.length + 1, ms, status: res.status, note, via });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e: any) {
      const note = e?.name === 'TimeoutError' ? `timeout de ${timeoutMs / 1000}s` : e?.message || 'erro de rede';
      lastDetail = `${via}: ${note}`;
      attempts.push({ n: attempts.length + 1, ms: Date.now() - t0, status: 'falhou', note, via });
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(lastDetail || `${via}: falha desconhecida`);
}

// MJD -> AAAA-MM-DD
function mjdToDate(v: string | undefined): string {
  const n = parseFloat(v || '');
  if (!Number.isFinite(n) || n < 10000 || n > 100000) return '';
  return new Date((n - 40587) * 86400000).toISOString().slice(0, 10);
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.access_url)) return false;
    seen.add(r.access_url);
    return true;
  });
}

// ---- Caminho principal: TAP ----
async function queryTap(ra: number, dec: number, attempts: Attempt[]): Promise<Row[]> {
  const adql = `SELECT TOP 400
  'https://irsa.ipac.caltech.edu/' || a.uri AS access_url,
  p.obs_publisher_did,
  p.time_bounds_lower,
  p.energy_bandpassname
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', ${ra}, ${dec}), p.poly)
ORDER BY p.time_bounds_lower`;

  const params = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
  const url = `https://irsa.ipac.caltech.edu/TAP/sync?${params.toString()}`;
  const text = await getWithRetry(url, 'TAP', attempts, 3, 60000);

  const raw = csvToRows(text);
  const rows = dedupe(
    raw
      .filter((r) => r.access_url && isLevel2Fits(r.access_url) && isCurrentRelease(r.access_url))
      .map((r) => ({ ...r, date: mjdToDate(r.time_bounds_lower) }))
  );
  attempts.push({
    n: attempts.length + 1,
    ms: 0,
    status: 'info',
    via: 'TAP',
    note: `${raw.length} linhas brutas, ${rows.length} imagens level2 (DR1/QR3)`,
  });
  return rows;
}

// ---- Reserva: SIA2 (DR1 + QR3) ----
async function querySia(ra: number, dec: number, size: string, attempts: Attempt[]): Promise<Row[]> {
  const results = await Promise.allSettled(
    COLLECTIONS.map((c) =>
      getWithRetry(
        `https://irsa.ipac.caltech.edu/SIA?COLLECTION=${c}&POS=circle+${ra}+${dec}+${size}&RESPONSEFORMAT=CSV`,
        `SIA ${c}`,
        attempts,
        2,
        25000
      )
    )
  );

  const raw: Row[] = [];
  let okCount = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      okCount++;
      raw.push(...csvToRows(r.value));
    }
  }
  if (!okCount) throw new Error('SIA: nenhuma coleção respondeu');

  // Colunas ObsCore (nomes padrão, não confirmados na documentação): t_min em MJD, em_min/em_max em metros.
  // Se vierem diferentes, o console.log abaixo mostra a primeira linha.
  if (raw[0]) console.log('[spherex SIA] colunas:', Object.keys(raw[0]).join(', '));

  return dedupe(
    raw
      .filter((r) => r.access_url && isLevel2Fits(r.access_url))
      .map((r) => ({
        ...r,
        date: r.date || mjdToDate(r.t_min),
        energy_bandpassname:
          r.energy_bandpassname ||
          (r.em_min && r.em_max
            ? `${(parseFloat(r.em_min) * 1e6).toFixed(2)}–${(parseFloat(r.em_max) * 1e6).toFixed(2)} µm`
            : ''),
      }))
  );
}

async function fetchRows(ra: number, dec: number, size: string) {
  const attempts: Attempt[] = [];
  try {
    const rows = await queryTap(ra, dec, attempts);
    return { rows, attempts, via: 'TAP' };
  } catch (tapErr: any) {
    try {
      const rows = await querySia(ra, dec, size, attempts);
      return { rows, attempts, via: 'SIA (reserva)' };
    } catch (siaErr: any) {
      throw Object.assign(new Error(`${tapErr.message} | ${siaErr.message}`), { attempts });
    }
  }
}

export async function GET(request: Request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const ra = parseFloat(searchParams.get('ra') || '');
  const dec = parseFloat(searchParams.get('dec') || '');
  const size = searchParams.get('size') || '0.05';

  if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
    return NextResponse.json({ error: 'RA/Dec inválidos' }, { status: 400 });
  }

  const key = `${ra},${dec}`;
  const tag = `[spherex ${key}]`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    console.log(`${tag} cache (${hit.data.length} linhas)`);
    return NextResponse.json({
      data: hit.data,
      debug: { source: 'cache', ageSec: Math.round((Date.now() - hit.at) / 1000), elapsedMs: Date.now() - t0 },
    });
  }

  let shared = true;
  let job = inflight.get(key);
  if (!job) {
    shared = false;
    job = fetchRows(ra, dec, size).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }

  try {
    const { rows, attempts, via } = await job;
    if (rows.length > 0) {
      cache.set(key, { at: Date.now(), data: rows });
      diskWrite(key, rows);
    }
    console.log(`${tag} ${via} ok: ${rows.length} linhas, ${Date.now() - t0}ms${shared ? ' (compartilhado)' : ''}`);
    return NextResponse.json({
      data: rows,
      debug: { source: `${via}${shared ? ' (compartilhado)' : ''}`, attempts, elapsedMs: Date.now() - t0 },
    });
  } catch (error: any) {
    const attempts: Attempt[] = error.attempts || [];
    console.error(`${tag} FALHOU: ${error.message}`);
    attempts.forEach((a) => console.error(`   ${a.via} tentativa ${a.n}: ${a.status} em ${a.ms}ms ${a.note || ''}`));

    // 1) cache em memória vencido
    if (hit) {
      return NextResponse.json({
        data: hit.data,
        debug: { source: 'cache antigo', stale: true, error: error.message, attempts, elapsedMs: Date.now() - t0 },
      });
    }

    // 2) cache em disco
    const disk = diskRead(key);
    if (disk && disk.length) {
      return NextResponse.json({
        data: disk,
        debug: { source: 'cache em disco', stale: true, error: error.message, attempts, elapsedMs: Date.now() - t0 },
      });
    }

    // 3) semente de emergência (só Barnard's Star)
    const seed = seedRows(ra, dec);
    if (seed.length) {
      return NextResponse.json({
        data: seed,
        debug: { source: 'semente (busca da IRSA fora do ar)', stale: true, error: error.message, attempts, elapsedMs: Date.now() - t0 },
      });
    }

    return NextResponse.json(
      { error: 'A IRSA não respondeu (TAP e SIA).', debug: { error: error.message, attempts, elapsedMs: Date.now() - t0 } },
      { status: 502 }
    );
  }
}