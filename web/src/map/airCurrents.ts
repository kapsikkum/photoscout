/**
 * Air currents and rainfall visualization overlay.
 * Renders smooth fluid streamlines for wind flow and dynamic rain streaks for precipitation
 * on a 2D canvas synced seamlessly across the entire MapLibre map viewport.
 * Supports multi-point wind grid sampling across the entire landscape.
 * Camera motion (pan, zoom, tilt) is fully decoupled so streaks only ever reflect wind velocity.
 */
import type { Map as MlMap } from 'maplibre-gl';
import type { WindGridPoint, WindGridResponse } from '../api.js';

export interface WeatherVisualState {
  windKmh: number | null;
  windDeg: number | null;
  gustKmh: number | null;
  precipMm: number | null;
  windGrid?: WindGridResponse | null;
  visible: boolean;
}

interface Particle {
  lng: number;
  lat: number;
  age: number;
  maxAge: number;
  speedMult: number;
  phase: number;
}


export class AirCurrentsOverlay {
  private map: MlMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private animId: number | null = null;
  private lastTime = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private state: WeatherVisualState = {
    windKmh: null,
    windDeg: null,
    gustKmh: null,
    precipMm: null,
    windGrid: null,
    visible: false,
  };

  private particles: Particle[] = [];

  constructor(map: MlMap) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'air-currents-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '3';
    this.canvas.style.opacity = '0.92';
    this.canvas.style.mixBlendMode = 'screen';

    this.ctx = this.canvas.getContext('2d');

    const container = map.getContainer();
    container.appendChild(this.canvas);

    this.onResize = this.onResize.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    this.onCameraMove = this.onCameraMove.bind(this);
    this.loop = this.loop.bind(this);

    this.map.on('resize', this.onResize);
    this.map.on('movestart', this.onCameraMove);
    this.map.on('zoomstart', this.onCameraMove);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.syncSize();
    this.initParticles();
  }

  private onCameraMove() {
    if (this.ctx && this.width > 0 && this.height > 0) {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  private syncSize(): boolean {
    const container = this.map.getContainer();
    const mapCanvas = this.map.getCanvas();
    const w = mapCanvas?.clientWidth || container?.clientWidth || window.innerWidth || 1200;
    const h = mapCanvas?.clientHeight || container?.clientHeight || window.innerHeight || 800;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    if (w !== this.width || h !== this.height || dpr !== this.dpr || this.canvas.width !== Math.floor(w * dpr)) {
      this.width = w;
      this.height = h;
      this.dpr = dpr;

      this.canvas.width = Math.max(1, Math.floor(w * dpr));
      this.canvas.height = Math.max(1, Math.floor(h * dpr));
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';

      if (this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
      }

      this.initParticles();
      return true;
    }
    return false;
  }

  private initParticles() {
    if (this.width <= 0 || this.height <= 0) return;

    // Scale particle count to cover the entire viewport
    const targetParticleCount = Math.min(550, Math.max(220, Math.floor((this.width * this.height) / 6000)));

    const bounds = this.map.getBounds();
    const west = bounds ? bounds.getWest() : 149;
    const east = bounds ? bounds.getEast() : 151;
    const south = bounds ? bounds.getSouth() : -34;
    const north = bounds ? bounds.getNorth() : -32;

    this.particles = [];
    for (let i = 0; i < targetParticleCount; i++) {
      const lng = west + Math.random() * (east - west);
      const lat = south + Math.random() * (north - south);
      this.particles.push({
        lng,
        lat,
        age: Math.floor(Math.random() * 90),
        maxAge: 70 + Math.floor(Math.random() * 90),
        speedMult: 0.75 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
    }


  }

  public update(state: Partial<WeatherVisualState>) {
    const wasVisible = this.state.visible;
    Object.assign(this.state, state);

    if (this.state.visible && !wasVisible) {
      this.start();
    } else if (!this.state.visible && wasVisible) {
      this.stop();
    }
  }

  private onResize() {
    this.syncSize();
  }

  private onVisibilityChange() {
    if (document.hidden) {
      this.stop();
    } else if (this.state.visible) {
      this.start();
    }
  }

  public start() {
    if (this.animId != null) return;
    this.syncSize();
    this.lastTime = performance.now();
    this.animId = requestAnimationFrame(this.loop);
  }

  public stop() {
    if (this.animId != null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.ctx && this.width > 0 && this.height > 0) {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  private getParticleColor(speedKmh: number, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    if (speedKmh < 15) {
      // Light breeze - soft luminous sky blue
      return `rgba(125, 211, 252, ${a * 0.75})`;
    }
    if (speedKmh < 35) {
      // Moderate wind - vibrant electric cyan
      return `rgba(56, 189, 248, ${a * 0.85})`;
    }
    if (speedKmh < 55) {
      // Fresh / strong breeze - golden amber
      return `rgba(251, 191, 36, ${a * 0.9})`;
    }
    // High wind / gale - energetic coral red
    return `rgba(244, 63, 94, ${a * 0.95})`;
  }

  /**
   * Sample wind velocity (u, v) and speed at any geographic coordinate,
   * bilinearly interpolating from the multi-point wind grid if available.
   */
  private sampleWindAt(
    lng: number,
    lat: number,
    fallbackSpeed: number,
    fallbackDeg: number
  ): { u: number; v: number; speedKmh: number } {
    const g = this.state.windGrid;
    if (!g || !g.grid || g.grid.length < 4) {
      const headingRad = ((fallbackDeg + 180) % 360) * (Math.PI / 180);
      return {
        u: fallbackSpeed * Math.sin(headingRad),
        v: fallbackSpeed * Math.cos(headingRad),
        speedKmh: fallbackSpeed,
      };
    }

    const { south, north, west, east } = g.bounds;
    const cols = g.cols;
    const rows = g.rows;

    const xFrac = Math.max(0, Math.min(1, (lng - west) / (east - west || 1)));
    const yFrac = Math.max(0, Math.min(1, (lat - south) / (north - south || 1)));

    const gx = xFrac * (cols - 1);
    const gy = yFrac * (rows - 1);

    const c0 = Math.floor(gx);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r0 = Math.floor(gy);
    const r1 = Math.min(rows - 1, r0 + 1);

    const tx = gx - c0;
    const ty = gy - r0;

    const p00 = g.grid[r0 * cols + c0];
    const p10 = g.grid[r0 * cols + c1];
    const p01 = g.grid[r1 * cols + c0];
    const p11 = g.grid[r1 * cols + c1];

    if (!p00 || !p10 || !p01 || !p11) {
      const headingRad = ((fallbackDeg + 180) % 360) * (Math.PI / 180);
      return {
        u: fallbackSpeed * Math.sin(headingRad),
        v: fallbackSpeed * Math.cos(headingRad),
        speedKmh: fallbackSpeed,
      };
    }

    const toVec = (pt: WindGridPoint) => {
      const rad = ((pt.windDeg + 180) % 360) * (Math.PI / 180);
      return { u: pt.windKmh * Math.sin(rad), v: pt.windKmh * Math.cos(rad) };
    };

    const v00 = toVec(p00);
    const v10 = toVec(p10);
    const v01 = toVec(p01);
    const v11 = toVec(p11);

    const u = (1 - tx) * (1 - ty) * v00.u + tx * (1 - ty) * v10.u + (1 - tx) * ty * v01.u + tx * ty * v11.u;
    const v = (1 - tx) * (1 - ty) * v00.v + tx * (1 - ty) * v10.v + (1 - tx) * ty * v01.v + tx * ty * v11.v;
    const speedKmh = Math.hypot(u, v);

    return { u, v, speedKmh };
  }

  private loop(now: number) {
    if (!this.state.visible) {
      this.stop();
      return;
    }

    this.syncSize();

    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    if (this.ctx && this.width > 0 && this.height > 0) {
      this.render(dt, now);
    }

    this.animId = requestAnimationFrame(this.loop);
  }

  private render(dt: number, timeMs: number) {
    const ctx = this.ctx;
    if (!ctx || this.width <= 0 || this.height <= 0) return;

    // Check if camera is actively moving or zooming
    const isMoving = this.map.isMoving();

    if (isMoving) {
      // Clear trailing canvas completely during camera pan/zoom to prevent stale trail smearing
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      // Soft trail fade for sleek particle persistence when camera is steady
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    const fallbackWindKmh = this.state.windKmh ?? 12;
    const fallbackDeg = this.state.windDeg != null ? this.state.windDeg : 225;

    // Map bearing offset (streamlines rotate seamlessly with map rotation)
    const mapBearingRad = (this.map.getBearing() || 0) * (Math.PI / 180);

    const bounds = this.map.getBounds();
    const west = bounds ? bounds.getWest() : 149;
    const east = bounds ? bounds.getEast() : 151;
    const south = bounds ? bounds.getSouth() : -34;
    const north = bounds ? bounds.getNorth() : -32;

    // ── 1. Air Currents Streamlines (following regional wind field) ──
    const activeParticleCount = Math.min(
      this.particles.length,
      Math.floor(this.particles.length * (0.65 + Math.min(fallbackWindKmh / 50, 0.35)))
    );

    for (let i = 0; i < activeParticleCount; i++) {
      const p = this.particles[i];

      // Sample local wind vector at particle's current coordinate
      const sample = this.sampleWindAt(p.lng, p.lat, fallbackWindKmh, fallbackDeg);

      // Natural atmospheric fluid turbulence noise
      const turb =
        0.12 * Math.sin(p.lng * 10 + p.lat * 8 + p.phase + timeMs * 0.0008) +
        0.08 * Math.cos(p.lng * 8 - p.lat * 10 + p.phase);

      const cosB = Math.cos(turb);
      const sinB = Math.sin(turb);
      const rotatedU = sample.u * cosB - sample.v * sinB;
      const rotatedV = sample.u * sinB + sample.v * cosB;

      // Remember position before wind displacement
      const prevLng = p.lng;
      const prevLat = p.lat;

      // Advance particle in geographic coordinates by wind ONLY
      const latDegPerKm = 1 / 110.574;
      const lngDegPerKm = 1 / (111.32 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180)));
      const stepFactor = 55 * p.speedMult;

      p.lng += rotatedU * (lngDegPerKm / 3600) * dt * stepFactor;
      p.lat += rotatedV * (latDegPerKm / 3600) * dt * stepFactor;
      p.age++;

      // Project BOTH the previous and current coordinates using the CURRENT camera matrix.
      // This guarantees the rendered streak reflects solely the physical wind displacement,
      // completely eliminating streaks caused by panning, zooming, or rotating the map.
      const p0 = this.map.project([prevLng, prevLat]);
      const p1 = this.map.project([p.lng, p.lat]);

      // Life cycle fade
      const progress = p.age / p.maxAge;
      const alpha = progress < 0.2 ? progress / 0.2 : progress > 0.8 ? (1 - progress) / 0.2 : 1;

      // Wrap around full bounds or respawn on expire
      if (
        p.age >= p.maxAge ||
        p1.x < -30 ||
        p1.x > this.width + 30 ||
        p1.y < -30 ||
        p1.y > this.height + 30 ||
        !Number.isFinite(p1.x) ||
        !Number.isFinite(p1.y) ||
        !Number.isFinite(p0.x) ||
        !Number.isFinite(p0.y)
      ) {
        p.lng = west + Math.random() * (east - west);
        p.lat = south + Math.random() * (north - south);
        p.age = 0;
        p.maxAge = 60 + Math.floor(Math.random() * 80);
        continue;
      }

      // Check for unnatural discontinuities (e.g. projection wrap)
      const streakLength = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (streakLength > 60) {
        continue;
      }

      // Draw streamline segment (pure wind vector on current viewport)
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = this.getParticleColor(sample.speedKmh, alpha);
      ctx.lineWidth = Math.min(2.4, 1.2 + (sample.speedKmh / 50) * 0.8);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // ── 2. Spatial Wind Indicators Across Entire Map ──
    const grid = this.state.windGrid?.grid;
    if (grid && grid.length > 0) {
      ctx.save();
      for (let i = 0; i < grid.length; i++) {
        const pt = grid[i];
        const screenPt = this.map.project([pt.lng, pt.lat]);

        // Draw only if on screen with a comfortable margin
        if (
          screenPt.x > 30 &&
          screenPt.x < this.width - 30 &&
          screenPt.y > 30 &&
          screenPt.y < this.height - 30
        ) {
          const flowAngle = (((pt.windDeg + 180) % 360) * Math.PI) / 180 - mapBearingRad;
          const col = this.getParticleColor(pt.windKmh, 0.85);

          // Subtle flowing wind chevron/indicator
          const len = 14;
          const tipX = screenPt.x + Math.sin(flowAngle) * len;
          const tipY = screenPt.y - Math.cos(flowAngle) * len;
          const tailX = screenPt.x - Math.sin(flowAngle) * (len * 0.6);
          const tailY = screenPt.y + Math.cos(flowAngle) * (len * 0.6);

          // Small circular origin dot
          ctx.beginPath();
          ctx.arc(tailX, tailY, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();

          // Flow vector shaft
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(tipX, tipY);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.8;
          ctx.lineCap = 'round';
          ctx.stroke();

          // Arrowhead
          const headLen = 5.5;
          const leftAngle = flowAngle + Math.PI * 0.82;
          const rightAngle = flowAngle - Math.PI * 0.82;

          ctx.beginPath();
          ctx.moveTo(tipX + Math.sin(leftAngle) * headLen, tipY - Math.cos(leftAngle) * headLen);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(tipX + Math.sin(rightAngle) * headLen, tipY - Math.cos(rightAngle) * headLen);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.6;
          ctx.stroke();

          // Small velocity badge
          ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
          const text = `${Math.round(pt.windKmh)}`;
          ctx.font = '10px ui-monospace, monospace';
          const textWidth = ctx.measureText(text).width;
          const badgeX = screenPt.x - textWidth / 2 - 3;
          const badgeY = screenPt.y + 10;
          ctx.fillRect(badgeX, badgeY - 8, textWidth + 6, 12);
          ctx.fillStyle = col;
          ctx.fillText(text, screenPt.x - textWidth / 2, badgeY + 1);
        }
      }
      ctx.restore();
    }


  }

  public destroy() {
    this.stop();
    this.map.off('resize', this.onResize);
    this.map.off('movestart', this.onCameraMove);
    this.map.off('zoomstart', this.onCameraMove);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.remove();
  }
}
