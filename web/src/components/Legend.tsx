import { useMemo, useState, type ReactNode } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { CATEGORIES, swatchColor, type Category, type LegendLayer, type Visibility } from '../map/legend.js';

/** How a category looks on the map; shared by legend rows and the map chips. */
export function Swatch({ cat, color = cat.color }: { cat: Category; color?: string }) {
  const style = { '--sw': color } as React.CSSProperties;
  if (cat.swatch === 'glyph') return <span className="legend__swatch legend__swatch--glyph" style={style} aria-hidden>{cat.glyph}</span>;
  if (cat.swatch === 'camera') return ( // the map's camera icon (layers.ts cameraIcon), in miniature
    <svg className="legend__swatch legend__swatch--camera" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r="21" fill="#0e1014" /><rect x="9" y="15" width="26" height="17" rx="3" fill={color} /><rect x="16" y="11" width="10" height="5" fill={color} />
      <circle cx="22" cy="23.5" r="5.5" fill="#0e1014" /><circle cx="22" cy="23.5" r="3" fill={color} />
    </svg>
  );
  return <span className={`legend__swatch legend__swatch--${cat.swatch}`} style={style} aria-hidden />;
}

/** Collapsible map legend: one row per layer category, with a swatch and a visibility checkbox. */
export function Legend({ map, vis, onToggle, extra = [], control }: { map: MlMap | null; vis: Visibility; onToggle: (key: string, on: boolean) => void; extra?: readonly Category[]; control?: ReactNode }) {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 820);
  const layers = useMemo(() => (map?.getStyle().layers ?? []) as LegendLayer[], [map]);
  const groups = ['Base map', 'Overlays'] as const;
  return (
    <div className={`legend${open ? ' legend--open' : ''}`}>
      <div className="legend__controls">
        <button className={`chip${open ? ' active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>Legend</button>
        {control}
      </div>
      {open && (
        <div className="legend__panel">
          {groups.map((g) => (
            <div key={g}>
              <h4>{g}</h4>
              {[...CATEGORIES, ...extra].filter((c) => c.group === g).map((c) => (
                <label key={c.key} className="legend__row">
                  <Swatch cat={c} color={swatchColor(c, layers)} />
                  <span className="grow">{c.label}</span>
                  <input type="checkbox" checked={!!vis[c.key]} onChange={(e) => onToggle(c.key, e.target.checked)} />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
