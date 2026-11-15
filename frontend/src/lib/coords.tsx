// src/lib/coords.ts
// Converte texto em RA/Dec (graus decimais). Aceita:
//   "269.452075 4.693391"            (graus)
//   "269,452075 4,693391"            (vírgula decimal)
//   "08h55m10.831s -07d14m42.53s"    (horas e graus sexagesimais)
//   "08 55 10.831 -07 14 42.53"      "08:55:10.831 -07:14:42.53"
export type Coords = { ra: number; dec: number };

const num = (s: string) => (/^[+-]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN);

export function parseCoords(input: string): Coords | null {
  let s = input.trim();
  if (!s) return null;
  if (/^[+-]?\d+,\d+\s+[+-]?\d+,\d+$/.test(s)) s = s.replace(/,/g, '.');

  const hasH = /h/i.test(s);
  const t = s.replace(/[hdms°′″'":,;]/gi, ' ').replace(/\s+/g, ' ').trim();
  const parts = t.split(' ');
  if (parts.some((p) => !Number.isFinite(num(p)))) return null;

  let ra: number;
  let dec: number;
  if (parts.length === 2) {
    ra = num(parts[0]);
    dec = num(parts[1]);
    if (hasH) ra *= 15; // "8.9197h" = horas
  } else if (parts.length === 4 || parts.length === 6) {
    const half = parts.length / 2;
    const r = parts.slice(0, half).map(num);
    const dp = parts.slice(half);
    const sign = dp[0].startsWith('-') ? -1 : 1; // cobre "-00 30 00"
    const d = dp.map(num).map(Math.abs);
    ra = (r[0] + (r[1] || 0) / 60 + (r[2] || 0) / 3600) * 15;
    dec = sign * (d[0] + (d[1] || 0) / 60 + (d[2] || 0) / 3600);
  } else {
    return null;
  }

  ra = ((ra % 360) + 360) % 360;
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  return { ra, dec };
}