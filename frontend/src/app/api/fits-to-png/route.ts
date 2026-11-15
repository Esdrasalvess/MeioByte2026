// app/api/fits-to-png/route.ts
import { NextResponse } from 'next/server';
import { PNG } from 'pngjs';
import { acquire, release, fetchBuffer } from '../../../lib/irsa';

type Hdu = { header: Record<string, string>; dataStart: number };

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

export async function GET(request: Request) {
  const signal = request.signal; // aborta quando o navegador cancela
  const { searchParams } = new URL(request.url);
  const fitsUrl = searchParams.get('url');
  if (!fitsUrl) return NextResponse.json({ error: 'URL não fornecida' }, { status: 400 });
  if (!fitsUrl.startsWith('https://irsa.ipac.caltech.edu/ibe/data/spherex/')) {
    return NextResponse.json({ error: 'URL fora do arquivo SPHEREx' }, { status: 400 });
  }

  try {
    await acquire(signal);
  } catch {
    return new NextResponse(null, { status: 499 }); // cancelado na fila
  }

  try {
    const buffer = await fetchBuffer(fitsUrl, { signal, tries: 2, timeoutMs: 45000 });

    const hdus = parseHdus(buffer);
    const img =
      hdus.find((h) => h.header['EXTNAME'] === 'IMAGE' && h.header['NAXIS'] === '2') ||
      hdus.find((h) => h.header['NAXIS'] === '2');
    if (!img) throw new Error('Nenhuma extensão de imagem 2D encontrada');

    const width = parseInt(img.header['NAXIS1'], 10);
    const height = parseInt(img.header['NAXIS2'], 10);
    const bitpix = parseInt(img.header['BITPIX'], 10);
    if (bitpix !== -32) throw new Error(`BITPIX ${bitpix} não suportado`);

    // Lê os pixels (float32 big-endian)
    const values = new Float32Array(width * height);
    const finite: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = buffer.readFloatBE(img.dataStart + i * 4);
      values[i] = v;
      if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) throw new Error('Cutout sem pixels válidos');

    // Stretch por percentis (ignora NaN e outliers)
    finite.sort((a, b) => a - b);
    const lo = finite[Math.floor(finite.length * 0.02)];
    const hi = finite[Math.floor(finite.length * 0.995)];
    const range = hi - lo || 1;

    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = values[y * width + x];
        const t = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) / range)) : 0;
        const c = Math.floor(Math.sqrt(t) * 255);
        const row = height - 1 - y; // FITS tem origem embaixo
        const idx = (row * width + x) * 4;
        png.data[idx] = c;
        png.data[idx + 1] = c;
        png.data[idx + 2] = c;
        png.data[idx + 3] = 255;
      }
    }

    return new NextResponse(new Uint8Array(PNG.sync.write(png)), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    });
  } catch (error: any) {
    if (signal.aborted) return new NextResponse(null, { status: 499 });
    console.error('Erro ao processar cutout:', error.message);
    return NextResponse.json({ error: error.message }, { status: error.status === 422 ? 422 : 502 });
  } finally {
    release();
  }
}