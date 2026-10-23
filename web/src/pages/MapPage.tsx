import { loadRoads, type RoadsStatus } from '../map/roadQuality';
import ActivityLog from '../components/ActivityLog.js';
import { MapConvoy } from '../convoy/ConvoySession.js';
import { logActivity, logSuccessIfNews } from '../activity.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GeoJSONSource, LngLatBounds, Map as MlMap, MapMouseEvent, Marker, NavigationControl, Point, Popup, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { locateControl } from '../map/locateControl.js';
import SuggestSpot from '../components/SuggestSpot.js';
import { api, Candidate, type EventItem, FireIncident, Place, Plane, type PlaneInfo, Route, Spot, type TrafficCamera, TrainPosition, User, type WeatherForecast, type WindGridResponse } from '../api.js';
import { sunLook } from '../map/sunLook.js';
import { hourAt, pickRadarFrame, RAINVIEWER_INDEX, radarTileUrl, weatherIcon, type RadarIndex } from '../map/weather.js';
import { AirCurrentsOverlay } from '../map/airCurrents.js';
import {
  CLICKABLE, initFeedLayers, initLayers, PLANE_LAYERS, setImagery, setLayerVisible, setTerrain3d, STYLE_URL, updateCandidates, updateDraft, updateRoads, ROADS_MIN_ZOOM,
  updateMood, updatePlacesAndSpots, updatePlanes, updateRail, updateRays, setNearbyHighlight, updateShadows, updateTrains, updateWedges,
  TRAIN_LAYERS, setTrains3d, updatePlanePositions, hiddenLayers, setRadarFrame, FIRE_LAYERS, updateFires, updateCameras, EVENT_LAYERS, updateEvents,
} from '../map/layers.js';
import { due, MotionTracker, planePredict, trainPredict } from '../map/motion.js';
import { carriageCount } from '../map/trains3d.js';
import { collectRailTiles, RailSnapper } from '../map/railSnap.js';
import { goodNow, sunPos } from '../map/sun.js';
import { Legend, Swatch } from '../components/Legend.js';
import { MapMenus } from '../components/MapMenus.js';
import { NearbyList } from '../components/NearbyList.js';
import { attachGlance, attachThumbLoader, GLANCE_LAYERS } from '../map/spotGlance.js';
import { CATEGORIES, category, groupLayers, loadVisibility, saveVisibility, type Visibility } from '../map/legend.js';
import { pluginRegistry } from '../plugins/registry.js';
import { legendCategory, PluginCornerPanels, PluginSidePanel, usePluginRegistry } from '../plugins/react.js';
import { applyBaseRailHighlight, effectiveRailOn, restoreBaseRailHighlight, type BaseRailPaintSnapshot } from '../map/baseRailHighlight.js';
import { buildRailPassPopupHtml, clickableRailLayerIds } from '../map/railPasses.js';
import { deadReckon, formatPlaneDetails } from '../map/planes.js';
import { useMapTime } from '../time.js';
import { useEvents } from '../useEvents.js';
import { decodeEntities, formatWhen } from '../events.js';
import EventDetail from '../components/EventDetail.js';
import TimeBar from '../components/TimeBar.js';
import SpotPanel from '../components/SpotPanel.js';
import SpotEditor, { SpotDraft } from '../components/SpotEditor.js';
import PlaceEditor, { draftToPlace, PlaceDraft, placeToDraft } from '../components/PlaceEditor.js';
import RouteEditor, { blankRouteDraft, draftToRoute, RouteDraft, routeToDraft } from '../components/RouteEditor.js';
import { fetchOsrmFullRoute, routeDistanceKm, routeStops, routingWaypoints } from '../map/routeGeometry.js';
import { updateRoutes, ROUTE_LINE_LAYER } from '../map/routeLayer.js';
import { RouteWaypointMarkers, RouteStagingMarker } from '../map/routeWaypointMarkers.js';
import { emptyGoodTimes } from '../components/GoodTimesEditor.js';
import DayStrip from '../components/DayStrip.js';
import SunBearingPlanner from '../components/SunBearingPlanner.js';
import {
  closeSunAnchorTool,
  Coordinate,
  defaultSunAnchorAdapter,
  handleSunAnchorPlacementClick,
  resolveDisplayOrigin,
  resolveSunPlannerBearing,
  shouldShowSunPlanner,
  startSunAnchorTool,
  SunAnchorController,
  updateSelectedBearingProjection,
} from '../map/sunAnchor.js';
import { insertVertexOnNearestSegment, moveOutlineVertex, PlaceOutlineVertexMarkers } from '../map/placeOutlineEdit.js';

type Selection = { type: 'spot' | 'place' | 'candidate' | 'route'; id: string } | null;
type Editing = { type: 'spot'; draft: SpotDraft } | { type: 'place'; draft: PlaceDraft } | { type: 'route'; draft: RouteDraft } | null;
const TRAINS_POLL_MS = 20_000; // matches the server's realtime cache
/** Follow mode re-centres the camera this often, with a linear ease of the same length so the motion is continuous. */
const FOLLOW_EASE_MS = 1000;

type Follow = { kind: 'plane' | 'train'; id: string; name: string; heading: boolean };
const planeName = (p: { flight: string; hex: string }) => p.flight.trim() || p.hex.toUpperCase();
const trainName = (t: { route: string; headsign: string; serviceName?: string }) => t.serviceName || (t.headsign ? `${t.route || 'Train'} → ${t.headsign}` : t.route || 'Train');
/** Same numbers, same prediction: a re-served (cached) poll keeps its animation instead of restarting it. */
const planeKey = (p: Plane) => `${p.lat},${p.lon},${p.track},${p.gs},${p.seen}`;
const trainKey = (t: TrainPosition) => `${t.lat},${t.lng},${t.bearing},${t.speedMps},${t.pathAtKm}`;

export const MAP_CENTRE_KEY = 'ls.mapCentre';

// MapLibre looks for its worker beside its own file, which Vite's bundling moves; hand it Vite's copy.
setWorkerUrl(workerUrl);

const newSpot = (lat: number, lng: number, placeId: string | null = null): SpotDraft => ({
  name: '', notes: '', lat, lng, placeId, tags: [], facingDeg: null, fovDeg: null, goodTimes: emptyGoodTimes(), visibility: 'private',
});

/** Legend keys whose visibility is applied by their own effect below. */
const FEED_KEYS = ['imagery', 'planes', 'rail', 'trains', 'candidates', 'road-quality', 'weather', 'fires', 'cameras', 'events'];
const RADAR_POLL_MS = 10 * 60_000;

type RouteHistoryEntry = { draft: RouteDraft; duration: number | null; ready: boolean };

export default function MapPage({ user }: { user: User | null }) {
  const container = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);

  const updateToolsFade = useCallback(() => {
    const el = toolsRef.current;
    if (!el) return;
    const isOverflowing = el.scrollWidth > el.clientWidth + 2;
    if (!isOverflowing) {
      el.style.removeProperty('-webkit-mask-image');
      el.style.removeProperty('mask-image');
      return;
    }
    const atStart = el.scrollLeft <= 4;
    const atEnd = Math.ceil(el.scrollLeft + el.clientWidth) >= el.scrollWidth - 4;
    const leftStop = atStart ? 'black 0px' : 'transparent 0px, black 24px';
    const rightStop = atEnd ? 'black 100%' : 'black calc(100% - 32px), transparent 100%';
    const mask = `linear-gradient(to right, ${leftStop}, ${rightStop})`;
    el.style.setProperty('-webkit-mask-image', mask);
    el.style.setProperty('mask-image', mask);
  }, []);

  useEffect(() => {
    updateToolsFade();
    window.addEventListener('resize', updateToolsFade);
    return () => window.removeEventListener('resize', updateToolsFade);
  }, [updateToolsFade]);
  const [map, setMap] = useState<MlMap | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [stagingMode, setStagingMode] = useState(false);
  /** Where a signed-in user is suggesting a public spot, once they have right-clicked, long-pressed or used the Add menu. */
  const [suggestAt, setSuggestAt] = useState<{ lat: number; lng: number } | null>(null);
  const canSuggest = useRef(false);
  const [mode, setMode] = useState<'browse' | 'pick-spot' | 'draw' | 'anchor'>('browse');
  const [sheetSize, setSheetSize] = useState<'peek' | 'half'>('peek');
  // The Activity log and the Nearby list share the map's bottom-right corner, so opening one closes the other.
  const [activityOpen, setActivityOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 820);
  const editorKey = editing ? `${editing.type}:${(editing.draft as { id?: string }).id ?? 'new'}` : null;
  const selectedKey = selected ? `${selected.type}:${selected.id}` : null;
  // Back to peek whenever the sheet's content changes or a map-picking mode starts, so the map stays usable.
  useEffect(() => { setSheetSize('peek'); }, [editorKey, selectedKey, mode, stagingMode]);
  const [sunAnchor, setSunAnchor] = useState<Coordinate | null>(null);
  const [sunAnchorBearing, setSunAnchorBearing] = useState<number | null>(null);
  const [terrain, setTerrainOn] = useState(false);
  const [goodOnly, setGoodOnly] = useState(false);
  const [centre, setCentre] = useState({ lat: -33.419, lng: 149.577 });
  const [view, setView] = useState(0); // bumps on moveend, for zoom-scaled geometry and shadows
  const [params, setParams] = useSearchParams();
  const initialMapPoint = useRef(params.has('lat') && params.has('lng') && Number.isFinite(Number(params.get('lat'))) && Number.isFinite(Number(params.get('lng'))) && Math.abs(Number(params.get('lat'))) <= 90 && Math.abs(Number(params.get('lng'))) <= 180
    ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')) } : null);
  const { time, setTime } = useMapTime();

  const sunAnchorController = useRef<SunAnchorController | null>(null);
  if (!sunAnchorController.current) {
    sunAnchorController.current = new SunAnchorController(defaultSunAnchorAdapter);
  }

  useEffect(() => {
    sunAnchorController.current?.sync(map, sunAnchor, (coord) => setSunAnchor(coord), undefined, sunAnchorBearing, setSunAnchorBearing);
  }, [map, sunAnchor?.lat, sunAnchor?.lng, sunAnchorBearing]);

  useEffect(() => {
    return () => {
      sunAnchorController.current?.destroy();
      sunAnchorController.current = null;
    };
  }, []);

  // Phase 3: live feeds, each behind its own toggle so nothing polls unasked.
  // Layer visibility: one source of truth for the legend and the chips.
  const [vis, setVis] = useState<Visibility>(loadVisibility);
  useEffect(() => saveVisibility(vis), [vis]);
  const toggle = (key: string, on = !vis[key]) => setVis((v) => ({ ...v, [key]: on }));
  // Plugin contributions (web/src/plugins). Their toggles join the legend and the menus below; their layers,
  // clicks, panels and polling are driven by the registry, so none of that is wired up in this file.
  const plugins = usePluginRegistry();
  const pluginVis = useMemo(() => Object.fromEntries(plugins.legend.map((l) => [l.globalKey, l.on])), [plugins.legend]);
  const legendVis = useMemo(() => ({ ...vis, ...pluginVis }), [vis, pluginVis]);
  const pluginCategories = useMemo(() => plugins.legend.map(legendCategory), [plugins.legend]);
  const toggleAny = (key: string, on?: boolean) => { if (key in pluginVis) pluginRegistry.setLegendOn(key, on ?? !pluginVis[key]); else toggle(key, on); };
  const pluginMenuItems = (menu: 'live' | 'scout') => plugins.legend.filter((l) => l.menu === menu).map((l) => ({
    key: l.globalKey, label: l.label, swatch: <Swatch cat={legendCategory(l)} />, on: l.on, title: l.title, onSelect: () => pluginRegistry.setLegendOn(l.globalKey, !l.on),
  }));
  // Plugin clicks are ignored while the person is drawing or picking on the map.
  const interactive = useRef(true);
  interactive.current = mode === 'browse' && !editing;
  useEffect(() => {
    if (!map) return;
    return pluginRegistry.attachMap({ map, isInteractive: () => interactive.current, createPopup: () => new Popup() });
  }, [map]);
  // One panel at a time: a core panel (spot, place, route, editor) closes a plugin's, and a plugin's clears the selection.
  useEffect(() => { if (selected || editing) pluginRegistry.closeSidePanels(); }, [selected, editing]);
  const { planes: planesOn, rail: railOn, trains: trainsOn, candidates: candidatesOn, imagery, weather: weatherOn, fires: firesOn, cameras: camerasOn, events: eventsOn } = vis;
  const railEffectiveOn = effectiveRailOn(railOn, trainsOn);
  const baseRailPaint = useRef<BaseRailPaintSnapshot[] | null>(null);
  const routesOn = vis.routes;
  const [rail, setRail] = useState<GeoJSON.FeatureCollection | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [fires, setFires] = useState<FireIncident[]>([]);
  const [planeData, setPlaneData] = useState<Plane[]>([]);
  const [trainData, setTrainData] = useState<TrainPosition[]>([]);
  const [cameraData, setCameraData] = useState<TrafficCamera[]>([]);
  const pluginPanelId = plugins.openSidePanel?.id;
  useEffect(() => { if (pluginPanelId) setSelected(null); }, [pluginPanelId]);

  // Smooth movement between polls, and follow mode (camera on one vehicle).
  const planeMotion = useRef(new MotionTracker());
  const trainMotion = useRef(new MotionTracker());
  const railSnapper = useRef(new RailSnapper());
  const planeExtras = useRef<{ sun?: { azimuth: number; altitude: number } }>({});
  const [follow, setFollow] = useState<Follow | null>(null);
  const followRef = useRef<Follow | null>(null);
  followRef.current = follow;
  const [followNote, setFollowNote] = useState('');
  const [roadsStatus, setRoadsStatus] = useState<RoadsStatus | 'zoom'>('');

  useEffect(() => { if (error) logActivity('Map', error, 'error'); }, [error]);
  useEffect(() => { if (followNote) logActivity('Location and following', followNote); }, [followNote]);
  useEffect(() => {
    if (!roadsStatus) return;
    logActivity('Road quality', { loading: 'Loading roads…', failed: 'Road data unavailable; move the map to retry', zoom: 'Zoom in to see road quality' }[roadsStatus], roadsStatus === 'failed' ? 'error' : 'info');
  }, [roadsStatus]);

  const canEdit = (ownerId: string) => !!user && (user.role === 'admin' || user.id === ownerId);

  const reload = () => Promise.all([api.places(), api.spots(), api.routes()])
    .then(([p, s, r]) => { setPlaces(p); setSpots(s); setRoutes(r); })
    .catch((err) => setError((err as Error).message));

  // --- map lifecycle ---
  useEffect(() => {
    let m: MlMap;
    try {
      const point = initialMapPoint.current;
      m = new MlMap({ container: container.current!, style: STYLE_URL, center: point ? [point.lng, point.lat] : [149.577, -33.419], zoom: point ? 15 : 10, maxPitch: 70 });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(homeControl(), 'top-right');
    m.addControl(locateControl((message) => setFollowNote(message)), 'top-right');
    m.addControl(new ScaleControl({}), 'bottom-left');
    m.once('style.load', () => { initLayers(m); initFeedLayers(m); setMap(m); });
    // Compact attribution starts expanded (full width on phones); start it as the (i) button instead.
    m.once('load', () => m.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
    const onMove = () => {
      const c = m.getCenter();
      setCentre({ lat: c.lat, lng: c.lng });
      setView((v) => v + 1);
      try { localStorage.setItem(MAP_CENTRE_KEY, JSON.stringify({ lat: c.lat, lng: c.lng })); } catch { /* private mode */ }
    };
    m.on('moveend', onMove);
    return () => m.remove();
  }, []);

  useEffect(() => { void reload(); }, []);


  // Start on home, unless a spot or place was asked for in the URL.
  useEffect(() => {
    if (!map || initialMapPoint.current || params.get('spot') || params.get('place') || params.get('lat')) return;
    api.settings().then((s) => map.jumpTo({ center: [s.home.lng, s.home.lat], zoom: 10 })).catch(() => {});
  }, [map]);

  // Rail lines: fetched once for the (toggleable) layer.
  useEffect(() => { api.rail().then(setRail).catch(() => {}); }, []);
  useEffect(() => { if (map) { updateRail(map, rail ?? { type: 'FeatureCollection', features: [] }); setLayerVisible(map, ['rail-lines', 'rail-industrial'], railEffectiveOn); } }, [map, rail, railEffectiveOn]);
  useEffect(() => {
    if (!map) return;
    const restore = () => {
      if (!baseRailPaint.current) return;
      restoreBaseRailHighlight(map, baseRailPaint.current);
      baseRailPaint.current = null;
    };
    const apply = () => {
      restore();
      if (railEffectiveOn) baseRailPaint.current = applyBaseRailHighlight(map);
    };
    apply();
    map.on('style.load', apply);
    return () => {
      map.off('style.load', apply);
      restore();
    };
  }, [map, railEffectiveOn]);

  // Planes: on demand, cached 10s server-side, refreshed every 15s while on and the tab is visible.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, PLANE_LAYERS, planesOn);
    if (!planesOn) { setPlaneData([]); return; }
    let stop = false;
    const tick = () => {
      if (document.hidden) return;
      api.planes(centre.lat, centre.lng, 60).then((planes) => {
        if (stop) return;
        setPlaneData(planes);
        planeMotion.current.update(planes.map((p) => ({ id: p.hex, key: planeKey(p), predict: planePredict(p) })), performance.now());
        const projections = planes.filter((p) => p.track != null && p.gs != null).map((p) => {
          const pts: [number, number][] = [[p.lon, p.lat]];
          for (let m2 = 3; m2 <= 15; m2 += 3) { const d = deadReckon(p, m2); if (d) pts.push([d.lon, d.lat]); }
          return { hex: p.hex, coords: pts };
        });
        const aheadMin = (time.getTime() - Date.now()) / 60_000;
        const ghosts = aheadMin > 0.5 && aheadMin <= 15
          ? planes.map((p) => { const d = deadReckon(p, aheadMin); return d ? { hex: p.hex, lat: d.lat, lon: d.lon } : null; }).filter((g): g is { hex: string; lat: number; lon: number } => g !== null)
          : [];
        planeExtras.current.sun = sunPos(time, centre.lat, centre.lng);
        updatePlanes(map, planes, projections, ghosts, planeExtras.current.sun);
      }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(id); };
  }, [map, planesOn, centre.lat, centre.lng, time]);

  // Trains: live positions *now* (not the slider time), polled while on and the tab is visible.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, TRAIN_LAYERS, trainsOn);
    if (!trainsOn) { trainPopup.current?.remove(); setTrainData([]); return; }
    let stop = false;
    let raw: TrainPosition[] = [];
    // Trains the server couldn't snap go onto the basemap's own rail lines (client fallback; see map/railSnap.ts).
    const show = () => {
      const positions = railSnapper.current.snap(raw);
      trainMotion.current.update(positions.map((t) => ({ id: t.tripId, key: trainKey(t), predict: trainPredict(t) })), performance.now());
      updateTrains(map, positions);
      setTrainData(positions);
    };
    const tick = () => {
      if (document.hidden) return;
      api.trains().then((r) => {
        if (stop) return;
        raw = r.positions;
        railSnapper.current.setTiles(collectRailTiles(map));
        show();
      }).catch(() => {});
    };
    // New basemap tiles: rebuild the rail graph (throttled) and re-snap if it changed and some train needs it.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const onSource = (e: { sourceId?: string; isSourceLoaded?: boolean; tile?: unknown }) => {
      if (pending || !e.tile || !raw.some((t) => !t.snapped)) return;
      pending = setTimeout(() => {
        pending = null;
        if (!stop && railSnapper.current.setTiles(collectRailTiles(map))) show();
      }, 1000);
    };
    map.on('sourcedata', onSource);
    tick();
    const id = setInterval(tick, TRAINS_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stop = true; clearInterval(id); if (pending) clearTimeout(pending);
      map.off('sourcedata', onSource); document.removeEventListener('visibilitychange', tick);
    };
  }, [map, trainsOn]);

  // Candidates: OSM points of interest, fetched by bbox while the layer is on.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['candidates'], candidatesOn);
    if (!candidatesOn) return;
    let stop = false;
    const b = map.getBounds();
    api.candidates(`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`).then((c) => { if (!stop) { setCandidates(c); updateCandidates(map, c); } }).catch(() => {});
    return () => { stop = true; };
  }, [map, candidatesOn, view]);

  // Road quality: OSM roads graded by surface, fetched per grid cell from z13 while the layer is on.
  useEffect(() => {
    if (!map) return;
    const on = vis['road-quality'];
    setLayerVisible(map, ['road-quality'], on);
    if (!on) return setRoadsStatus('');
    if (map.getZoom() < ROADS_MIN_ZOOM) return setRoadsStatus('zoom');
    loadRoads(map, api.roads, setRoadsStatus);
  }, [map, vis['road-quality'], view]);

  // NSW RFS fire incidents: fetched on mount and polled every 5 min.
  useEffect(() => {
    let stop = false;
    const load = () => api.fires().then((data) => { if (!stop) setFires(data); }).catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, FIRE_LAYERS, !!firesOn);
    if (firesOn) updateFires(map, fires);
  }, [map, firesOn, fires]);

  // NSW Live Traffic cameras: fetched when the layer is on and polled every 10 min.
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, ['camera-cones', 'cameras'], !!camerasOn);
    if (!camerasOn) return;
    let stop = false;
    const load = () => {
      api.cameras().then((res) => {
        if (stop) return;
        if (res.cameras) {
          setCameraData(res.cameras);
          updateCameras(map, res.cameras);
        }
      }).catch((err) => {
        if (!stop) setError((err as Error).message);
      });
    };
    load();
    const id = setInterval(load, 10 * 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [map, camerasOn]);

  useEffect(() => {
    if (map && camerasOn && cameraData.length > 0) {
      updateCameras(map, cameraData);
    }
  }, [map, camerasOn, cameraData]);

  // Event Scout events: fetched (and polled) only while the layer is on. A click opens the event over the map.
  const eventFeed = useEvents(!!eventsOn);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  useEffect(() => {
    if (!map) return;
    setLayerVisible(map, EVENT_LAYERS, !!eventsOn);
    if (eventsOn) updateEvents(map, eventFeed.events ?? []);
  }, [map, eventsOn, eventFeed.events]);

  // Animation: move planes and trains between polls, at most every FRAME_MS, and only for shown layers.
  const trainById = useMemo(() => new Map(trainData.map((t) => [t.tripId, t])), [trainData]);
  const animData = useRef({ planeData, trainData, trainById });
  animData.current = { planeData, trainData, trainById };
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let last = 0;
    let lastCam = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!due(last, now)) return;
      last = now;
      const { planeData: planes, trainData: trains, trainById: byId } = animData.current;
      if (planes.length && !hiddenLayers.has('planes')) {
        updatePlanePositions(map, planes.map((p) => {
          const pose = planeMotion.current.pose(p.hex, now);
          return pose ? { ...p, lat: pose.lat, lon: pose.lng } : p;
        }), planeExtras.current.sun);
      }
      if (trains.length && !hiddenLayers.has('trains')) {
        const moved = trains.map((t) => ({ t, pose: trainMotion.current.pose(t.tripId, now) }));
        updateTrains(map, moved.map(({ t, pose }) => (pose ? { ...t, lat: pose.lat, lng: pose.lng } : t)));
        setTrains3d(moved.map(({ t, pose }) => ({
          id: t.tripId, lng: pose?.lng ?? t.lng, lat: pose?.lat ?? t.lat, bearing: pose?.bearing ?? t.bearing ?? null, live: t.status === 'live',
          carriages: carriageCount(t), ...(pose?.path ? { path: pose.path, pathKm: pose.pathKm } : { path: byId.get(t.tripId)?.path, pathKm: t.pathAtKm }),
        })));
      }
      const f = followRef.current;
      // Not while a finger or button is down: easing the camera would cancel the user's drag before it registers.
      if (f && !pointerDown.current && (now - lastCam >= FOLLOW_EASE_MS || lastCam === 0)) {
        const pose = (f.kind === 'plane' ? planeMotion.current : trainMotion.current).pose(f.id, now + FOLLOW_EASE_MS);
        if (pose) {
          lastCam = now;
          map.easeTo({ center: [pose.lng, pose.lat], ...(f.heading && pose.bearing != null ? { bearing: pose.bearing } : {}),
            duration: FOLLOW_EASE_MS, easing: (x) => x, essential: true });
        }
      }
      if (!f) lastCam = 0;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  // Follow mode: any drag/zoom/rotate/pitch by the user (an event with an originalEvent) hands the camera back.
  const pointerDown = useRef(false);
  useEffect(() => {
    if (!map) return;
    const stopOnGesture = (e: { originalEvent?: Event }) => { if (e.originalEvent && followRef.current) setFollow(null); };
    const evs = ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'wheel'] as const;
    for (const ev of evs) map.on(ev, stopOnGesture);
    const down = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; };
    const downs = ['mousedown', 'touchstart'] as const;
    const ups = ['mouseup', 'touchend', 'touchcancel'] as const;
    for (const ev of downs) map.on(ev, down);
    for (const ev of ups) map.on(ev, up);
    window.addEventListener('mouseup', up);
    return () => {
      for (const ev of evs) map.off(ev, stopOnGesture);
      for (const ev of downs) map.off(ev, down);
      for (const ev of ups) map.off(ev, up);
      window.removeEventListener('mouseup', up);
    };
  }, [map]);

  // Suggest a spot: right-click, or hold a finger down for just over half a second, anywhere on the map.
  canSuggest.current = !!user && mode === 'browse' && !editing && !stagingMode;
  useEffect(() => {
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const open = (at: { lat: number; lng: number }) => { if (canSuggest.current) setSuggestAt({ lat: at.lat, lng: at.lng }); };
    const onContext = (e: MapMouseEvent) => { e.originalEvent.preventDefault(); open(e.lngLat); };
    const onTouch = (e: { lngLat: { lat: number; lng: number }; points?: unknown[] }) => {
      cancel();
      if ((e.points?.length ?? 1) === 1) timer = setTimeout(() => open(e.lngLat), 600);
    };
    map.on('contextmenu', onContext);
    map.on('touchstart', onTouch);
    for (const ev of ['touchmove', 'touchend', 'touchcancel', 'dragstart', 'zoomstart'] as const) map.on(ev, cancel);
    return () => {
      cancel();
      map.off('contextmenu', onContext);
      map.off('touchstart', onTouch);
      for (const ev of ['touchmove', 'touchend', 'touchcancel', 'dragstart', 'zoomstart'] as const) map.off(ev, cancel);
    };
  }, [map, user]);
  useEffect(() => {
    if (!map || !suggestAt) return;
    const pin = new Marker({ color: '#f5a623' }).setLngLat([suggestAt.lng, suggestAt.lat]).addTo(map);
    return () => { pin.remove(); };
  }, [map, suggestAt?.lat, suggestAt?.lng]);

  // A followed vehicle that drops out of its feed (or the feed switched off): say so and stop.
  useEffect(() => {
    if (!follow) return;
    const gone = follow.kind === 'plane' ? !planeData.some((p) => p.hex === follow.id) : !trainData.some((t) => t.tripId === follow.id);
    if (!gone) return;
    setFollow(null);
    setFollowNote(`${follow.name} is no longer in the feed — stopped following`);
  }, [planeData, trainData]);
  useEffect(() => {
    if (!followNote) return;
    const id = setTimeout(() => setFollowNote(''), 5000);
    return () => clearTimeout(id);
  }, [followNote]);

  function startFollow(kind: Follow['kind'], id: string) {
    const name = kind === 'plane'
      ? planeName(planeData.find((p) => p.hex === id) ?? { flight: '', hex: id })
      : trainName(trainData.find((t) => t.tripId === id) ?? { route: '', headsign: '' });
    trainPopup.current?.remove();
    setFollowNote('');
    setFollow({ kind, id, name, heading: false });
  }

  useEffect(() => {
    if (!map) return;
    const spotId = params.get('spot');
    const placeId = params.get('place');
    const s = spotId && spots.find((x) => x.id === spotId);
    const p = placeId && places.find((x) => x.id === placeId);
    if (s) { setSelected({ type: 'spot', id: s.id }); focus(s.lng, s.lat, 15); }
    else if (p) { setSelected({ type: 'place', id: p.id }); fitPlace(p); }
    else return;
    setParams({}, { replace: true });
  }, [map, spots, places]);

  // A feed item's `?lat=&lng=` link: look at that spot on the map.
  useEffect(() => {
    if (!map) return;
    const lat = Number(params.get('lat')), lng = Number(params.get('lng'));
    if (!params.get('lat') || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    focus(lng, lat, 15);
    setParams({}, { replace: true });
  }, [map]);

  /** Centre a point in the part of the map the panel leaves visible: above the phone sheet, left of the desktop panel. */
  function focus(lng: number, lat: number, zoom?: number) {
    if (!map) return;
    const phone = window.innerWidth <= 820;
    map.easeTo({ center: [lng, lat], zoom, offset: phone ? [0, -map.getContainer().clientHeight * 0.3] : [-200, 0], duration: 500 });
  }

  function fitPlace(p: Place) {
    if (!map) return;
    const pts = [...spots.filter((s) => s.placeId === p.id).map((s) => [s.lng, s.lat]), [p.lng, p.lat]] as [number, number][];
    const flat = (c: unknown): [number, number][] => (typeof (c as unknown[])[0] === 'number' ? [c as [number, number]] : (c as unknown[]).flatMap(flat));
    const g = p.geom as { coordinates?: unknown } | null;
    if (g?.coordinates) pts.push(...flat(g.coordinates));
    const b = pts.reduce((acc, c) => acc.extend(c), new LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: 80, maxZoom: 16, duration: 600 });
  }

  // --- data into the map ---
  const selectedSpot = selected?.type === 'spot' ? spots.find((s) => s.id === selected.id) : undefined;
  const selectedPlace = selected?.type === 'place' ? places.find((p) => p.id === selected.id) : undefined;
  const selectedCandidate = selected?.type === 'candidate' ? candidates.find((c) => c.id === selected.id) : undefined;
  const selectedRoute = selected?.type === 'route' ? routes.find((r) => r.id === selected.id) : undefined;
  const routeDraft = editing?.type === 'route' ? editing.draft : null;
  const routeDraftRef = useRef<RouteDraft | null>(null);
  routeDraftRef.current = routeDraft;
  const routeOriginal = useRef<RouteDraft | null>(null);
  const routeDraftDirty = useRef(false);
  const [routeRecovered, setRouteRecovered] = useState(false);
  const [routeRouting, setRouteRouting] = useState({ busy: false, error: '' });
  const routeWasBusy = useRef(false);
  useEffect(() => {
    if (routeRouting.busy) { routeWasBusy.current = true; logActivity('Route planner', 'Calculating the route…'); }
    else if (routeRouting.error) { routeWasBusy.current = false; logActivity('Route planner', 'Could not calculate this route', 'error'); }
    else if (routeWasBusy.current) { routeWasBusy.current = false; logActivity('Route planner', 'Route ready', 'success'); }
  }, [routeRouting.busy, routeRouting.error]);
  const routeRoutingRef = useRef(routeRouting);
  routeRoutingRef.current = routeRouting;
  const [routeDuration, setRouteDuration] = useState<number | null>(null);
  const routeDurationRef = useRef<number | null>(null);
  routeDurationRef.current = routeDuration;
  const routeHistory = useRef<{ undo: RouteHistoryEntry[]; redo: RouteHistoryEntry[] }>({ undo: [], redo: [] });
  const [, setRouteHistoryVersion] = useState(0);
  const routeRequest = useRef(0);
  const routeSession = useRef(0);
  const draftKey = (id?: string) => `ls.routeDraft.${user?.id ?? 'anon'}.${id ?? 'new'}`;

  /** Forget the stored draft and any in-flight routing for an edit that ended. */
  function discardRouteDraft(id?: string) {
    try { localStorage.removeItem(draftKey(id)); } catch { /* storage may be disabled */ }
    routeDraftDirty.current = false;
    ++routeSession.current;
    ++routeRequest.current;
  }

  function setRouteDraft(draft: RouteDraft) {
    routeDraftDirty.current = true;
    routeDraftRef.current = draft;
    setEditing({ type: 'route', draft });
  }

  function setRouting(busy: boolean, error = '') {
    routeRoutingRef.current = { busy, error };
    setRouteRouting({ busy, error });
  }

  function setDuration(seconds: number | null) {
    routeDurationRef.current = seconds;
    setRouteDuration(seconds);
  }

  function rememberRoute() {
    const draft = routeDraftRef.current;
    if (!draft) return;
    routeHistory.current.undo.push({ draft, duration: routeDurationRef.current, ready: !routeRoutingRef.current.busy && !routeRoutingRef.current.error });
    routeHistory.current.redo = [];
    setRouteHistoryVersion((value) => value + 1);
  }

  function fitRouteIfOutOfBounds(vertices: [number, number][]) {
    if (!map || vertices.length < 2) return;
    const phone = window.innerWidth <= 820;
    const mapContainer = map.getContainer();
    const mapW = mapContainer.clientWidth;
    const mapH = mapContainer.clientHeight;
    if (mapW <= 0 || mapH <= 0) return;

    const panelEl = (container.current?.parentElement?.querySelector('.panel') ?? document.querySelector('.panel')) as HTMLElement | null;
    const panelHeight = panelEl ? panelEl.getBoundingClientRect().height : (phone ? mapH * 0.38 : 0);
    const panelWidth = panelEl ? panelEl.getBoundingClientRect().width : 390;

    const toolsEl = (container.current?.parentElement?.querySelector('.maptools') ?? document.querySelector('.maptools')) as HTMLElement | null;
    const mapRect = mapContainer.getBoundingClientRect();
    const toolsBottom = toolsEl ? Math.max(0, toolsEl.getBoundingClientRect().bottom - mapRect.top) : 40;

    const padding = phone
      ? {
          top: Math.round(toolsBottom + 16),
          bottom: Math.round(panelHeight + 24),
          left: 24,
          right: 24,
        }
      : {
          top: 24,
          bottom: 24,
          left: 24,
          right: Math.round(panelWidth + 24),
        };

    const minX = padding.left;
    const maxX = mapW - padding.right;
    const minY = padding.top;
    const maxY = mapH - padding.bottom;

    const isOutside = vertices.some(([lng, lat]) => {
      const pt = map.project([lng, lat]);
      return pt.x < minX || pt.x > maxX || pt.y < minY || pt.y > maxY;
    });

    if (isOutside) {
      const b = vertices.reduce((acc, c) => acc.extend(c), new LngLatBounds(vertices[0], vertices[0]));
      map.fitBounds(b, { padding, maxZoom: 16, duration: 500 });
    }
  }

  function calculateRoute(draft: RouteDraft) {
    const request = ++routeRequest.current;
    const session = routeSession.current;
    const waypoints = draft.waypoints ?? draft.vertices;
    if (!draft.snap || waypoints.length < 2) {
      setRouting(false);
      setDuration(null);
      setRouteDraft({ ...draft, vertices: waypoints });
      if (waypoints.length >= 2) fitRouteIfOutOfBounds(waypoints);
      return;
    }
    setRouting(true);
    void fetchOsrmFullRoute(routingWaypoints(waypoints, draft.type)).then((result) => {
      if (request !== routeRequest.current || session !== routeSession.current) return;
      if (!result) {
        setRouting(false, 'Could not calculate a road route. Check the stops and retry.');
        return;
      }
      const current = routeDraftRef.current;
      if (!current) return;
      setRouteDraft({ ...current, vertices: result.coordinates });
      setDuration(result.durationSeconds);
      setRouting(false);
      fitRouteIfOutOfBounds(result.coordinates);
    });
  }

  function changeRouteWaypoints(waypoints: [number, number][]) {
    const current = routeDraftRef.current;
    if (!current) return;
    rememberRoute();
    const next = { ...current, waypoints, ...(!current.snap ? { vertices: waypoints } : {}) };
    setRouteDraft(next);
    calculateRoute(next);
  }

  function changeRouteDraft(next: RouteDraft) {
    const current = routeDraftRef.current;
    if (!current) return;
    if (next.snap !== current.snap || next.type !== current.type) {
      rememberRoute();
      if (!next.snap && !current.snap) {
        setRouteDraft(next);
        return;
      }
      const changed = { ...next, waypoints: next.waypoints ?? routeStops(current) };
      setRouteDraft(changed);
      calculateRoute(changed);
    } else {
      setRouteDraft(next);
    }
  }

  function travelHistory(direction: 'undo' | 'redo') {
    const from = routeHistory.current[direction];
    const entry = from.pop();
    const current = routeDraftRef.current;
    if (!entry || !current) return;
    routeHistory.current[direction === 'undo' ? 'redo' : 'undo'].push({ draft: current, duration: routeDurationRef.current, ready: !routeRoutingRef.current.busy && !routeRoutingRef.current.error });
    ++routeRequest.current;
    setRouteDraft(entry.draft);
    setDuration(entry.duration);
    setRouting(false);
    if (!entry.ready) calculateRoute(entry.draft);
    else if (entry.draft.vertices.length >= 2) fitRouteIfOutOfBounds(entry.draft.vertices);
    setRouteHistoryVersion((value) => value + 1);
  }

  function openRouteEdit(draft: RouteDraft) {
    setStagingMode(false);
    ++routeSession.current;
    ++routeRequest.current;
    routeHistory.current = { undo: [], redo: [] };
    setRouteHistoryVersion((value) => value + 1);
    setRouting(false);
    setDuration(null);
    routeOriginal.current = draft;
    routeDraftDirty.current = false;
    setRouteRecovered(false);
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(draft.id)) ?? 'null') as RouteDraft | null;
      if (saved && saved.id === draft.id && saved.updatedAt === draft.updatedAt && Array.isArray(saved.vertices) &&
          (saved.waypoints === undefined || Array.isArray(saved.waypoints))) {
        draft = saved;
        routeDraftDirty.current = true;
        setRouteRecovered(true);
      }
    } catch { /* storage may be disabled */ }
    routeDraftRef.current = draft;
    setEditing({ type: 'route', draft });
    if (routeDraftDirty.current && draft.snap && (draft.waypoints?.length ?? 0) >= 2) calculateRoute(draft);
    setSelected(null);
    setMode('draw');
  }

  useEffect(() => {
    if (!routeDraft || !routeDraftDirty.current) return;
    try { localStorage.setItem(draftKey(routeDraft.id), JSON.stringify(routeDraft)); } catch { /* storage may be disabled */ }
  }, [routeDraft]);
  const cursorState = useRef({ mode, snap: false });
  cursorState.current = { mode, snap: !!routeDraft?.snap };
  const spotDraft = editing?.type === 'spot' ? editing.draft : null;

  const timeKey = Math.floor(time.getTime() / 300_000); // "good" needn't be redone more often than the slider's step
  /** What's drawn: saved spots with the one being edited swapped for its draft. */
  const shownSpots = useMemo(() => {
    let list = spots;
    if (spotDraft) {
      const d = { ...spotDraft, id: spotDraft.id ?? '__draft', ownerId: '', source: '', sourceRef: '', createdAt: '', updatedAt: '' } as Spot;
      list = spotDraft.id ? spots.map((s) => (s.id === spotDraft.id ? d : s)) : [...spots, d];
    }
    return goodOnly ? list.filter((s) => s.id === '__draft' || s.id === spotDraft?.id || goodNow(s, time)) : list;
  }, [spots, spotDraft, goodOnly, goodOnly ? timeKey : 0]);
  const highlight = spotDraft?.id ?? (spotDraft ? '__draft' : selectedSpot?.id ?? null);
  useEffect(() => {
    if (map) updatePlacesAndSpots(map, places, shownSpots, (s) => goodNow(s, time), highlight);
  }, [map, places, shownSpots, highlight, timeKey]);
  useEffect(() => {
    if (map) updateWedges(map, shownSpots, (s) => goodNow(s, time), highlight);
  }, [view]);

  useEffect(() => {
    if (!map) return;
    // The meetup point is a draggable marker while editing, so keep it out of the static layer.
    const draft = routeDraft ? { ...draftToRoute(routeDraft), staging: null } as Route : null;
    const shown = draft ? (routeDraft?.id ? routes.map((r) => r.id === routeDraft.id ? draft : r) : [...routes, draft]) : routes;
    updateRoutes(map, shown, routeDraft?.id ?? selectedRoute?.id ?? null);
  }, [map, routes, routeDraft, selectedRoute?.id]);

  const displayOrigin = resolveDisplayOrigin({
    sunAnchor,
    spotDraft,
    selectedSpot,
    viewportCentre: centre,
  });
  useEffect(() => {
    if (!map) return;
    updateMood(map, sunPos(time, centre.lat, centre.lng));
    updateRays(map, displayOrigin, time);
  }, [map, time, centre.lat, centre.lng, displayOrigin.lat, displayOrigin.lng, view]);

  useEffect(() => {
    if (map) updateSelectedBearingProjection(map, sunAnchor, sunAnchorBearing);
  }, [map, sunAnchor?.lat, sunAnchor?.lng, sunAnchorBearing, view]);

  // Shadows: throttled, on moveend and on time change.
  const shadowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!map) return;
    clearTimeout(shadowTimer.current);
    shadowTimer.current = setTimeout(() => {
      const c = map.getCenter();
      updateShadows(map, sunPos(time, c.lat, c.lng));
    }, 150);
  }, [map, time, view]);
  // Newly loaded building tiles need a pass too, at whatever the time is by then.
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!map) return;
    const onIdle = () => { const c = map.getCenter(); updateShadows(map, sunPos(timeRef.current, c.lat, c.lng)); };
    map.once('idle', onIdle);
    return () => { map.off('idle', onIdle); };
  }, [map, view]);

  useEffect(() => { if (map) setImagery(map, imagery); }, [map, imagery]);

  // Weather: RainViewer radar frames (index refreshed every 10 min) and an Open-Meteo readout for the map centre.
  const [radarIdx, setRadarIdx] = useState<RadarIndex | null>(null);
  useEffect(() => {
    if (!weatherOn) return;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(RAINVIEWER_INDEX).then((r) => { if (!r.ok) throw new Error('Radar unavailable'); return r.json(); })
        .then((data) => { setRadarIdx(data); logSuccessIfNews('Rain radar', 'Radar frames updated'); })
        .catch(() => logActivity('Rain radar', 'Radar frames unavailable', 'error'));
    };
    load();
    const id = setInterval(load, RADAR_POLL_MS);
    return () => clearInterval(id);
  }, [weatherOn]);
  const radarFrame = radarIdx ? pickRadarFrame(radarIdx, time.getTime()) : null;
  useEffect(() => {
    if (map) setRadarFrame(map, radarIdx && radarFrame ? radarTileUrl(radarIdx.host, radarFrame) : null, !!weatherOn);
  }, [map, weatherOn, radarIdx?.host, radarFrame?.path]);
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  useEffect(() => {
    if (!weatherOn && !terrain) return; // the readout needs it, and so does the 3D sky
    const id = setTimeout(() => api.weather(centre.lat, centre.lng).then(setForecast).catch(() => setForecast(null)), 600);
    return () => clearTimeout(id);
  }, [weatherOn, terrain, centre.lat, centre.lng]);
  // 3D sky: blue by day, sunset tints, grey under cloud, rain or fog at the map time.
  useEffect(() => {
    if (map) map.setSky(sunLook(sunPos(time, centre.lat, centre.lng), hourAt(forecast, time.getTime())).sky);
  }, [map, time, centre.lat, centre.lng, forecast]);
  const wxHour = weatherOn ? hourAt(forecast, time.getTime()) : null;
  const wxNight = sunPos(time, centre.lat, centre.lng).altitude < 0;
  const [windGrid, setWindGrid] = useState<WindGridResponse | null>(null);
  useEffect(() => {
    if (!map || !weatherOn) { setWindGrid(null); return; }
    const load = () => {
      const b = map.getBounds();
      api.windGrid({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, time.toISOString())
        .then(setWindGrid).catch(() => setWindGrid(null));
    };
    const timer = setTimeout(load, 500);
    map.on('moveend', load);
    return () => { clearTimeout(timer); map.off('moveend', load); };
  }, [map, weatherOn, time]);
  const airCurrents = useRef<AirCurrentsOverlay | null>(null);
  useEffect(() => {
    if (!map) return;
    const overlay = new AirCurrentsOverlay(map);
    airCurrents.current = overlay;
    return () => { overlay.destroy(); airCurrents.current = null; };
  }, [map]);
  useEffect(() => {
    airCurrents.current?.update({
      visible: weatherOn,
      windKmh: wxHour?.windKmh ?? null,
      windDeg: wxHour?.windDeg ?? null,
      gustKmh: wxHour?.gustKmh ?? null,
      precipMm: wxHour?.precipMm ?? null,
      windGrid,
    });
  }, [weatherOn, wxHour?.windKmh, wxHour?.windDeg, wxHour?.gustKmh, wxHour?.precipMm, windGrid]);
  // Categories without their own feed effect: apply straight from the legend state.
  useEffect(() => {
    if (!map) return;
    const groups = groupLayers(map.getStyle().layers ?? []);
    for (const c of CATEGORIES) if (!FEED_KEYS.includes(c.key)) setLayerVisible(map, groups[c.key], vis[c.key]);
    // Extruded buildings only in 3D; the flat footprints (which building shadows also read) stay either way.
    setLayerVisible(map, groups.buildings.filter((id) => map.getLayer(id)?.type === 'fill-extrusion'), vis.buildings && terrain);
    // In 3D terrain mode, hide the 2D hillshade layer to avoid duplicate DEM tile fetching and RTT slope shading
    setLayerVisible(map, ['hillshade'], vis.terrain && !terrain);
  }, [map, vis, terrain]);
  useEffect(() => { if (map) setTerrain3d(map, terrain); }, [map, terrain]);

  const placeDraft = editing?.type === 'place' ? editing.draft : null;
  const placeDraftRef = useRef<PlaceDraft | null>(null);
  placeDraftRef.current = placeDraft;
  const vertexMarkers = useRef(new PlaceOutlineVertexMarkers<MlMap>({
    makeMarker: (_index, at) => {
      const el = document.createElement('div');
      el.className = 'place-vertex-handle';
      el.title = 'Drag to move this outline point';
      return new Marker({ element: el, draggable: true }).setLngLat(at);
    },
  }));
  useEffect(() => {
    if (map) updateDraft(map, placeDraft?.coords ?? [], placeDraft?.kind ?? 'polygon');
  }, [map, placeDraft]);
  useEffect(() => {
    vertexMarkers.current.update(map, placeDraft?.coords ?? [], mode === 'draw' && !!placeDraft && placeDraft.coords.length > 0, (index, at) => {
      const draft = placeDraftRef.current;
      if (!draft) return;
      setEditing({ type: 'place', draft: { ...draft, coords: moveOutlineVertex(draft.coords, index, at) } });
    });
  }, [map, placeDraft, mode]);
  useEffect(() => () => vertexMarkers.current.clear(), [map]);

  const routeWaypointMarkers = useRef(new RouteWaypointMarkers());
  useEffect(() => {
    if (!map) return;
    routeWaypointMarkers.current.update(
      map,
      routeDraft ? routeStops(routeDraft) : [],
      mode === 'draw' && !!routeDraft,
      (index, at) => {
        const draft = routeDraftRef.current;
        if (!draft) return;
        const stops = routeStops(draft).slice();
        stops[index] = at;
        changeRouteWaypoints(stops);
      },
    );
  }, [map, routeDraft, mode]);
  useEffect(() => () => routeWaypointMarkers.current.clear(), [map]);
  const routeStagingMarker = useRef(new RouteStagingMarker());
  const stagingAt = routeDraft?.staging ? [routeDraft.staging.lng, routeDraft.staging.lat] as [number, number] : null;
  useEffect(() => {
    routeStagingMarker.current.update(map, stagingAt, ([lng, lat]) => {
      const draft = routeDraftRef.current;
      if (!draft) return;
      rememberRoute();
      setRouteDraft({ ...draft, staging: { lat, lng } });
    });
  }, [map, stagingAt?.[0], stagingAt?.[1]]);
  useEffect(() => () => routeStagingMarker.current.clear(), [map]);

  // --- clicks ---
  const onClick = useRef<(e: MapMouseEvent) => void>(() => {});
  onClick.current = (e) => {
    if (!map) return;
    const { lat, lng } = e.lngLat;
    const placement = handleSunAnchorPlacementClick(mode, { lat, lng });
    if (placement.consumed) {
      setSunAnchor(placement.newAnchor!);
      setSunAnchorBearing(0);
      setMode(placement.nextMode ?? 'browse');
      return;
    }
    if (stagingMode && routeDraftRef.current) {
      setEditing({ type: 'route', draft: { ...routeDraftRef.current, staging: { lat, lng } } });
      setStagingMode(false);
      return;
    }
    if (mode === 'pick-spot') {
      setMode('browse');

      setSelected(null);
      setEditing({ type: 'spot', draft: newSpot(lat, lng) });
      focus(lng, lat);
      return;
    }
    if (mode === 'draw' && routeDraftRef.current) {
      const draft = routeDraftRef.current, to: [number, number] = [lng, lat];
      const stops = routeStops(draft);

      // Clicking on the drawn line inserts a stop there. Only when the line is the straight stop-to-stop one (snap off);
      // a routed road can't be hit-tested per leg, so with snapping a click always appends.
      const inserted = !draft.snap && stops.length >= 2 && stops.length === draft.vertices.length ? insertVertexOnNearestSegment(stops, 'line', e.point, {
        project: (at) => map.project(at),
        unproject: (point) => {
          const ll = map.unproject([point.x, point.y]);
          return [ll.lng, ll.lat];
        },
        tolerancePx: 12,
      }) : null;

      if (inserted) {
        changeRouteWaypoints(inserted.coords);
        return;
      }
      changeRouteWaypoints([...stops, to]);
      return;
    }
    if (mode === 'draw' && placeDraft) {
      const inserted = insertVertexOnNearestSegment(placeDraft.coords, placeDraft.kind, e.point, {
        project: (at) => map.project(at),
        unproject: (point) => {
          const ll = map.unproject([point.x, point.y]);
          return [ll.lng, ll.lat];
        },
        tolerancePx: 10,
      });
      const coords = inserted?.coords ?? [...placeDraft.coords, [lng, lat] as [number, number]];
      setEditing({ type: 'place', draft: { ...placeDraft, coords, ...(placeDraft.coords.length ? {} : { lat, lng }) } });
      return;
    }
    if (editing) return;
    const train = map.getLayer('trains') ? map.queryRenderedFeatures(e.point, { layers: ['trains'] })[0] : undefined;
    if (train) return showTrainPopup(map, train, (id) => startFollow('train', id));
    const planeLayers = ['planes', 'planes-label'].filter((l) => map.getLayer(l) && !hiddenLayers.has(l));
    const plane = planeLayers.length ? map.queryRenderedFeatures(e.point, { layers: planeLayers })[0] : undefined;
    const pl = plane && planeData.find((p) => p.hex === plane.properties?.id);
    if (pl) return showPlanePopup(map, pl, (id) => startFollow('plane', id));
    if (trainsOn) {
      const railLayers = clickableRailLayerIds(map.getStyle().layers ?? [], (id) => Boolean(map.getLayer(id)) && !hiddenLayers.has(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      const rail = railLayers.length ? map.queryRenderedFeatures(e.point, { layers: railLayers })[0] : undefined;
      if (rail) return showRailPassPopup(map, lat, lng);
    }
    const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter((l) => map.getLayer(l)) })[0];
    if (!hit) {
      setSelected(null);
      return;
    }
    const id = hit.properties?.id as string;
    if (hit.layer.id === 'cameras') {
      const coords = (hit.geometry as GeoJSON.Point).coordinates as [number, number];
      showCameraPopup(map, coords, hit.properties ?? {});
      return;
    }
    if (hit.layer.id === 'road-quality') {
      showRoadPopup(map, [lng, lat], hit.properties ?? {});
      return;
    }
    if (hit.layer.id === 'event-clusters') {
      (map.getSource('events') as GeoJSONSource).getClusterExpansionZoom(hit.properties.cluster_id)
        .then((zoom) => map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom }));
      return;
    }
    if (hit.layer.id === 'event-points') {
      const ev = eventFeed.events?.find((x) => x.group === hit.properties?.group);
      if (ev) showEventPopup(map, (hit.geometry as GeoJSON.Point).coordinates as [number, number], ev, () => setOpenEvent(ev.group));
      return;
    }
    if (FIRE_LAYERS.includes(hit.layer.id)) {
      showFirePopup(map, [lng, lat], hit.properties ?? {});
      return;
    }
    if (hit.layer.id === 'clusters') {
      (map.getSource('spots') as GeoJSONSource).getClusterExpansionZoom(hit.properties.cluster_id)
        .then((zoom) => map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom }));
    } else if (GLANCE_LAYERS.includes(hit.layer.id)) {
      // Touch has no hover: the first tap on a spot shows its glance card, the next one selects it.
      if (lastPointer.current === 'touch' && glance.current && glance.current.shownId !== id) {
        glance.current.show(id, (hit.geometry as GeoJSON.Point).coordinates as [number, number]);
        return;
      }
      glance.current?.hide();
      setSelected({ type: 'spot', id });
      const [lng, lat] = (hit.geometry as GeoJSON.Point).coordinates;
      focus(lng, lat);
    } else if (hit.layer.id === ROUTE_LINE_LAYER || hit.layer.id === 'route-staging') {
      setSelected({ type: 'route', id: hit.properties?.routeId as string });
    } else if (hit.layer.id === 'candidates') {
      setSelected({ type: 'candidate', id });
      const [lng, lat] = (hit.geometry as GeoJSON.Point).coordinates;
      focus(lng, lat);
    } else {
      setSelected({ type: 'place', id });
      const p = places.find((x) => x.id === id);
      if (p && hit.layer.id === 'place-points') fitPlace(p);
    }
  };
  // Spot glance: lazy cover thumbnails and the hover card. Refs keep the handlers on current data.
  const glance = useRef<ReturnType<typeof attachGlance> | null>(null);
  const lastPointer = useRef('mouse');
  const glanceData = useRef<{ spots: Spot[]; time: Date; home: { lat: number; lng: number } | null }>({ spots: [], time, home: null });
  glanceData.current.spots = shownSpots;
  glanceData.current.time = time;
  useEffect(() => {
    if (!map) return;
    const detachThumbs = attachThumbLoader(map);
    const g = attachGlance(map, (id) => glanceData.current.spots.find((s) => s.id === id),
      () => ({ time: glanceData.current.time, home: glanceData.current.home }));
    glance.current = g;
    api.settings().then((s) => { glanceData.current.home = s.home; }).catch(() => {});
    const canvas = map.getCanvas();
    const onPointer = (e: PointerEvent) => { lastPointer.current = e.pointerType; };
    canvas.addEventListener('pointerdown', onPointer);
    return () => { detachThumbs(); g.detach(); glance.current = null; canvas.removeEventListener('pointerdown', onPointer); };
  }, [map]);
  useEffect(() => {
    if (!map) return;
    const click = (e: MapMouseEvent) => onClick.current(e);
    map.on('click', click);
    let moveRaf = 0;
    let pendingPoint: Point | null = null;
    let roadsCached: string[] | null = null;
    let clickableCached: string[] | null = null;

    const updateCursor = (point: Point) => {
      const { mode: m, snap } = cursorState.current;
      if (m === 'browse') {
        if (!clickableCached) clickableCached = [...CLICKABLE, 'trains', 'planes'].filter((id) => map.getLayer(id));
        const hasOver = clickableCached.length > 0 && map.queryRenderedFeatures(point, { layers: clickableCached }).length > 0;
        map.getCanvas().style.cursor = hasOver ? 'pointer' : '';
      } else if (m === 'draw' && snap) {
        if (!roadsCached) roadsCached = (groupLayers(map.getStyle().layers ?? []).roads ?? []).filter((id) => map.getLayer(id));
        const hasOver = roadsCached.length > 0 && map.queryRenderedFeatures(point, { layers: roadsCached }).length > 0;
        map.getCanvas().style.cursor = hasOver ? 'pointer' : 'crosshair';
      } else {
        map.getCanvas().style.cursor = 'crosshair';
      }
    };

    const move = (e: MapMouseEvent) => {
      if (pointerDown.current) return;
      pendingPoint = e.point;
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          if (pendingPoint) {
            updateCursor(pendingPoint);
            pendingPoint = null;
          }
        });
      }
    };
    map.on('mousemove', move);
    return () => {
      map.off('click', click);
      map.off('mousemove', move);
      if (moveRaf) cancelAnimationFrame(moveRaf);
    };
  }, [map]);

  useEffect(() => {
    if (map) map.getCanvas().style.cursor = mode === 'browse' ? '' : 'crosshair';
  }, [map, mode]);

  // --- actions ---
  async function saveSpot(d: SpotDraft) {
    const body = { ...d };
    delete body.id;
    const saved = d.id ? await api.updateSpot(d.id, body) : await api.createSpot(body);
    await reload();
    setEditing(null);
    setSelected({ type: 'spot', id: saved.id });
  }

  async function savePlace(d: PlaceDraft) {
    const body = draftToPlace(d);
    const saved = d.id ? await api.updatePlace(d.id, body) : await api.createPlace(body);
    await reload();
    setMode('browse');
    setEditing(null);
    setSelected({ type: 'place', id: saved.id });
  }

  async function saveRoute(d: RouteDraft) {
    if (routeRoutingRef.current.busy || routeRoutingRef.current.error) throw new Error('Wait for the road route or retry it before saving.');
    const body = draftToRoute(d);
    const saved = d.id ? await api.updateRoute(d.id, body) : await api.createRoute(body);
    discardRouteDraft(d.id);
    await reload(); setEditing(null); setMode('browse'); setSelected({ type: 'route', id: saved.id });
  }

  async function deleteRoute(r: Route) {
    if (!confirm(`Delete \"${r.name}\"?`)) return;
    await api.deleteRoute(r.id);
    if (routeDraftRef.current?.id === r.id) { discardRouteDraft(r.id); setEditing(null); setMode('browse'); }
    setSelected(null); await reload();
  }

  async function deleteSpot(s: Spot) {
    if (!confirm(`Delete "${s.name}" and its photos?`)) return;
    await api.deleteSpot(s.id);
    setSelected(null);
    await reload();
  }

  async function deletePlace(id: string) {
    if (!confirm('Delete this place? Its spots stay, as standalone spots.')) return;
    await api.deletePlace(id);
    setEditing(null);
    setMode('browse');
    setSelected(null);
    await reload();
  }

  async function createSpotAt(lat: number, lng: number, placeId: string | null = null): Promise<Spot> {
    const s = await api.createSpot({ ...newSpot(lat, lng, placeId), name: 'New spot' });
    await reload();
    setSelected({ type: 'spot', id: s.id });
    focus(lng, lat);
    return s;
  }

  function cancelEdit() {
    setStagingMode(false);
    if (routeDraftRef.current) discardRouteDraft(routeDraftRef.current.id);
    setEditing(null);
    setMode('browse');
  }

  function toggleSunAnchorPlacement() {
    if (mode === 'anchor') {
      setMode('browse');
      return;
    }
    setVis((visibility) => startSunAnchorTool(visibility));
    setMode('anchor');
  }

  function closePanel() {
    if (editing) {
      cancelEdit();
      return;
    }
    setSelected(null);
    if (sunAnchor || mode === 'anchor') {
      const next = closeSunAnchorTool();
      setSunAnchor(next.anchor);
      setSunAnchorBearing(next.bearing);
      setMode(next.mode);
    }
  }

  async function promoteCandidate(c: Candidate) {
    const spot = await api.promoteCandidate(c.id);
    await reload();
    setSelected({ type: 'spot', id: spot.id });
  }

  const panelOpen = !!editing || !!selectedSpot || !!selectedPlace || !!selectedCandidate || !!selectedRoute || shouldShowSunPlanner(sunAnchor, null);
  const isPanelActive = panelOpen || !!plugins.openSidePanel;
  const placeSpots = selectedPlace ? spots.filter((s) => s.placeId === selectedPlace.id) : [];
  const selectedSunBearing = selectedSpot ? resolveSunPlannerBearing(selectedSpot, sunAnchor, sunAnchorBearing) : null;


  return (
    <div className={`mapshell${isPanelActive ? ' mapshell--panel' : ''}${editing ? ' mapshell--editing' : ''}${weatherOn && forecast ? ' mapshell--has-weather' : ''}`}>
      <div ref={container} className="mapshell__map" />
      {user && <MapConvoy map={map} />}
      {follow && (
        <div className="followpill" role="status">
          <span>Following <strong>{follow.name}</strong></span>
          <label title="Turn the map to the vehicle's heading"><input type="checkbox" checked={follow.heading}
            onChange={(e) => setFollow({ ...follow, heading: e.target.checked })} />heading</label>
          <button className="iconbtn iconbtn--ghost" onClick={() => setFollow(null)} title="Stop following" aria-label="Stop following">✕</button>
        </div>
      )}
      {mode !== 'browse' && (mode === 'pick-spot' || mode === 'anchor' || editing?.type !== 'route') && (
        <div className="mapinstruction" role="status">
          {mode === 'pick-spot'
            ? 'Click the map to place the spot'
            : mode === 'anchor'
            ? 'Click the map to place the sun anchor'
            : 'Click the map to add or edit points'}
        </div>
      )}

      {suggestAt && <SuggestSpot at={suggestAt} onClose={() => setSuggestAt(null)} />}
      {openEvent && eventFeed.events?.find((e) => e.group === openEvent) && (
        <EventDetail ev={eventFeed.events.find((e) => e.group === openEvent)!} user={user} onClose={() => setOpenEvent(null)} onMark={user ? eventFeed.mark : undefined} onRsvp={user ? eventFeed.rsvp : undefined} />
      )}
      <Legend map={map} vis={legendVis} onToggle={toggleAny} extra={pluginCategories} />
      <div className="mapcorner">
        <PluginCornerPanels />
        <div className="mapcorner__row">
        <ActivityLog admin={user?.role === 'admin'} open={activityOpen}
          onOpenChange={(open) => { setActivityOpen(open); if (open) setNearbyOpen(false); }} />
        <NearbyList planes={planesOn ? planeData : null} trains={trainsOn ? trainData : null} centre={centre}
        open={nearbyOpen} onOpenChange={(open) => { setNearbyOpen(open); if (open) setActivityOpen(false); }}
        onHover={(at) => { if (map) setNearbyHighlight(map, at); }}
        following={follow?.id ?? null}
        onFollow={(kind, r) => (follow?.id === r.id ? setFollow(null) : startFollow(kind, r.id))}
        onPlane={(r) => {
          if (!map) return;
          map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 11) });
          const pl = planeData.find((x) => x.hex === r.id);
          if (pl) showPlanePopup(map, pl, (id) => startFollow('plane', id));
        }}
        onTrain={(r) => {
          if (!map) return;
          map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 12) });
          const t = trainData.find((x) => x.tripId === r.id);
          if (t) showTrainPopup(map, { type: 'Feature', properties: { id: t.tripId, route: t.route, headsign: t.headsign, serviceName: t.serviceName, status: t.status, delaySec: t.delaySec }, geometry: { type: 'Point', coordinates: [t.lng, t.lat] } },
            (id) => startFollow('train', id));
        }} />
        </div>
      </div>
      <div className="maptools" ref={toolsRef} onScroll={updateToolsFade}>
        <button className={`chip${imagery ? ' active' : ''}`} onClick={() => toggle('imagery')}><Swatch cat={category('imagery')} />{category('imagery').label}</button>
        <button className={`chip${terrain ? ' active' : ''}`} onClick={() => setTerrainOn(!terrain)}>3D</button>
        <button className={`chip${goodOnly ? ' active' : ''}`} onClick={() => setGoodOnly(!goodOnly)} title="Only spots whose good times match the map time">Good now</button>
        {user && <Link className="chip" to="/drive" title="Turn-by-turn navigation for the car">Drive</Link>}
        <MapMenus menus={[
          { label: 'Live', items: [
            { key: 'planes', label: category('planes').label, swatch: <Swatch cat={category('planes')} />, on: planesOn, title: 'Live aircraft, dead-reckoned 15 minutes ahead', onSelect: () => toggle('planes') },
            { key: 'trains', label: category('trains').label, swatch: <Swatch cat={category('trains')} />, on: trainsOn, title: 'Live passenger train positions, refreshed every 20s (needs a TfNSW key)', onSelect: () => toggle('trains') },
            { key: 'weather', label: category('weather').label, swatch: <Swatch cat={category('weather')} />, on: weatherOn, title: 'Rain radar (RainViewer, recent past only) and the forecast at the map centre for the map time', onSelect: () => toggle('weather') },
            { key: 'cameras', label: category('cameras').label, swatch: <Swatch cat={category('cameras')} />, on: camerasOn, title: 'NSW live traffic cameras (TfNSW)', onSelect: () => toggle('cameras') },
            { key: 'fires', label: category('fires').label, swatch: <Swatch cat={category('fires')} />, on: !!vis.fires, onSelect: () => toggle('fires') },
            ...pluginMenuItems('live'),
          ] },
          { label: 'Scout', items: [
            { key: 'candidates', label: category('candidates').label, swatch: <Swatch cat={category('candidates')} />, on: candidatesOn, title: 'OpenStreetMap viewpoints, ruins and other candidates', onSelect: () => toggle('candidates') },
            { key: 'events', label: category('events').label, swatch: <Swatch cat={category('events')} />, on: !!eventsOn, title: 'Upcoming events from Event Scout that have a location', onSelect: () => toggle('events') },
            { key: 'road-quality', label: category('road-quality').label, swatch: <Swatch cat={category('road-quality')} />, on: !!vis['road-quality'], title: 'OpenStreetMap roads from z13: green good, amber fair, red poor/unpaved, grey unknown. Surface tags are incomplete, so grey and fair are often guesses.', onSelect: () => toggle('road-quality') },
            { key: 'rail', label: category('rail').label, swatch: <Swatch cat={category('rail')} />, on: railOn, onSelect: () => toggle('rail') },
            { key: 'routes', label: category('routes').label, swatch: <Swatch cat={category('routes')} />, on: routesOn, title: 'Show or hide saved routes', onSelect: () => toggle('routes') },
            ...pluginMenuItems('scout'),
          ] },
          ...(user && !editing ? [{ label: '+ Add', items: [
            { key: 'spot', label: 'Spot (pick on map)', onSelect: () => setMode(mode === 'pick-spot' ? 'browse' : 'pick-spot') },
            { key: 'suggest', label: 'Suggest a public spot', title: 'Send a place to the moderators for the public map. Right-click or long-press the map to pick the place', onSelect: () => setSuggestAt({ lat: centre.lat, lng: centre.lng }) },
            { key: 'spot-here', label: 'Spot here', onSelect: () => { setSelected(null); setEditing({ type: 'spot', draft: newSpot(centre.lat, centre.lng) }); } },
            { key: 'route', label: 'Route', onSelect: () => openRouteEdit(blankRouteDraft()) },
            { key: 'place', label: 'Place', onSelect: () => {
              setSelected(null);
              setEditing({ type: 'place', draft: { name: '', notes: '', access: '', visibility: 'private', lat: centre.lat, lng: centre.lng, kind: 'polygon', coords: [] } });
              setMode('draw');
            } },
          ] }] : []),
        ]} />
      </div>
      <div className="sunanchor-controls" role="group" aria-label="Sun anchor controls">
        <button
          type="button"
          className={mode === 'anchor' ? 'active' : ''}
          onClick={toggleSunAnchorPlacement}
        >
          Place anchor
        </button>
        <button
          type="button"
          disabled={!sunAnchor}
          onClick={() => {
            setSunAnchor(null);
            setSunAnchorBearing(null);
            setMode((m) => (m === 'anchor' ? 'browse' : m));
          }}
        >
          Clear
        </button>
        <span>{sunAnchor ? `${sunAnchor.lat.toFixed(5)}, ${sunAnchor.lng.toFixed(5)}` : 'No anchor set'}</span>
      </div>

      {panelOpen && (
        <aside className={`panel panel--${sheetSize}`}>
          <button
            type="button"
            className="panel__handle"
            aria-label={sheetSize === 'half' ? 'Collapse panel' : 'Expand panel'}
            aria-expanded={sheetSize === 'half'}
            onClick={() => setSheetSize((s) => (s === 'half' ? 'peek' : 'half'))}
          >
            <span className="panel__grab" aria-hidden="true" />
          </button>
          <button className="panel__close" onClick={closePanel} title="Close">✕</button>
          {editing?.type === 'spot' && (
            <SpotEditor key={editing.draft.id ?? 'new'} map={map} draft={editing.draft} places={places}
              onChange={(draft) => setEditing({ type: 'spot', draft })} onSave={() => saveSpot(editing.draft)} onCancel={cancelEdit} />
          )}
          {editing?.type === 'route' && (
            <>
            {routeRecovered && <div className="hint" role="status">Recovered your unsaved route draft. <button type="button" className="linkbtn" onClick={() => {
              try { localStorage.removeItem(draftKey(editing.draft.id)); } catch { /* storage may be disabled */ }
              ++routeRequest.current;
              routeHistory.current = { undo: [], redo: [] };
              setRouteHistoryVersion((value) => value + 1);
              routeDraftDirty.current = false;
              setRouteRecovered(false);
              setRouting(false);
              setDuration(null);
              if (routeOriginal.current) {
                routeDraftRef.current = routeOriginal.current;
                setEditing({ type: 'route', draft: routeOriginal.current });
              }
            }}>Discard draft</button></div>}
            <RouteEditor
              draft={editing.draft}
              drawing={mode === 'draw'}
              stagingMode={stagingMode}
              time={time}
              onDrawing={(on) => { setMode(on ? 'draw' : 'browse'); if (on) setStagingMode(false); }}
              onStagingMode={setStagingMode}
              onChange={changeRouteDraft}
              onWaypointsChange={changeRouteWaypoints}
              routingBusy={routeRouting.busy}
              routingError={routeRouting.error}
              onRetryRouting={() => { const draft = routeDraftRef.current; if (draft) calculateRoute(draft); }}
              routeDurationSec={routeDuration}
              onUndo={() => travelHistory('undo')}
              onRedo={() => travelHistory('redo')}
              canUndo={routeHistory.current.undo.length > 0}
              canRedo={routeHistory.current.redo.length > 0}
              onSave={() => saveRoute(editing.draft)}
              onCancel={cancelEdit}
              onDelete={editing.draft.id ? () => void deleteRoute({ ...draftToRoute(editing.draft), id: editing.draft.id, ownerId: '', createdAt: '', updatedAt: '' } as Route) : undefined}
            />
            </>
          )}
          {editing?.type === 'place' && (
            <PlaceEditor draft={editing.draft} drawing={mode === 'draw'} onDrawing={(on) => setMode(on ? 'draw' : 'browse')}
              onChange={(draft) => setEditing({ type: 'place', draft })} onSave={() => savePlace(editing.draft)} onCancel={cancelEdit}
              onDelete={editing.draft.id ? () => void deletePlace(editing.draft.id!) : undefined} />
          )}
          {!editing && sunAnchor && !selectedSpot && (
            <SunBearingPlanner
              lat={sunAnchor.lat}
              lng={sunAnchor.lng}
              defaultBearingDeg={sunAnchorBearing}
              label="Sun anchor plan"
              onApplyTime={setTime}
            />
          )}
          {!editing && selectedSpot && (
            <>
              <SpotPanel spot={selectedSpot} place={places.find((p) => p.id === selectedSpot.placeId)} time={time} fires={fires}
                canEdit={canEdit(selectedSpot.ownerId)}
                onEdit={() => { setEditing({ type: 'spot', draft: { ...selectedSpot } }); focus(selectedSpot.lng, selectedSpot.lat); }}
                onDelete={() => void deleteSpot(selectedSpot)}
                onMove={async (lat, lng) => { await api.updateSpot(selectedSpot.id, { lat, lng }); await reload(); focus(lng, lat); }}
                onCreateSpotAt={(lat, lng) => createSpotAt(lat, lng, selectedSpot.placeId)} />
              <SunBearingPlanner
                lat={selectedSpot.lat}
                lng={selectedSpot.lng}
                defaultBearingDeg={selectedSunBearing}
                label={sunAnchor ? 'Sun anchor plan' : 'Bearing plan'}
                onApplyTime={setTime}
              />
            </>
          )}
          {!editing && selectedPlace && (
            <>
              <h2>{selectedPlace.name}</h2>
              <p className="hint">{placeSpots.length} spot{placeSpots.length === 1 ? '' : 's'} · {selectedPlace.visibility}</p>
              {selectedPlace.notes && <p className="panel__notes">{selectedPlace.notes}</p>}
              {selectedPlace.access && <p className="hint">Access: {selectedPlace.access}</p>}
              <DayStrip lat={selectedPlace.lat} lng={selectedPlace.lng} time={time} />
              <ul className="plainlist">
                {placeSpots.map((s) => (
                  <li key={s.id}><button className="linklike" onClick={() => { setSelected({ type: 'spot', id: s.id }); focus(s.lng, s.lat, Math.max(map?.getZoom() ?? 15, 15)); }}>{s.name}</button>
                    {goodNow(s, time) && <span className="badge-good">Good now</span>}</li>
                ))}
              </ul>
              <div className="panel__actions">
                <Link to={`/places/${selectedPlace.id}`}><button>Place page</button></Link>
                {user && <Link to={`/convoy?to=${selectedPlace.lat},${selectedPlace.lng}&label=${encodeURIComponent(selectedPlace.name)}`}><button>Set convoy destination</button></Link>}
                {canEdit(selectedPlace.ownerId) && <>
                  <button className="primary" onClick={() => setEditing({ type: 'place', draft: placeToDraft(selectedPlace) })}>Edit</button>
                  <button onClick={() => { setSelected(null); setEditing({ type: 'spot', draft: newSpot(selectedPlace.lat, selectedPlace.lng, selectedPlace.id) }); }}>+ Spot in place</button>
                </>}
              </div>
            </>
          )}
          {!editing && selectedRoute && (
            <>
              <h2>{selectedRoute.name}</h2>
              <p className="hint">{selectedRoute.type === 'circuit' ? 'Circuit' : 'Sprint'} · {selectedRoute.waypoints ? `${selectedRoute.waypoints.length} stops` : 'Saved path'} · {routeDistanceKm(selectedRoute.vertices, selectedRoute.type).toFixed(1)} km · {selectedRoute.visibility}</p>
              {selectedRoute.notes && <p className="panel__notes">{selectedRoute.notes}</p>}
              <div className="panel__actions">
                <Link to={`/plan?route=${selectedRoute.id}`}><button>Plan shoot</button></Link>
                {user && <Link to={`/drive?route=${selectedRoute.id}`}><button>Drive it</button></Link>}
                {user && <Link to={`/convoy?route=${selectedRoute.id}`}><button>Share with convoy</button></Link>}
                {canEdit(selectedRoute.ownerId) && <><button className="primary" onClick={() => openRouteEdit(routeToDraft(selectedRoute))}>Edit</button><button className="danger" onClick={() => void deleteRoute(selectedRoute)}>Delete</button></>}
              </div>
            </>
          )}
          {!editing && selectedCandidate && (
            <>
              <h2>{selectedCandidate.name || 'Unnamed candidate'}</h2>
              <p className="hint">OpenStreetMap · {selectedCandidate.source}/{selectedCandidate.ref}</p>
              {Object.keys(selectedCandidate.tags).length > 0 && (
                <div className="chiprow">{Object.entries(selectedCandidate.tags).map(([k, v]) => <span key={k} className="chip">{k}={v}</span>)}</div>
              )}
              {user && <div className="panel__actions"><button className="primary" onClick={() => void promoteCandidate(selectedCandidate)}>Promote to spot</button></div>}
            </>
          )}
        </aside>
      )}

      <PluginSidePanel sheetSize={sheetSize} onToggleSheet={() => setSheetSize((s) => (s === 'half' ? 'peek' : 'half'))} />

      {weatherOn && forecast && (
        <div className="wxpill" role="status" title={wxHour ? `Forecast for the map centre at ${new Date(wxHour.time).toLocaleString()} (Open-Meteo)` : undefined}>
          {wxHour ? (<>
            <span className="wxpill__icon">{weatherIcon(wxHour, wxNight)}</span>
            {wxHour.tempC != null && <strong>{Math.round(wxHour.tempC)}°</strong>}
            <span>☁ {wxHour.cloudPct ?? '–'}%</span>
            <span>💧 {wxHour.precipMm ?? 0} mm{wxHour.precipProbPct != null ? ` · ${wxHour.precipProbPct}%` : ''}</span>
            <span>💨 {wxHour.windKmh != null ? Math.round(wxHour.windKmh) : '–'}{wxHour.gustKmh != null ? `–${Math.round(wxHour.gustKmh)}` : ''} km/h</span>
            {wxHour.fogLikely && <span className="wxpill__warn">fog</span>}
          </>) : <span className="wxpill__muted">No forecast for this time</span>}
          {!radarFrame && <span className="wxpill__muted" title="RainViewer only has the last ~2 hours">· radar n/a at this time</span>}
          {radarFrame?.nowcast && <span className="wxpill__muted">· radar nowcast</span>}
        </div>
      )}
      <TimeBar lat={displayOrigin.lat} lng={displayOrigin.lng} />
    </div>
  );
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function delayText(sec: number): string {
  const min = Math.round(sec / 60);
  if (min === 0) return 'on time';
  return min > 0 ? `${min} min late` : `${-min} min early`;
}

const trainPopup: { current: Popup | null } = { current: null };

/** A small popup for a train marker: route, headsign, live/estimated and delay, and a Follow button. */
function showTrainPopup(map: MlMap, f: GeoJSON.Feature, onFollow?: (id: string) => void) {
  const p = (f.properties ?? {}) as { id?: string; route?: string; headsign?: string; serviceName?: string; status?: string; delaySec?: number };
  const live = p.status === 'live';
  const html = `<strong>${escapeHtml(p.serviceName || p.route || 'Train')}</strong>${!p.serviceName && p.headsign ? ` → ${escapeHtml(p.headsign)}` : ''}<br/>`
    + `<span>${live ? '● Live position' : '○ Scheduled estimate'} · ${delayText(Number(p.delaySec ?? 0))}</span>`
    + (onFollow && p.id ? '<br/><button class="popup-follow" type="button">Follow</button>' : '');
  openPopup(map, (f.geometry as GeoJSON.Point).coordinates as [number, number], html, onFollow && p.id ? () => onFollow(p.id!) : undefined);
}

function buildPlanePopupHtml(p: Plane, info?: PlaneInfo | null): string {
  const alt = p.alt_baro == null ? '' : p.alt_baro <= 0 ? ' · ground' : ` · ${Math.round((p.alt_baro * 0.3048) / 10) * 10} m`;
  const details = info ? formatPlaneDetails(info) : null;
  return `<strong>${escapeHtml(planeName(p))}</strong>${p.t && (!details || !info?.type) ? ` <span>${escapeHtml(p.t)}</span>` : ''}<br/>`
    + (details ? `<span>${escapeHtml(details)}</span><br/>` : '')
    + `<span>${p.gs != null ? `${Math.round(p.gs * 1.852)} km/h` : 'speed –'}${alt}</span>`
    + '<br/><button class="popup-follow" type="button">Follow</button>';
}

/** Popup for a clicked plane: callsign, enriched info (adsbdb), altitude and speed, and a Follow button. */
function showPlanePopup(map: MlMap, p: Plane, onFollow: (hex: string) => void) {
  const popup = openPopup(map, [p.lon, p.lat], buildPlanePopupHtml(p), () => onFollow(p.hex));
  api.planeInfo(p.hex, p.flight || undefined)
    .then((info) => {
      if (trainPopup.current === popup && popup.isOpen()) {
        popup.setHTML(buildPlanePopupHtml(p, info));
        popup.getElement()?.querySelector('.popup-follow')?.addEventListener('click', () => { popup.remove(); onFollow(p.hex); });
      }
    })
    .catch(() => {});
}

function showRailPassPopup(map: MlMap, lat: number, lng: number) {
  const popup = openPopup(map, [lng, lat], '<div role="status" aria-live="polite"><strong>Passenger trains</strong><br/><span>Loading passes…</span></div>');
  api.trainPassesAt(lat, lng, 6)
    .then((result) => {
      if (trainPopup.current === popup) popup.setHTML(buildRailPassPopupHtml(result));
    })
    .catch((err) => {
      if (trainPopup.current === popup) popup.setHTML(`<div role="alert"><strong>Passenger trains</strong><br/><span>${escapeHtml((err as Error).message)}</span></div>`);
    });
}

/** Popup for a clicked event: what and when and where, and a button for the rest. */
function showEventPopup(map: MlMap, at: [number, number], ev: EventItem, onOpen: () => void) {
  const place = decodeEntities(ev.venueName || ev.address || ev.locality);
  const html = `<strong>${escapeHtml(decodeEntities(ev.title))}</strong><br/><span>${escapeHtml(formatWhen(ev))}</span>`
    + (ev.community ? '<br/><span>👥 Community event</span>' : '')
    + (place ? `<br/><span>📍 ${escapeHtml(place)}</span>` : '')
    + '<br/><button class="popup-follow" type="button">Details</button>';
  openPopup(map, at, html, onOpen);
}

function showFirePopup(map: MlMap, at: [number, number], p: Record<string, any>) {
  const title = escapeHtml(String(p.title || 'Fire Incident'));
  const cat = escapeHtml(String(p.category || ''));
  const status = escapeHtml(String(p.status || ''));
  const size = p.sizeHa != null ? ` · ${p.sizeHa} ha` : '';
  const link = p.link ? `<br/><a href="${escapeHtml(String(p.link))}" target="_blank" rel="noopener noreferrer">RFS incident details</a>` : '';
  const html = `<strong>${title}</strong>${cat ? ` · <span>${cat}</span>` : ''}<br/>`
    + (status ? `<span>Status: ${status}${size}</span>` : '')
    + link;
  openPopup(map, at, html);
}

/** Map control: fly back to the instance's home (Settings), read on each click so an edited home applies at once. */
function homeControl() {
  const el = document.createElement('div');
  el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  el.innerHTML = `<button type="button" title="Home" aria-label="Fly to home"><svg viewBox="0 0 24 24" width="18" height="18" style="margin:auto;display:block" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg></button>`;
  return {
    onAdd(map: MlMap) {
      el.querySelector('button')!.onclick = () => {
        api.settings().then((s) => map.flyTo({ center: [s.home.lng, s.home.lat], zoom: 10, bearing: 0, pitch: 0 })).catch(() => {});
      };
      return el;
    },
    onRemove() { el.remove(); },
  };
}

function showRoadPopup(map: MlMap, at: [number, number], p: Record<string, any>) {
  const e = (v: unknown) => escapeHtml(String(v));
  // GeoJSON feature properties round-trip nulls as the string "null" from queryRenderedFeatures
  const has = (v: unknown) => v != null && v !== '' && v !== 'null';
  const rows = [['Surface', p.surface], ['Smoothness', p.smoothness], ['Speed', has(p.maxspeed) ? `${p.maxspeed} km/h` : ''], ['Lanes', has(p.lanes) ? p.lanes : '']]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${e(v)}`);
  openPopup(map, at, `<strong>${e(p.name || p.highway || 'Road')}</strong> · <span>${e(p.grade)}</span>${rows.length ? `<br/><span>${rows.join(' · ')}</span>` : ''}`);
}

function showCameraPopup(map: MlMap, at: [number, number], p: Record<string, any>) {
  const id = String(p.id ?? '');
  const title = escapeHtml(String(p.title || 'Traffic camera'));
  const direction = p.direction ? escapeHtml(String(p.direction)) : '';
  const view = p.view ? escapeHtml(String(p.view)) : '';
  const rawUrl = String(p.imageUrl || '');
  const t = Date.now();
  const directUrl = rawUrl ? (rawUrl.includes('?') ? `${rawUrl}&t=${t}` : `${rawUrl}?t=${t}`) : '';
  const proxyUrl = id ? `/api/cameras/${encodeURIComponent(id)}/image?t=${t}` : '';
  const imgUrl = directUrl || proxyUrl;
  const fallbackAttr = proxyUrl && directUrl ? ` onerror="if(this.src!=='${escapeHtml(proxyUrl)}'){this.src='${escapeHtml(proxyUrl)}';}"` : '';

  const html = `<div class="camera-popup">`
    + (imgUrl ? `<div style="margin-bottom:6px;"><img src="${escapeHtml(imgUrl)}"${fallbackAttr} alt="${title}" title="Click to enlarge" style="width:100%;max-width:320px;height:auto;border-radius:4px;display:block;background:#171a21;cursor:zoom-in;" loading="lazy" /></div>` : '')
    + `<strong>${title}</strong>`
    + (direction ? ` <span>(${direction})</span>` : '')
    + (view && view !== title ? `<br/><span style="font-size:11px;color:#8a93a6;">${view}</span>` : '')
    + `</div>`;
  const popup = openPopup(map, at, html);
  const img = popup.getElement()?.querySelector<HTMLImageElement>('.camera-popup img');
  img?.addEventListener('click', () => openCameraLightbox(img.currentSrc || img.src, img.alt));
}

/** Full-screen view of a camera frame, reusing the photo lightbox styles. Click, ✕ or Escape closes. */
function openCameraLightbox(src: string, caption: string) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', caption);
  box.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}" /><div class="lightbox__caption">${escapeHtml(caption)}</div>`
    + `<button type="button" class="lightbox__close" aria-label="Close">✕</button>`;
  const close = () => { box.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', close);
  window.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  box.querySelector('button')?.focus();
}

function openPopup(map: MlMap, at: [number, number], html: string, onFollow?: () => void) {
  trainPopup.current?.remove();
  const popup = new Popup({ closeButton: true, offset: 10 }).setLngLat(at).setHTML(html).addTo(map);
  popup.getElement()?.querySelector('.popup-follow')?.addEventListener('click', () => { popup.remove(); onFollow?.(); });
  trainPopup.current = popup;
  return popup;
}
