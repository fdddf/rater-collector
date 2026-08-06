import { useLayoutEffect, useRef, useState } from 'react';

export interface DayPoint {
  day: string;
  n: number;
}

const H = 208;
const PAD = { top: 10, right: 4, bottom: 22, left: 34 };
const MAX_BAR = 24; // house spec: bars never fill their band — the leftover is air
const GAP = 2; // the surface gap that separates adjacent bars

/** Rounds the axis top up to 1/2/5 × 10ⁿ so ticks land on readable numbers. */
function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, value);
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * mag) return step * mag;
  }
  return 10 * mag;
}

/** A column whose top corners are rounded and whose baseline stays square. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return (
    `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
    `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
  );
}

/**
 * Feedback volume per day — one series, so no legend: the section heading names it.
 * Hover is the value channel; the axis carries the rest, so no per-column labels.
 */
export default function DailyChart({ data }: { data: DayPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const top = niceMax(Math.max(...data.map((d) => d.n), 1));
  const band = plotW / data.length;
  const barW = Math.max(1, Math.min(MAX_BAR, band - GAP));
  const ticks = [0, top / 2, top];

  const x = (i: number) => PAD.left + band * i + (band - barW) / 2;
  const y = (n: number) => PAD.top + plotH - (n / top) * plotH;

  const active = hover === null ? null : data[hover];

  return (
    <div ref={wrap} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Feedback per day, ${data.length} days, peak ${Math.max(...data.map((d) => d.n))}`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Gridlines and ticks sit behind the data and stay recessive. */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--ink-3)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {Math.round(t)}
            </text>
          </g>
        ))}

        {data.map((d, i) => (
          <path
            key={d.day}
            d={columnPath(x(i), y(d.n), barW, Math.max(d.n > 0 ? 2 : 0, plotH - (y(d.n) - PAD.top)))}
            fill="var(--series)"
            opacity={hover === null || hover === i ? 1 : 0.4}
            style={{ transition: 'opacity .12s' }}
          />
        ))}

        {/* Hit targets are the full band, so thin columns are still easy to hover. */}
        {data.map((d, i) => (
          <rect
            key={d.day}
            x={PAD.left + band * i}
            y={PAD.top}
            width={band}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="var(--ink-3)"
          strokeWidth={1}
          shapeRendering="crispEdges"
        />

        {data.length > 0 && (
          <>
            <text x={PAD.left} y={H - 6} fontSize={11} fill="var(--ink-3)">
              {data[0].day}
            </text>
            <text x={PAD.left + plotW} y={H - 6} textAnchor="end" fontSize={11} fill="var(--ink-3)">
              {data[data.length - 1].day}
            </text>
          </>
        )}
      </svg>

      {active && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-page shadow-lg"
          style={{
            left: Math.min(Math.max(PAD.left + band * (hover + 0.5), 48), width - 48),
            top: Math.max(y(active.n) - 40, 0),
          }}
        >
          <span className="tnum">{active.n}</span> on {active.day}
        </div>
      )}
    </div>
  );
}
