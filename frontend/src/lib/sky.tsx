// src/lib/sky.ts
// Projeção gnomônica (TAN). Ângulos em radianos, exceto onde indicado.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

// céu (ra, dec) -> plano tangente em torno de (ra0, dec0). Retorna null se estiver do outro lado do céu.
export function skyToTangent(ra: number, dec: number, ra0: number, dec0: number) {
  const dra = ra - ra0;
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(dra);
  if (cosc <= 1e-9) return null;
  const xi = (Math.cos(dec) * Math.sin(dra)) / cosc;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(dra)) / cosc;
  return { xi, eta };
}

// plano tangente -> céu
export function tangentToSky(xi: number, eta: number, ra0: number, dec0: number) {
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: ra0, dec: dec0 };
  const c = Math.atan(rho);
  const sinc = Math.sin(c);
  const cosc = Math.cos(c);
  const dec = Math.asin(cosc * Math.sin(dec0) + (eta * sinc * Math.cos(dec0)) / rho);
  const ra = ra0 + Math.atan2(xi * sinc, rho * Math.cos(dec0) * cosc - eta * Math.sin(dec0) * sinc);
  return { ra, dec };
}

// Pixel (i = coluna, j = linha, de cima para baixo) da grade do mapa -> coordenadas tangentes em GRAUS.
// Norte para cima, leste para a esquerda. O centro da grade é o alvo.
export function gridToTangentDeg(i: number, j: number, n: number, scaleArcsec: number) {
  const c = (n - 1) / 2;
  const s = scaleArcsec / 3600;
  return { xi: -(i - c) * s, eta: (c - j) * s };
}