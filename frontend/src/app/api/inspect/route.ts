// app/api/inspect/route.ts
// Diagnóstico: mostra as extensões (HDUs) e os headers de um recorte FITS, em JSON.
// Uso: /api/inspect?url=<access_url do frame>&ra=269.452075&dec=4.693391&size=0.24
import { NextResponse } from 'next/server';
import { acquire, release, fetchBuffer } from '../../../lib/irsa';

type Hdu = { header: Record<string, string>; dataStart: number; dataBytes: number };

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
        if (card[8] === '=') header[key] = card.slice(10).trim(); // valor + comentário, como veio
      }
      offset += 2880;
    }
    if (!ended) break;

    const clean = (k: string) => (header[k] || '').split('/')[0].trim();
    const bitpix = Math.abs(parseInt(clean('BITPIX') || '8', 10)) / 8;
    const naxis = parseInt(clean('NAXIS') || '0', 10);
    let prod = naxis > 0 ? 1 : 0;
    for (let n = 1; n <= naxis; n++) prod *= parseInt(clean(`NAXIS${n}`) || '0', 10);
    const pcount = parseInt(clean('PCOUNT') || '0', 10);
    const gcount = parseInt(clean('GCOUNT') || '1', 10);
    const dataBytes = bitpix * gcount * (pcount + prod);

    hdus.push({ header, dataStart: offset, dataBytes });
    offset += Math.ceil(dataBytes / 2880) * 2880;
  }
  return hdus;
}

export async function GET(request: Request) {
  const signal = request.signal;
  const { searchParams } = new URL(request.url);
  const base = searchParams.get('url') || '';
  const ra = searchParams.get('ra');
  const dec = searchParams.get('dec');
  const size = searchParams.get('size') || '0.24';

  if (!base.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL fora do arquivo SPHEREx' }, { status: 400 });
  }
  // Sem center o arquivo inteiro é enorme: exige ra/dec para baixar só o recorte
  if (!ra || !dec) {
    return NextResponse.json({ error: 'Passe ra e dec (e opcionalmente size) para baixar só o recorte' }, { status: 400 });
  }
  const url = `${base}?center=${ra},${dec}&size=${size}`;

  try {
    await acquire(signal);
  } catch {
    return new NextResponse(null, { status: 499 });
  }
  try {
    const buf = await fetchBuffer(url, { signal, tries: 2, timeoutMs: 60000 });
    const hdus = parseHdus(buf);
    const out = {
      url,
      bytes: buf.length,
      hdus: hdus.map((h, i) => {
        const clean = (k: string) => (h.header[k] || '').split('/')[0].trim().replace(/^'|'$/g, '').trim();
        const naxis = parseInt(clean('NAXIS') || '0', 10);
        const dims: number[] = [];
        for (let n = 1; n <= naxis; n++) dims.push(parseInt(clean(`NAXIS${n}`) || '0', 10));
        return {
          index: i,
          extname: clean('EXTNAME') || (i === 0 ? 'PRIMARY' : '(sem nome)'),
          xtension: clean('XTENSION') || undefined,
          bitpix: clean('BITPIX'),
          dims,
          header: h.header,
        };
      }),
    };
    return new NextResponse(JSON.stringify(out, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    if (signal.aborted) return new NextResponse(null, { status: 499 });
    return NextResponse.json({ error: e.message }, { status: 502 });
  } finally {
    release();
  }
}