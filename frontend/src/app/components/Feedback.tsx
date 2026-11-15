// src/app/components/Feedback.tsx
'use client';

import { useEffect, useState } from 'react';

// Renderize uma vez, na raiz da tela
export function FeedbackStyles() {
  return (
    <style>{`
@keyframes sx-ping { 0% { transform: scale(.35); opacity: .75 } 100% { transform: scale(1.6); opacity: 0 } }
@keyframes sx-sweep { from { transform: translateX(-100%) } to { transform: translateX(250%) } }
@keyframes sx-fade { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: scale(1) } }
.sx-ping { animation: sx-ping 2s ease-out infinite }
.sx-sweep { animation: sx-sweep 1.4s ease-in-out infinite }
.sx-fade { animation: sx-fade .35s ease-out both }
@media (prefers-reduced-motion: reduce) { .sx-ping, .sx-sweep, .sx-fade { animation: none } }
`}</style>
  );
}

// Segundos desde que "on" ficou true
export function useElapsed(on: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!on) { setS(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [on]);
  return s;
}

export function fmtEta(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'poucos segundos';
  if (s < 90) return `~${s} s`;
  return `~${Math.round(s / 60)} min`;
}

// Ondas que se expandem: "estou procurando"
export function Radar({ size = 56 }: { size?: number }) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
      {[0, 0.66, 1.33].map((d) => (
        <span key={d} className="sx-ping absolute inset-0 rounded-full border border-blue-400" style={{ animationDelay: `${d}s` }} />
      ))}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full bg-blue-400" />
    </div>
  );
}

// Barra de progresso (value 0..1) ou indeterminada
export function Bar({ value = 0, indeterminate = false }: { value?: number; indeterminate?: boolean }) {
  return (
    <div className="relative h-1.5 w-full bg-gray-800 rounded overflow-hidden">
      {indeterminate ? (
        <div className="sx-sweep absolute inset-y-0 w-2/5 bg-blue-500 rounded" />
      ) : (
        <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      )}
    </div>
  );
}

// Espaço reservado com brilho passando (miniatura ainda não chegou)
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden bg-gray-900 ${className}`}>
      <div
        className="sx-sweep absolute inset-y-0 w-1/2"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent)' }}
      />
    </div>
  );
}

export function Steps({ items }: { items: { label: string; state: 'done' | 'active' | 'todo' }[] }) {
  return (
    <ol className="flex flex-col gap-1.5 text-xs text-left">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-2">
          <span className="w-4 flex justify-center">
            {it.state === 'done' ? (
              <span className="text-green-400">✓</span>
            ) : it.state === 'active' ? (
              <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin" />
            ) : (
              <span className="text-gray-600">•</span>
            )}
          </span>
          <span className={it.state === 'todo' ? 'text-gray-600' : it.state === 'done' ? 'text-gray-400' : 'text-gray-200'}>{it.label}</span>
        </li>
      ))}
    </ol>
  );
}