import { Marker, type Map as MlMap } from 'maplibre-gl';
import { bearing, destination } from './geo.js';

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface DisplayOriginParams {
  sunAnchor?: Coordinate | null;
  spotDraft?: Coordinate | null;
  selectedSpot?: Coordinate | null;
  viewportCentre: Coordinate;
}

/**
 * Resolves the display origin for the sun rays and TimeBar.
 * Precedence:
 * 1. Sun anchor
 * 2. Editing spot draft
 * 3. Selected saved spot
 * 4. Viewport centre
 */
export function resolveDisplayOrigin(params: DisplayOriginParams): Coordinate {
  if (params.sunAnchor) return params.sunAnchor;
  if (params.spotDraft) return params.spotDraft;
  if (params.selectedSpot) return params.selectedSpot;
  return params.viewportCentre;
}

export function resolveSunPlannerBearing(
  selectedSpot: Coordinate & { facingDeg: number | null },
  sunAnchor: Coordinate | null,
  sunAnchorBearing: number | null = null,
): number | null {
  if (sunAnchor && sunAnchorBearing != null) return sunAnchorBearing;
  if (sunAnchor) return bearing(selectedSpot.lat, selectedSpot.lng, sunAnchor.lat, sunAnchor.lng);
  return selectedSpot.facingDeg;
}

/** A manual sun-anchor plan is available without a saved spot. */
export function shouldShowSunPlanner(sunAnchor: Coordinate | null, selectedSpot: Coordinate | null): boolean {
  return sunAnchor !== null || selectedSpot !== null;
}

/** A visible time-control surface needs rays/wedges; a placed anchor keeps them useful when controls are compacted. */
export function shouldShowSunLayer(timeControlsVisible: boolean, sunAnchor: Coordinate | null): boolean {
  return timeControlsVisible || sunAnchor !== null;
}

/** Starts the anchor tool with its supporting rays and wedges visible. */
export function startSunAnchorTool<T extends Record<string, boolean>>(visibility: T): T & { sun: true } {
  return { ...visibility, sun: true };
}

/** Clears the transient anchor state and returns the map to normal browsing. */
export function closeSunAnchorTool(): { anchor: null; bearing: null; mode: 'browse' } {
  return { anchor: null, bearing: null, mode: 'browse' };
}

export const SELECTED_BEARING_PROJECTION_SOURCE = 'selected-bearing-projection';
const SELECTED_BEARING_PROJECTION_SCREEN_PX = 320;
const SELECTED_BEARING_PROJECTION_MIN_KM = 0.2;
const SELECTED_BEARING_PROJECTION_MAX_KM = 12;

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, { kind: 'selected-bearing' }>;

const emptyProjection = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function selectedBearingProjectionGeoJSON(
  anchor: Coordinate | null,
  bearingDeg: number | null,
  lengthKm: number,
): FeatureCollection {
  if (!anchor || bearingDeg == null || !Number.isFinite(bearingDeg) || !Number.isFinite(lengthKm) || lengthKm <= 0) {
    return emptyProjection();
  }

  const end = destination(anchor.lat, anchor.lng, normalizeAnchorBearing(bearingDeg), lengthKm);
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'selected-bearing' },
      geometry: { type: 'LineString', coordinates: [[anchor.lng, anchor.lat], end] },
    }],
  };
}

export interface SelectedBearingProjectionMap {
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  getSource(id: string): unknown;
}

function selectedBearingProjectionLengthKm(map: Pick<SelectedBearingProjectionMap, 'getCenter' | 'getZoom'>): number {
  const metresPerPixel = (156_543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const km = (metresPerPixel * SELECTED_BEARING_PROJECTION_SCREEN_PX) / 1000;
  return Math.min(SELECTED_BEARING_PROJECTION_MAX_KM, Math.max(SELECTED_BEARING_PROJECTION_MIN_KM, km));
}

export function updateSelectedBearingProjection(
  map: SelectedBearingProjectionMap,
  anchor: Coordinate | null,
  bearingDeg: number | null,
): void {
  const source = map.getSource(SELECTED_BEARING_PROJECTION_SOURCE);
  if (!source || typeof (source as { setData?: unknown }).setData !== 'function') return;
  (source as { setData(data: FeatureCollection): void }).setData(
    selectedBearingProjectionGeoJSON(anchor, bearingDeg, selectedBearingProjectionLengthKm(map)),
  );
}

export interface ScreenPixel {
  x: number;
  y: number;
}

export interface MapProjectionAdapter {
  project(coord: Coordinate): ScreenPixel;
  unproject(pixel: ScreenPixel): Coordinate;
}

export const SUN_ANCHOR_STEP_PX = 1;
export const SUN_ANCHOR_SHIFT_STEP_PX = 10;
export const SUN_ANCHOR_BEARING_STEP_DEG = 1;
export const SUN_ANCHOR_BEARING_SHIFT_STEP_DEG = 10;

export function normalizeAnchorBearing(bearingDeg: number): number {
  if (!Number.isFinite(bearingDeg)) return 0;
  const wrapped = ((bearingDeg % 360) + 360) % 360;
  const rounded = Math.round(wrapped * 10) / 10;
  return rounded >= 360 ? 359.9 : rounded;
}

export function pointToBearing(center: ScreenPixel, point: ScreenPixel): number {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return normalizeAnchorBearing((Math.atan2(dx, -dy) * 180) / Math.PI);
}

export function createMapProjectionAdapter(map: MlMap): MapProjectionAdapter {
  return {
    project(coord: Coordinate): ScreenPixel {
      const pt = map.project([coord.lng, coord.lat]);
      return { x: pt.x, y: pt.y };
    },
    unproject(pixel: ScreenPixel): Coordinate {
      const ll = map.unproject([pixel.x, pixel.y]);
      return { lat: ll.lat, lng: ll.lng };
    },
  };
}

const ARROW_OFFSETS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

/**
 * Pure helper to nudge a coordinate using keyboard arrow keys.
 * Uses injected projection adapter to convert coordinate to screen pixels,
 * applies 1px (or 10px with Shift) in screen space, and unprojects back to coordinates.
 * Invalid or non-arrow keys leave the coordinate unchanged.
 */
export function nudgeAnchor(
  current: Coordinate,
  key: string,
  projection: MapProjectionAdapter,
  options?: { shiftKey?: boolean; stepPx?: number } | boolean,
): Coordinate {
  const offset = ARROW_OFFSETS[key];
  if (!offset) {
    return current;
  }

  const shiftKey = typeof options === 'boolean' ? options : options?.shiftKey ?? false;
  const stepPx = typeof options === 'object' && options?.stepPx != null
    ? options.stepPx
    : shiftKey
    ? SUN_ANCHOR_SHIFT_STEP_PX
    : SUN_ANCHOR_STEP_PX;

  const pixel = projection.project(current);
  const nextPixel: ScreenPixel = {
    x: pixel.x + offset.dx * stepPx,
    y: pixel.y + offset.dy * stepPx,
  };

  return projection.unproject(nextPixel);
}

/**
 * Placement click handler: consumes click if currently in anchor placement mode,
 * returns the coordinate for the new anchor and transitions mode back to 'browse'.
 */
export function handleSunAnchorPlacementClick(
  mode: string,
  coord: Coordinate,
): { consumed: boolean; newAnchor?: Coordinate; nextMode?: 'browse' } {
  if (mode === 'anchor') {
    return { consumed: true, newAnchor: coord, nextMode: 'browse' };
  }
  return { consumed: false };
}

export interface EventTargetLike {
  addEventListener(event: string, handler: (e: any) => void): void;
  removeEventListener(event: string, handler: (e: any) => void): void;
  setAttribute?(name: string, value: string): void;
}

/**
 * Attaches keyboard listeners to the anchor DOM element for arrow-key nudging.
 * Prevents default and stops propagation so the MapLibre map does not pan.
 */
export function attachKeyboardNudge(
  target: EventTargetLike,
  getCoord: () => Coordinate,
  onMove: (coord: Coordinate) => void,
  projection: MapProjectionAdapter | (() => MapProjectionAdapter),
): () => void {
  const onKeyDown = (e: {
    key: string;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const current = getCoord();
      const proj = typeof projection === 'function' ? projection() : projection;
      const next = nudgeAnchor(current, e.key, proj, e.shiftKey ?? false);
      onMove(next);
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}

function updateRotationAria(target: EventTargetLike, bearingDeg: number): void {
  const bearing = normalizeAnchorBearing(bearingDeg);
  target.setAttribute?.('aria-valuenow', String(bearing));
  target.setAttribute?.('aria-valuetext', `${bearing.toFixed(1)} degrees`);
}

export function attachRotationHandle(
  target: EventTargetLike & {
    setPointerCapture?(pointerId: number): void;
    releasePointerCapture?(pointerId: number): void;
  },
  getCenterPixel: () => ScreenPixel,
  onBearingChange: (bearingDeg: number) => void,
  getBearing: () => number = () => 0,
): () => void {
  let pointerId: number | null = null;

  const setBearing = (bearingDeg: number) => {
    const next = normalizeAnchorBearing(bearingDeg);
    onBearingChange(next);
    updateRotationAria(target, next);
  };

  const bearingFromPointer = (e: { clientX: number; clientY: number }) => {
    setBearing(pointToBearing(getCenterPixel(), { x: e.clientX, y: e.clientY }));
  };

  const onPointerDown = (e: {
    button?: number;
    pointerId?: number;
    clientX: number;
    clientY: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId ?? 1;
    target.setPointerCapture?.(pointerId);
    bearingFromPointer(e);
  };

  const onPointerMove = (e: {
    pointerId?: number;
    clientX: number;
    clientY: number;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    if (pointerId == null || (e.pointerId != null && e.pointerId !== pointerId)) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    bearingFromPointer(e);
  };

  const finishPointer = (e: { pointerId?: number }) => {
    if (pointerId == null || (e.pointerId != null && e.pointerId !== pointerId)) return;
    target.releasePointerCapture?.(pointerId);
    pointerId = null;
  };

  const onKeyDown = (e: {
    key: string;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? SUN_ANCHOR_BEARING_SHIFT_STEP_DEG : SUN_ANCHOR_BEARING_STEP_DEG;
    setBearing(getBearing() + (e.key === 'ArrowRight' ? step : -step));
  };

  const pointerEvents = globalThis.window;
  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('keydown', onKeyDown);
  pointerEvents?.addEventListener('pointermove', onPointerMove);
  pointerEvents?.addEventListener('pointerup', finishPointer);
  pointerEvents?.addEventListener('pointercancel', finishPointer);
  updateRotationAria(target, getBearing());

  return () => {
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('keydown', onKeyDown);
    pointerEvents?.removeEventListener('pointermove', onPointerMove);
    pointerEvents?.removeEventListener('pointerup', finishPointer);
    pointerEvents?.removeEventListener('pointercancel', finishPointer);
  };
}

export interface SunAnchorMarkerHandle {
  setLngLat(coord: Coordinate): void;
  setBearing?(bearingDeg: number): void;
  remove(): void;
  getElement?(): HTMLElement;
}

export interface SunAnchorMarkerAdapter {
  create(options: {
    map: MlMap;
    coord: Coordinate;
    onMove: (coord: Coordinate) => void;
    bearingDeg?: number | null;
    onBearingChange?: (bearingDeg: number) => void;
    projection?: MapProjectionAdapter;
  }): SunAnchorMarkerHandle;
}

export function createSunAnchorElement(bearingDeg = 0): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sun-anchor-crosshair';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', 'Sun anchor crosshair');
  el.setAttribute('aria-description', 'Use arrow keys to nudge position (hold Shift for 10px), or drag to move.');
  el.title = 'Sun anchor crosshair (drag or use arrow keys to move, Shift for 10px)';
  const icon = document.createElement('div');
  icon.className = 'sun-anchor-crosshair__iconwrap';
  icon.innerHTML = `
    <svg class="sun-anchor-crosshair__icon" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
      <circle class="sun-anchor-crosshair__ring" cx="16" cy="16" r="9" />
      <circle class="sun-anchor-crosshair__dot" cx="16" cy="16" r="2.5" />
      <line class="sun-anchor-crosshair__line" x1="16" y1="2" x2="16" y2="7" />
      <line class="sun-anchor-crosshair__line" x1="16" y1="25" x2="16" y2="30" />
      <line class="sun-anchor-crosshair__line" x1="2" y1="16" x2="7" y2="16" />
      <line class="sun-anchor-crosshair__line" x1="25" y1="16" x2="30" y2="16" />
    </svg>
  `;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'sun-anchor-bearing';
  handle.setAttribute('aria-label', 'Sun anchor bearing');
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '359.9');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.title = 'Sun anchor bearing (drag, or use Left/Right; Shift for 10 degrees)';
  handle.innerHTML = '<span class="sun-anchor-bearing__needle" aria-hidden="true"></span>';
  updateRotationAria(handle, bearingDeg);
  el.append(icon, handle);
  return el;
}

export const defaultSunAnchorAdapter: SunAnchorMarkerAdapter = {
  create({ map, coord, onMove, bearingDeg = 0, onBearingChange, projection }) {
    const el = createSunAnchorElement(bearingDeg ?? 0);
    const bearingHandle = el.querySelector<HTMLElement>('.sun-anchor-bearing');
    const marker = new Marker({ element: el, draggable: true })
      .setLngLat([coord.lng, coord.lat])
      .addTo(map);

    let isDragging = false;
    const currentCoord = { lat: coord.lat, lng: coord.lng };

    const onDragStart = () => {
      isDragging = true;
    };
    const onDrag = () => {
      const ll = marker.getLngLat();
      currentCoord.lat = ll.lat;
      currentCoord.lng = ll.lng;
      onMove({ lat: ll.lat, lng: ll.lng });
    };
    const onDragEnd = () => {
      isDragging = false;
    };

    marker.on('dragstart', onDragStart);
    marker.on('drag', onDrag);
    marker.on('dragend', onDragEnd);

    const proj = projection ?? createMapProjectionAdapter(map);

    const detachKeyboard = attachKeyboardNudge(
      el,
      () => currentCoord,
      (next) => {
        currentCoord.lat = next.lat;
        currentCoord.lng = next.lng;
        marker.setLngLat([next.lng, next.lat]);
        onMove(next);
      },
      proj,
    );

    let currentBearing = normalizeAnchorBearing(bearingDeg ?? 0);
    const setBearing = (nextBearing: number) => {
      currentBearing = normalizeAnchorBearing(nextBearing);
      if (bearingHandle) {
        bearingHandle.style.setProperty('--sun-anchor-bearing', `${currentBearing}deg`);
        updateRotationAria(bearingHandle, currentBearing);
      }
    };
    setBearing(currentBearing);

    const detachRotation = bearingHandle
      ? attachRotationHandle(
        bearingHandle,
        () => {
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        },
        (nextBearing) => {
          setBearing(nextBearing);
          onBearingChange?.(nextBearing);
        },
        () => currentBearing,
      )
      : () => {};

    return {
      setLngLat(next: Coordinate) {
        currentCoord.lat = next.lat;
        currentCoord.lng = next.lng;
        if (!isDragging) {
          marker.setLngLat([next.lng, next.lat]);
        }
      },
      setBearing,
      remove() {
        detachKeyboard();
        detachRotation();
        marker.off('dragstart', onDragStart);
        marker.off('drag', onDrag);
        marker.off('dragend', onDragEnd);
        marker.remove();
      },
      getElement() {
        return el;
      },
    };
  },
};

/**
 * Controller to manage the lifecycle of the sun anchor marker on the map.
 * Reuses the adapter pattern to enable isolated unit testing without a live map.
 */
export class SunAnchorController {
  private handle: SunAnchorMarkerHandle | null = null;
  private adapter: SunAnchorMarkerAdapter;

  constructor(adapter: SunAnchorMarkerAdapter = defaultSunAnchorAdapter) {
    this.adapter = adapter;
  }

  sync(
    map: MlMap | null,
    anchor: Coordinate | null,
    onMove: (coord: Coordinate) => void,
    projection?: MapProjectionAdapter,
    bearingDeg?: number | null,
    onBearingChange?: (bearingDeg: number) => void,
  ): void {
    if (!map || !anchor) {
      this.destroy();
      return;
    }
    if (!this.handle) {
      this.handle = this.adapter.create({ map, coord: anchor, onMove, projection, bearingDeg, onBearingChange });
    } else {
      this.handle.setLngLat(anchor);
      this.handle.setBearing?.(bearingDeg ?? 0);
    }
  }

  destroy(): void {
    if (this.handle) {
      this.handle.remove();
      this.handle = null;
    }
  }

  getHandle(): SunAnchorMarkerHandle | null {
    return this.handle;
  }
}
