import { Marker, type Map as MlMap } from 'maplibre-gl';
import type { OpenConvoySummary, OpenCruiseUser, Position } from './types.js';
import { haversineKm } from '../map/geo.js';

export interface OpenCruiseLayerOptions {
  myId?: string | null;
  myPosition?: Position | null;
  onSelectConvoy?: (convoy: OpenConvoySummary) => void;
  onSelectUser?: (user: OpenCruiseUser) => void;
}

export interface OpenCruiseLayer {
  update(users: OpenCruiseUser[], convoys: OpenConvoySummary[], opts?: OpenCruiseLayerOptions): void;
  remove(): void;
}

function createUserPinElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'open-cruise-pin';
  const pulse = document.createElement('span');
  pulse.className = 'open-cruise-pin__pulse';
  const dot = document.createElement('span');
  dot.className = 'open-cruise-pin__dot';
  const label = document.createElement('span');
  label.className = 'open-cruise-pin__label';
  el.append(pulse, dot, label);
  return el;
}

function createConvoyMarkerElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'open-convoy-marker';
  const badge = document.createElement('span');
  badge.className = 'open-convoy-marker__badge';
  const icon = document.createElement('span');
  icon.className = 'open-convoy-marker__icon';
  icon.textContent = '🚙';
  const count = document.createElement('span');
  count.className = 'open-convoy-marker__count';
  badge.append(icon, count);
  const label = document.createElement('span');
  label.className = 'open-convoy-marker__label';
  el.append(badge, label);
  return el;
}

export function attachOpenCruiseLayer(
  map: MlMap,
  initialUsers: OpenCruiseUser[] = [],
  initialConvoys: OpenConvoySummary[] = [],
  opts: OpenCruiseLayerOptions = {},
): OpenCruiseLayer {
  const userMarkers = new Map<string, Marker>();
  const convoyMarkers = new Map<string, Marker>();
  let currentOpts = opts;
  let disposed = false;

  function update(users: OpenCruiseUser[], convoys: OpenConvoySummary[], nextOpts: OpenCruiseLayerOptions = currentOpts): void {
    if (disposed) return;
    currentOpts = nextOpts;

    // 1. Update Solo Open Cruise Users
    // Filter out ourselves and users with no position
    const validUsers = users.filter((u) => u.id !== currentOpts.myId && u.position !== null);
    const aliveUserIds = new Set(validUsers.map((u) => u.id));
    for (const [id, marker] of userMarkers) {
      if (!aliveUserIds.has(id)) {
        marker.remove();
        userMarkers.delete(id);
      }
    }

    for (const u of validUsers) {
      const pos = u.position!;
      let isNearby = false;
      if (currentOpts.myPosition) {
        const distM = haversineKm(currentOpts.myPosition.lat, currentOpts.myPosition.lng, pos.lat, pos.lng) * 1000;
        isNearby = distM <= 500;
      }

      let marker = userMarkers.get(u.id);
      if (!marker) {
        const el = createUserPinElement();
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          currentOpts.onSelectUser?.(u);
        });
        marker = new Marker({ element: el, rotationAlignment: 'viewport' })
          .setLngLat([pos.lng, pos.lat])
          .addTo(map);
        userMarkers.set(u.id, marker);
      } else {
        marker.setLngLat([pos.lng, pos.lat]);
      }

      const el = marker.getElement();
      el.classList.toggle('is-nearby', isNearby);
      const label = el.querySelector<HTMLElement>('.open-cruise-pin__label');
      if (label && label.textContent !== u.username) label.textContent = u.username;
      el.title = `${u.username} · Open Cruise${isNearby ? ' (within 500m!)' : ''}`;
    }

    // 2. Update Open Convoys
    const validConvoys = convoys.filter((c) => c.centroid !== null);
    const aliveConvoyCodes = new Set(validConvoys.map((c) => c.code));
    for (const [code, marker] of convoyMarkers) {
      if (!aliveConvoyCodes.has(code)) {
        marker.remove();
        convoyMarkers.delete(code);
      }
    }

    for (const c of validConvoys) {
      const centroid = c.centroid!;
      let marker = convoyMarkers.get(c.code);
      if (!marker) {
        const el = createConvoyMarkerElement();
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          currentOpts.onSelectConvoy?.(c);
        });
        marker = new Marker({ element: el, rotationAlignment: 'viewport' })
          .setLngLat([centroid.lng, centroid.lat])
          .addTo(map);
        convoyMarkers.set(c.code, marker);
      } else {
        marker.setLngLat([centroid.lng, centroid.lat]);
      }

      const el = marker.getElement();
      const countEl = el.querySelector<HTMLElement>('.open-convoy-marker__count');
      if (countEl) countEl.textContent = String(c.members.length);
      const labelEl = el.querySelector<HTMLElement>('.open-convoy-marker__label');
      if (labelEl && labelEl.textContent !== c.name) labelEl.textContent = c.name;
      el.title = `${c.name} (${c.members.length} drivers) · Click to view details and join`;
    }
  }

  update(initialUsers, initialConvoys, opts);

  return {
    update,
    remove() {
      disposed = true;
      for (const marker of userMarkers.values()) marker.remove();
      userMarkers.clear();
      for (const marker of convoyMarkers.values()) marker.remove();
      convoyMarkers.clear();
    },
  };
}
