// app/api/align/route.ts
import { NextResponse } from 'next/server';
import { D2R, R2D, skyToTangent, tangentToSky, gridToTangentDeg } from '../../../lib/sky';

type Hdu = { header: Record<string, string>; dataStart: number };
type Sip = [number, number, number][];
type Wcs = {
  crval: [number, number];
  crpix: [number, number];
  inv: [[number, number], [number, number]];
  sipA: Sip;
  sipB: Sip;
  ctype: string;
};

// ---- Limita pedidos simultâneos à IRSA ----
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

// ---- Cache dos frames já alinhados ----
const cache = new Map<string, { buf: Buffer; info: string }>();
const CACHE_MAX = 40;

async function fetchWithRetry(url: string, tries = 3) {
  let lastStatus = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status < 500 && res.status !== 429) break;
    } catch {
      lastStatus = 0;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  const err: any = new Error(`Erro no cutout IRSA: ${lastStatus || 'timeout/rede'}`);
  err.status = lastStatus;
  throw err;
}

// ---- Parser de FITS (MEF) ----
function parseHdus(buf: Buffer): Hdu[] {
  const hdus: Hdu[] = [];
  let offset = 0;
  while (offset + 2880 <= buf.length) {
    const header: Record<string, string> = {};
    let ended = false;
    while (!ended && offset + 2880 <= buf.length) {
      for (let i = 0; i < 36; i++) {
        const card = buf.toString('ascii', offset + i * 80, offset + (i + 1) * 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') { ended = true; break; }
        if (card[8] === '=') {
          header[key] = card.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim();
        }
      }
      offset += 2880;
    }
    if (!ended) break;

    const bitpix = Math.abs(parseInt(header['BITPIX'] || '8', 10)) / 8;
    const naxis = parseInt(header['NAXIS'] || '0', 10);
    let prod = naxis > 0 ? 1 : 0;
    for (let n = 1; n <= naxis; n++) prod *= parseInt(header[`NAXIS${n}`] || '0', 10);
    const pcount = parseInt(header['PCOUNT'] || '0', 10);
    const gcount = parseInt(header['GCOUNT'] || '1', 10);
    const dataBytes = bitpix * gcount * (pcount + prod);

    hdus.push({ header, dataStart: offset });
    offset += Math.ceil(dataBytes / 2880) * 2880;
  }
  return hdus;
}

// ---- WCS (TAN + SIP opcional) ----
const num = (h: Record<string, string>, k: string, d = NaN) => {
  const s = h[k];
  if (s === undefined) return d;
  const v = parseFloat(s.replace(/[dD]/, 'E'));
  return Number.isFinite(v) ? v : d;
};

function readSip(h: Record<string, string>, p: 'A' | 'B'): Sip {
  const order = num(h, `${p}_ORDER`, 0);
  const out: Sip = [];
  for (let a = 0; a <= order; a++) {
    for (let b = 0; a + b <= order; b++) {
      if (a + b < 2) continue;
      const c = num(h, `${p}_${a}_${b}`, 0);
      if (c !== 0) out.push([a, b, c]);
    }
  }
  return out;
}

function readWcs(h: Record<string, string>): Wcs {
  const ctype = h['CTYPE1'] || '';
  if (!ctype.includes('TAN')) throw new Error(`Projeção WCS não suportada: "${ctype || 'sem CTYPE1'}"`);

  const crval: [number, number] = [num(h, 'CRVAL1'), num(h, 'CRVAL2')];
  const crpix: [number, number] = [num(h, 'CRPIX1'), num(h, 'CRPIX2')];
  if (!Number.isFinite(crval[0]) || !Number.isFinite(crpix[0])) throw new Error('Header sem CRVAL/CRPIX');

  let cd: [[number, number], [number, number]];
  if (Number.isFinite(num(h, 'CD1_1'))) {
    cd = [
      [num(h, 'CD1_1'), num(h, 'CD1_2', 0)],
      [num(h, 'CD2_1', 0), num(h, 'CD2_2')],
    ];
  } else {
    const d1 = num(h, 'CDELT1');
    const d2 = num(h, 'CDELT2');
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) throw new Error('Header sem CD nem CDELT');
    cd = [
      [d1 * num(h, 'PC1_1', 1), d1 * num(h, 'PC1_2', 0)],
      [d2 * num(h, 'PC2_1', 0), d2 * num(h, 'PC2_2', 1)],
    ];
  }
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!det) throw new Error('Matriz CD singular');
  const inv: [[number, number], [number, number]] = [
    [cd[1][1] / det, -cd[0][1] / det],
    [-cd[1][0] / det, cd[0][0] / det],
  ];
  return { crval, crpix, inv, sipA: readSip(h, 'A'), sipB: readSip(h, 'B'), ctype };
}

const sipEval = (c: Sip, u: number, v: number) => {
  let s = 0;
  for (const [a, b, k] of c) s += k * Math.pow(u, a) * Math.pow(v, b);
  return s;
};

// céu (graus) -> pixel (base 0) da imagem de entrada
function worldToPixel(w: Wcs, raDeg: number, decDeg: number): [number, number] | null {
  const t = skyToTangent(raDeg * D2R, decDeg * D2R, w.crval[0] * D2R, w.crval[1] * D2R);
  if (!t) return null;
  const x = t.xi * R2D;
  const y = t.eta * R2D;
  const U = w.inv[0][0] * x + w.inv[0][1] * y;
  const V = w.inv[1][0] * x + w.inv[1][1] * y;
  let u = U;
  let v = V;
  if (w.sipA.length || w.sipB.length) {
    for (let it = 0; it < 8; it++) {
      u = U - sipEval(w.sipA, u, v);
      v = V - sipEval(w.sipB, u, v);
    }
  }
  return [u + w.crpix[0] - 1, v + w.crpix[1] - 1];
}

export async function GET(request: Request) {
  const t0 = Date.now();
  const { searchParams } = new URL(request.url);
  const baseUrl = searchParams.get('url') || '';
  const raDeg = parseFloat(searchParams.get('ra') || '');
  const decDeg = parseFloat(searchParams.get('dec') || '');
  const fov = parseFloat(searchParams.get('fov') || '0.24');
  const scale = parseFloat(searchParams.get('scale') || '3.075'); // arcsec/pixel da grade de saída

  if (!baseUrl.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL fora do arquivo SPHEREx' }, { status: 400 });
  }
  if (![raDeg, decDeg, fov, scale].every(Number.isFinite) || fov <= 0 || scale <= 0) {
    return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 });
  }

  const n = Math.min(1400, Math.max(16, Math.round((fov * 3600) / scale)));
  const key = `${baseUrl}|${raDeg}|${decDeg}|${fov}|${scale}`;

  const hit = cache.get(key);
  if (hit) {
    return new NextResponse(new Uint8Array(hit.buf), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Align-Info': hit.info, 'Cache-Control': 'no-store' },
    });
  }

  // O quadrado de saída (norte em cima) pode ficar girado em relação ao detector: recorte maior evita cantos vazios
  const cutoutUrl = `${baseUrl}?center=${raDeg},${decDeg}&size=${(fov * 1.45).toFixed(4)}`;

  await acquire();
  try {
    const response = await fetchWithRetry(cutoutUrl);
    const tDown = Date.now() - t0;
    const buffer = Buffer.from(await response.arrayBuffer());

    const hdus = parseHdus(buffer);
    const img =
      hdus.find((h) => h.header['EXTNAME'] === 'IMAGE' && h.header['NAXIS'] === '2') ||
      hdus.find((h) => h.header['NAXIS'] === '2' && h.header['BITPIX'] === '-32');
    if (!img) throw new Error('Nenhuma extensão de imagem 2D encontrada');
    if (parseInt(img.header['BITPIX'], 10) !== -32) throw new Error(`BITPIX ${img.header['BITPIX']} não suportado`);

    const W = parseInt(img.header['NAXIS1'], 10);
    const H = parseInt(img.header['NAXIS2'], 10);
    const wcs = readWcs(img.header);

    const src = new Float32Array(W * H);
    for (let k = 0; k < src.length; k++) src[k] = buffer.readFloatBE(img.dataStart + k * 4);

    // Reprojeção: para cada pixel da grade de saída, acha o pixel de entrada (interpolação bilinear)
    const ra0 = raDeg * D2R;
    const dec0 = decDeg * D2R;
    const out = new Float32Array(n * n).fill(NaN);
    let valid = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const g = gridToTangentDeg(i, j, n, scale);
        const sky = tangentToSky(g.xi * D2R, g.eta * D2R, ra0, dec0);
        const p = worldToPixel(wcs, sky.ra * R2D, sky.dec * R2D);
        if (!p) continue;
        const [px, py] = p;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
        const fx = px - x0;
        const fy = py - y0;
        const a = src[y0 * W + x0];
        const b = src[y0 * W + x0 + 1];
        const c = src[(y0 + 1) * W + x0];
        const d = src[(y0 + 1) * W + x0 + 1];
        const val = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
        if (Number.isFinite(val)) {
          out[j * n + i] = val;
          valid++;
        }
      }
    }

    if (valid < n * n * 0.02) {
      const err: any = new Error('O recorte não cobre essa região (menos de 2% de pixels válidos)');
      err.status = 422;
      throw err;
    }

    // Tira o fundo (mediana) de cada frame: o brilho zodiacal muda de uma observação para outra
    const sample: number[] = [];
    const stride = Math.max(1, Math.floor(out.length / 20000));
    for (let k = 0; k < out.length; k += stride) if (Number.isFinite(out[k])) sample.push(out[k]);
    sample.sort((a, b) => a - b);
    const bg = sample.length ? sample[Math.floor(sample.length / 2)] : 0;
    for (let k = 0; k < out.length; k++) out[k] -= bg;

    const info = JSON.stringify({
      n,
      scale,
      bg: Number(bg.toFixed(4)),
      valid: Math.round((valid / (n * n)) * 100),
      ctype: wcs.ctype,
      sip: wcs.sipA.length > 0 || wcs.sipB.length > 0,
      src: `${W}x${H}`,
      downloadMs: tDown,
      totalMs: Date.now() - t0,
    });

    const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { buf: Buffer.from(buf), info });

    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Align-Info': info, 'Cache-Control': 'no-store' },
    });
  } catch (error: any) {
    console.error('[align]', error.message);
    return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 422 : 502 });
  } finally {
    release();
  }
}