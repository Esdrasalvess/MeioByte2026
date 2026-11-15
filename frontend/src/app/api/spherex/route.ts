// app/api/spherex/route.ts
import { NextResponse } from 'next/server';

type Row = Record<string, string>;
type Attempt = { n: number; ms: number; status: number | string; note?: string; via?: string };

const cache = new Map<string, { at: number; data: Row[] }>();
const inflight = new Map<string, Promise<{ rows: Row[]; attempts: Attempt[]; via: string }>>();
const CACHE_TTL = 10 * 60 * 1000;

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
function mjdToDate(v: string): string {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 10000 || n > 100000) return '';
  return new Date((n - 40587) * 86400000).toISOString().slice(0, 10);
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
  const rows = raw
    .filter((r) => r.access_url && /\.fits$/i.test(r.access_url) && r.access_url.includes('/level2/'))
    .map((r) => ({
      ...r,
      date: mjdToDate(r.time_bounds_lower),
    }));
  attempts.push({ n: attempts.length + 1, ms: 0, status: 'info', via: 'TAP', note: `${raw.length} linhas brutas, ${rows.length} imagens level2` });
  return rows;
}

// ---- Reserva: SIA ----
async function querySia(ra: number, dec: number, size: string, attempts: Attempt[]): Promise<Row[]> {
  const url = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr3&POS=circle+${ra}+${dec}+${size}&RESPONSEFORMAT=CSV`;
  const text = await getWithRetry(url, 'SIA', attempts, 2, 25000);
  return csvToRows(text);
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
    if (rows.length > 0) cache.set(key, { at: Date.now(), data: rows });
    console.log(`${tag} ${via} ok: ${rows.length} linhas, ${Date.now() - t0}ms${shared ? ' (compartilhado)' : ''}`);
    return NextResponse.json({
      data: rows,
      debug: { source: `${via}${shared ? ' (compartilhado)' : ''}`, attempts, elapsedMs: Date.now() - t0 },
    });
  } catch (error: any) {
    const attempts: Attempt[] = error.attempts || [];
    console.error(`${tag} FALHOU: ${error.message}`);
    attempts.forEach((a) => console.error(`   ${a.via} tentativa ${a.n}: ${a.status} em ${a.ms}ms ${a.note || ''}`));

    if (hit) {
      return NextResponse.json({
        data: hit.data,
        debug: { source: 'cache antigo', stale: true, error: error.message, attempts, elapsedMs: Date.now() - t0 },
      });
    }
    return NextResponse.json(
      { error: 'A IRSA não respondeu (TAP e SIA).', debug: { error: error.message, attempts, elapsedMs: Date.now() - t0 } },
      { status: 502 }
    );
  }
}