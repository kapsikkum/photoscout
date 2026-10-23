import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachKeyboardNudge,
  attachRotationHandle,
  type Coordinate,
  createMapProjectionAdapter,
  closeSunAnchorTool,
  createSunAnchorElement,
  handleSunAnchorPlacementClick,
  startSunAnchorTool,
  type MapProjectionAdapter,
  nudgeAnchor,
  pointToBearing,
  resolveDisplayOrigin,
  resolveSunPlannerBearing,
  shouldShowSunPlanner,
  shouldShowSunLayer,
  type ScreenPixel,
  normalizeAnchorBearing,
  selectedBearingProjectionGeoJSON,
  SUN_ANCHOR_BEARING_SHIFT_STEP_DEG,
  SUN_ANCHOR_BEARING_STEP_DEG,
  SUN_ANCHOR_SHIFT_STEP_PX,
  SUN_ANCHOR_STEP_PX,
  SunAnchorController,
  updateSelectedBearingProjection,
} from '../src/map/sunAnchor.js';
import { bearing, haversineKm } from '../src/map/geo.js';

test('resolveDisplayOrigin: anchor wins over draft, selected spot, and viewport centre', () => {
  const anchor = { lat: 10, lng: 20 };
  const draft = { lat: 30, lng: 40 };
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: anchor,
    spotDraft: draft,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, anchor);
});

test('resolveDisplayOrigin: draft wins over selected spot and viewport centre when no anchor exists', () => {
  const draft = { lat: 30, lng: 40 };
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: draft,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, draft);
});

test('resolveDisplayOrigin: selected spot wins over viewport centre when no anchor or draft exists', () => {
  const selected = { lat: 50, lng: 60 };
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: null,
    selectedSpot: selected,
    viewportCentre: centre,
  });

  assert.deepEqual(result, selected);
});

test('resolveDisplayOrigin: viewport centre is the final fallback', () => {
  const centre = { lat: 70, lng: 80 };

  const result = resolveDisplayOrigin({
    sunAnchor: null,
    spotDraft: null,
    selectedSpot: null,
    viewportCentre: centre,
  });

  assert.deepEqual(result, centre);
});

test('resolveSunPlannerBearing: anchor bearing wins over saved spot facing, otherwise facing is used', () => {
  const spot = { lat: 0, lng: 0, facingDeg: 123 };

  assert.equal(resolveSunPlannerBearing(spot, { lat: 0, lng: 1 }, 278.4), 278.4);
  assert.equal(resolveSunPlannerBearing(spot, null), 123);
  assert.equal(resolveSunPlannerBearing({ ...spot, facingDeg: null }, null), null);
});

test('normalizeAnchorBearing: constrains finite bearings to 0-359.9 at one decimal place', () => {
  assert.equal(normalizeAnchorBearing(0), 0);
  assert.equal(normalizeAnchorBearing(359.94), 359.9);
  assert.equal(normalizeAnchorBearing(359.95), 359.9);
  assert.equal(normalizeAnchorBearing(721.26), 1.3);
  assert.equal(normalizeAnchorBearing(-0.05), 359.9);
  assert.equal(normalizeAnchorBearing(-90), 270);
  assert.equal(normalizeAnchorBearing(Number.NaN), 0);
});

test('pointToBearing: converts screen points around a center into compass bearing', () => {
  const center = { x: 100, y: 100 };

  assert.equal(pointToBearing(center, { x: 100, y: 50 }), 0);
  assert.equal(pointToBearing(center, { x: 150, y: 100 }), 90);
  assert.equal(pointToBearing(center, { x: 100, y: 150 }), 180);
  assert.equal(pointToBearing(center, { x: 50, y: 100 }), 270);
  assert.equal(pointToBearing(center, { x: 150, y: 50 }), 45);
});

test('shouldShowSunPlanner: an anchor can be planned without selecting a saved spot', () => {
  assert.equal(shouldShowSunPlanner({ lat: -33.4, lng: 149.5 }, null), true);
  assert.equal(shouldShowSunPlanner(null, { lat: -33.4, lng: 149.5 }), true);
  assert.equal(shouldShowSunPlanner(null, null), false);
});

test('sun anchor tool: enables the sun overlay and closes back to a clean browse state', () => {
  const visibility = { sun: false, spots: true, terrain: false };

  assert.deepEqual(startSunAnchorTool(visibility), { sun: true, spots: true, terrain: false });
  assert.deepEqual(visibility, { sun: false, spots: true, terrain: false }, 'does not mutate saved overlay choices');
  assert.deepEqual(closeSunAnchorTool(), { anchor: null, bearing: null, mode: 'browse' });
});

test('sun layer follows the compact time controls unless an anchor needs it', () => {
  const anchor = { lat: -33.4, lng: 149.5 };

  assert.equal(shouldShowSunLayer(true, null), true, 'expanded controls show the rays and wedges');
  assert.equal(shouldShowSunLayer(false, null), false, 'minimised controls hide them without an anchor');
  assert.equal(shouldShowSunLayer(false, anchor), true, 'an active anchor keeps them visible');
});

test('selectedBearingProjectionGeoJSON: starts at anchor and projects along chosen compass bearing', () => {
  const anchor = { lat: -33.419, lng: 149.577 };
  const fc = selectedBearingProjectionGeoJSON(anchor, 90, 2);

  assert.equal(fc.features.length, 1);
  const line = fc.features[0].geometry as GeoJSON.LineString;
  assert.deepEqual(line.coordinates[0], [anchor.lng, anchor.lat]);
  assert.equal(fc.features[0].properties?.kind, 'selected-bearing');
  assert.ok(Math.abs(haversineKm(anchor.lat, anchor.lng, line.coordinates[1][1], line.coordinates[1][0]) - 2) < 0.01);
  assert.ok(Math.abs(bearing(anchor.lat, anchor.lng, line.coordinates[1][1], line.coordinates[1][0]) - 90) < 0.1);
});

test('selectedBearingProjectionGeoJSON: hides line unless both anchor and bearing are active', () => {
  assert.deepEqual(selectedBearingProjectionGeoJSON(null, 90, 2).features, []);
  assert.deepEqual(selectedBearingProjectionGeoJSON({ lat: 1, lng: 2 }, null, 2).features, []);
  assert.deepEqual(selectedBearingProjectionGeoJSON({ lat: 1, lng: 2 }, Number.NaN, 2).features, []);
});

test('updateSelectedBearingProjection: updates and clears through an injectable MapLibre-like source seam', () => {
  const updates: GeoJSON.FeatureCollection[] = [];
  const mockMap = {
    getCenter: () => ({ lat: -33.419, lng: 149.577 }),
    getZoom: () => 15,
    getSource: (id: string) => id === 'selected-bearing-projection'
      ? { setData: (fc: GeoJSON.FeatureCollection) => updates.push(fc) }
      : undefined,
  };

  updateSelectedBearingProjection(mockMap, { lat: -33.419, lng: 149.577 }, 180);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].features.length, 1);
  const firstLine = updates[0].features[0].geometry as GeoJSON.LineString;
  assert.deepEqual(firstLine.coordinates[0], [149.577, -33.419]);
  assert.ok(bearing(-33.419, 149.577, firstLine.coordinates[1][1], firstLine.coordinates[1][0]) > 179.9);

  updateSelectedBearingProjection(mockMap, null, 180);
  updateSelectedBearingProjection(mockMap, { lat: -33.419, lng: 149.577 }, null);
  assert.deepEqual(updates[1].features, []);
  assert.deepEqual(updates[2].features, []);
});

test('nudgeAnchor: uses injected projection adapter project and unproject operations', () => {
  let projectCalledWith: Coordinate | null = null;
  let unprojectCalledWith: ScreenPixel | null = null;

  const spyAdapter: MapProjectionAdapter = {
    project(coord) {
      projectCalledWith = coord;
      return { x: 200, y: 300 };
    },
    unproject(pixel) {
      unprojectCalledWith = pixel;
      return { lat: 12.34, lng: 56.78 };
    },
  };

  const current = { lat: 10, lng: 20 };
  const result = nudgeAnchor(current, 'ArrowUp', spyAdapter);

  assert.deepEqual(projectCalledWith, current, 'project must be called with current coordinate');
  assert.deepEqual(unprojectCalledWith, { x: 200, y: 300 - SUN_ANCHOR_STEP_PX }, 'unproject must be called with 1px adjusted screen pixel');
  assert.deepEqual(result, { lat: 12.34, lng: 56.78 }, 'result must be the coordinate returned from unproject');
});

test('nudgeAnchor: direction is correct in screen pixel coordinates (Up=-Y, Down=+Y, Left=-X, Right=+X)', () => {
  const unprojectCalls: ScreenPixel[] = [];
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => {
      unprojectCalls.push(pixel);
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: 0, lng: 0 };

  // Up: screen Y decreases
  nudgeAnchor(current, 'ArrowUp', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 500, y: 499 });

  // Down: screen Y increases
  nudgeAnchor(current, 'ArrowDown', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 500, y: 501 });

  // Left: screen X decreases
  nudgeAnchor(current, 'ArrowLeft', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 499, y: 500 });

  // Right: screen X increases
  nudgeAnchor(current, 'ArrowRight', adapter);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 501, y: 500 });
});

test('nudgeAnchor: Shift modifier uses 10px step while default nudge uses 1px step', () => {
  const unprojectCalls: ScreenPixel[] = [];
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 100, y: 100 }),
    unproject: (pixel) => {
      unprojectCalls.push(pixel);
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: 0, lng: 0 };

  // Without Shift: 1px
  nudgeAnchor(current, 'ArrowUp', adapter, false);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 - SUN_ANCHOR_STEP_PX });

  // With Shift (boolean true): 10px
  nudgeAnchor(current, 'ArrowUp', adapter, true);
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 - SUN_ANCHOR_SHIFT_STEP_PX });

  // With Shift in options object: 10px
  nudgeAnchor(current, 'ArrowRight', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100 + SUN_ANCHOR_SHIFT_STEP_PX, y: 100 });

  // With Shift in options object for ArrowDown and ArrowLeft
  nudgeAnchor(current, 'ArrowDown', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100, y: 100 + SUN_ANCHOR_SHIFT_STEP_PX });

  nudgeAnchor(current, 'ArrowLeft', adapter, { shiftKey: true });
  assert.deepEqual(unprojectCalls[unprojectCalls.length - 1], { x: 100 - SUN_ANCHOR_SHIFT_STEP_PX, y: 100 });
});

test('nudgeAnchor: geographic movement adapts to projection scale and zoom level', () => {
  // Zoom 10 simulation: 1px = 0.001 degrees
  const lowZoomAdapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => ({
      lat: (500 - pixel.y) * 0.001,
      lng: (pixel.x - 500) * 0.001,
    }),
  };

  // Zoom 15 simulation: 1px = 0.00003 degrees (~33x higher zoom)
  const highZoomAdapter: MapProjectionAdapter = {
    project: () => ({ x: 500, y: 500 }),
    unproject: (pixel) => ({
      lat: (500 - pixel.y) * 0.00003,
      lng: (pixel.x - 500) * 0.00003,
    }),
  };

  const current = { lat: 0, lng: 0 };
  const lowZoomResult = nudgeAnchor(current, 'ArrowUp', lowZoomAdapter);
  const highZoomResult = nudgeAnchor(current, 'ArrowUp', highZoomAdapter);

  // Both moved by 1 screen pixel, but geographic lat change scales with the zoom adapter
  assert.equal(lowZoomResult.lat, 0.001);
  assert.equal(highZoomResult.lat, 0.00003);
  assert.ok(
    highZoomResult.lat < lowZoomResult.lat,
    'high zoom geographic movement per pixel must be smaller than low zoom',
  );
});

test('nudgeAnchor: non-arrow key does not move anchor and does not invoke unproject', () => {
  let unprojectInvoked = false;
  const adapter: MapProjectionAdapter = {
    project: () => ({ x: 100, y: 100 }),
    unproject: (pixel) => {
      unprojectInvoked = true;
      return { lat: pixel.y, lng: pixel.x };
    },
  };

  const current = { lat: -33.419, lng: 149.577 };
  const enterResult = nudgeAnchor(current, 'Enter', adapter);
  assert.deepEqual(enterResult, current);
  assert.equal(unprojectInvoked, false);

  const tabResult = nudgeAnchor(current, 'Tab', adapter);
  assert.deepEqual(tabResult, current);
  assert.equal(unprojectInvoked, false);
});

test('handleSunAnchorPlacementClick: consumes click and exits placement mode when mode is anchor', () => {
  const click = handleSunAnchorPlacementClick('anchor', { lat: -33.42, lng: 149.58 });
  assert.equal(click.consumed, true);
  assert.deepEqual(click.newAnchor, { lat: -33.42, lng: 149.58 });
  assert.equal(click.nextMode, 'browse');
});

test('handleSunAnchorPlacementClick: does not consume click when mode is browse or pick-spot', () => {
  const browseClick = handleSunAnchorPlacementClick('browse', { lat: -33.42, lng: 149.58 });
  assert.equal(browseClick.consumed, false);
  assert.equal(browseClick.newAnchor, undefined);

  const spotClick = handleSunAnchorPlacementClick('pick-spot', { lat: -33.42, lng: 149.58 });
  assert.equal(spotClick.consumed, false);
});

test('attachKeyboardNudge: handles 1px arrow keys, 10px with Shift, and stops propagation', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const mockEl = {
    addEventListener: (event: string, handler: (e: any) => void) => { listeners[event] = handler; },
    removeEventListener: (event: string, _handler: (e: any) => void) => { delete listeners[event]; },
  };

  let current = { lat: 10, lng: 20 };
  let moved: Coordinate | null = null;
  const mockProjection: MapProjectionAdapter = {
    project: (_c) => ({ x: 100, y: 100 }),
    unproject: (p) => ({ lat: p.y, lng: p.x }),
  };

  const teardown = attachKeyboardNudge(
    mockEl,
    () => current,
    (next) => { moved = next; },
    mockProjection,
  );

  // 1. ArrowUp without Shift -> 1px step (y = 100 - 1 = 99)
  let prevented = false;
  let stopped = false;
  listeners['keydown']({
    key: 'ArrowUp',
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true, 'preventDefault must be called');
  assert.equal(stopped, true, 'stopPropagation must be called so map does not pan');
  assert.deepEqual(moved, { lat: 99, lng: 100 });

  // 2. ArrowRight with Shift -> 10px step (x = 100 + 10 = 110)
  prevented = false;
  stopped = false;
  moved = null;
  listeners['keydown']({
    key: 'ArrowRight',
    shiftKey: true,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(moved, { lat: 100, lng: 110 });

  // 3. Non-arrow key does not prevent, stop, or move
  prevented = false;
  stopped = false;
  moved = null;
  listeners['keydown']({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, false);
  assert.equal(stopped, false);
  assert.equal(moved, null);

  teardown();
  assert.equal(listeners['keydown'], undefined);
});

test('attachRotationHandle: pointer drag updates bearing and stops marker/map gestures', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const windowListeners: Record<string, (e: any) => void> = {};
  const mockHandle = {
    addEventListener: (event: string, handler: (e: any) => void) => { listeners[event] = handler; },
    removeEventListener: (event: string, _handler: (e: any) => void) => { delete listeners[event]; },
    setPointerCapture: (_id: number) => {},
    releasePointerCapture: (_id: number) => {},
  };

  const origWindow = (globalThis as any).window;
  (globalThis as any).window = {
    addEventListener: (event: string, handler: (e: any) => void) => { windowListeners[event] = handler; },
    removeEventListener: (event: string, _handler: (e: any) => void) => { delete windowListeners[event]; },
  };

  const bearings: number[] = [];
  try {
    const teardown = attachRotationHandle(
      mockHandle,
      () => ({ x: 100, y: 100 }),
      (bearing) => bearings.push(bearing),
    );

    let prevented = false;
    let stopped = false;
    listeners['pointerdown']({
      button: 0,
      pointerId: 7,
      clientX: 150,
      clientY: 100,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.deepEqual(bearings, [90]);

    windowListeners['pointermove']({
      pointerId: 7,
      clientX: 100,
      clientY: 150,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    assert.deepEqual(bearings, [90, 180]);

    windowListeners['pointerup']({ pointerId: 7 });
    windowListeners['pointermove']({
      pointerId: 7,
      clientX: 50,
      clientY: 100,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    assert.deepEqual(bearings, [90, 180], 'pointermove after pointerup must not keep rotating');

    teardown();
    assert.equal(listeners['pointerdown'], undefined);
    assert.equal(windowListeners['pointermove'], undefined);
    assert.equal(windowListeners['pointerup'], undefined);
  } finally {
    (globalThis as any).window = origWindow;
  }
});

test('attachRotationHandle: left/right keys adjust bearing, update ARIA, and stop propagation', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const attrs: Record<string, string> = {};
  const mockHandle = {
    addEventListener: (event: string, handler: (e: any) => void) => { listeners[event] = handler; },
    removeEventListener: (event: string, _handler: (e: any) => void) => { delete listeners[event]; },
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
  };
  let bearing = 359.5;
  const teardown = attachRotationHandle(
    mockHandle,
    () => ({ x: 0, y: 0 }),
    (next) => { bearing = next; },
    () => bearing,
  );

  let prevented = false;
  let stopped = false;
  listeners['keydown']({
    key: 'ArrowRight',
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(bearing, normalizeAnchorBearing(359.5 + SUN_ANCHOR_BEARING_STEP_DEG));
  assert.equal(attrs['aria-valuenow'], String(bearing));
  assert.equal(attrs['aria-valuetext'], `${bearing.toFixed(1)} degrees`);

  listeners['keydown']({
    key: 'ArrowLeft',
    shiftKey: true,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(bearing, normalizeAnchorBearing(0.5 - SUN_ANCHOR_BEARING_SHIFT_STEP_DEG));

  teardown();
  assert.equal(listeners['keydown'], undefined);
});

test('createMapProjectionAdapter: delegates project and unproject to MapLibre map', () => {
  let projectArg: any = null;
  let unprojectArg: any = null;
  const mockMap = {
    project: (ll: any) => {
      projectArg = ll;
      return { x: 42, y: 84 };
    },
    unproject: (pt: any) => {
      unprojectArg = pt;
      return { lat: -33.5, lng: 150.1 };
    },
  };

  const adapter = createMapProjectionAdapter(mockMap as any);
  const pixel = adapter.project({ lat: -33.4, lng: 149.5 });
  assert.deepEqual(pixel, { x: 42, y: 84 });
  assert.deepEqual(projectArg, [149.5, -33.4]);

  const coord = adapter.unproject({ x: 10, y: 20 });
  assert.deepEqual(coord, { lat: -33.5, lng: 150.1 });
  assert.deepEqual(unprojectArg, [10, 20]);
});

test('SunAnchorController: manages marker lifecycle through adapter and forwards projection/bearing callback', () => {
  let createdOptions: any = null;
  let setLngLatCalledWith: any = null;
  let setBearingCalledWith: any = null;
  let removed = false;

  const mockHandle = {
    setLngLat: (c: any) => { setLngLatCalledWith = c; },
    setBearing: (b: any) => { setBearingCalledWith = b; },
    remove: () => { removed = true; },
  };

  const mockAdapter = {
    create: (options: any) => {
      createdOptions = options;
      return mockHandle;
    },
  };

  const mockProjection: MapProjectionAdapter = {
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lat: 0, lng: 0 }),
  };

  const controller = new SunAnchorController(mockAdapter as any);
  const mockMap = {} as any;
  let anchor: { lat: number; lng: number } | null = { lat: -33.419, lng: 149.577 };
  const onMove = (_c: any) => {};
  const onBearingChange = (_b: number) => {};

  // 1. Initial sync with map and anchor creates marker and forwards projection
  controller.sync(mockMap, anchor, onMove, mockProjection, 12.3, onBearingChange);
  assert.ok(createdOptions);
  assert.equal(createdOptions.map, mockMap);
  assert.deepEqual(createdOptions.coord, anchor);
  assert.equal(createdOptions.projection, mockProjection);
  assert.equal(createdOptions.bearingDeg, 12.3);
  assert.equal(createdOptions.onBearingChange, onBearingChange);
  assert.equal(controller.getHandle(), mockHandle);

  // 2. Sync with updated coordinates/bearing calls setters
  anchor = { lat: -33.42, lng: 149.58 };
  controller.sync(mockMap, anchor, onMove, undefined, 45.6, onBearingChange);
  assert.deepEqual(setLngLatCalledWith, anchor);
  assert.equal(setBearingCalledWith, 45.6);
  assert.equal(removed, false);

  // 3. Sync with null anchor removes marker and clears handle
  controller.sync(mockMap, null, onMove);
  assert.equal(removed, true);
  assert.equal(controller.getHandle(), null);

  // 4. Destroy cleans up if handle was active
  removed = false;
  controller.sync(mockMap, { lat: 1, lng: 2 }, onMove);
  assert.ok(controller.getHandle());
  controller.destroy();
  assert.equal(removed, true);
  assert.equal(controller.getHandle(), null);
});

test('createSunAnchorElement: includes accessible crosshair and rotation handle/dial', () => {
  const created: any[] = [];
  const mockDoc = {
    createElement: (tag: string) => {
      const attrs: Record<string, string> = {};
      const children: any[] = [];
      const el = {
      tagName: tag,
      className: '',
      title: '',
      innerHTML: '',
      type: '',
      children,
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      getAttribute: (name: string) => attrs[name],
      append: (...els: any[]) => { children.push(...els); },
      querySelector: (selector: string) => children.find((child) => child.className === selector.slice(1)) ?? null,
      };
      created.push(el);
      return el;
    },
  };

  const origDoc = (globalThis as any).document;
  (globalThis as any).document = mockDoc;
  try {
    const el = createSunAnchorElement() as any;
    assert.equal(el.className, 'sun-anchor-crosshair');
    assert.equal(el.getAttribute('role'), 'button');
    assert.equal(el.getAttribute('tabindex'), '0');
    assert.equal(el.getAttribute('aria-label'), 'Sun anchor crosshair');
    assert.ok(el.getAttribute('aria-description')?.includes('arrow keys'));
    assert.ok(el.getAttribute('aria-description')?.includes('Shift'));
    assert.ok(el.getAttribute('aria-description')?.includes('10px'));
    assert.ok(el.title?.includes('arrow keys'));
    assert.ok(el.title?.includes('Shift'));
    assert.ok(el.title?.includes('10px'));
    const handle = el.querySelector('.sun-anchor-bearing');
    assert.ok(handle);
    assert.equal(handle.getAttribute('role'), 'slider');
    assert.equal(handle.getAttribute('aria-valuemin'), '0');
    assert.equal(handle.getAttribute('aria-valuemax'), '359.9');
    assert.equal(handle.getAttribute('aria-label'), 'Sun anchor bearing');
    assert.equal(created.length, 3);
  } finally {
    (globalThis as any).document = origDoc;
  }
});

test('sun anchor workflow: placement, selection preservation, origin precedence, and clear follow-camera', () => {
  // Simulate MapPage state model
  let mode: 'browse' | 'pick-spot' | 'draw' | 'anchor' = 'browse';
  let sunAnchor: { lat: number; lng: number } | null = null;
  let sunAnchorBearing: number | null = null;
  let selectedSpot: { lat: number; lng: number } | null = null;
  let spotDraft: { lat: number; lng: number } | null = null;
  let centre = { lat: -33.419, lng: 149.577 };

  const getOrigin = () => resolveDisplayOrigin({ sunAnchor, spotDraft, selectedSpot, viewportCentre: centre });

  // 1. Initially, display origin follows viewport centre
  assert.deepEqual(getOrigin(), centre);

  // 2. Select a spot -> origin follows selected spot
  selectedSpot = { lat: -33.5, lng: 150.0 };
  assert.deepEqual(getOrigin(), selectedSpot);

  // 3. Enter placement mode
  mode = (mode as string) === 'anchor' ? 'browse' : 'anchor';
  assert.equal(mode, 'anchor');



  // 4. Map click in placement mode
  const clickCoord = { lat: -33.45, lng: 149.65 };
  const clickResult = handleSunAnchorPlacementClick(mode, clickCoord);
  assert.equal(clickResult.consumed, true);
  if (clickResult.consumed && clickResult.newAnchor) {
    sunAnchor = clickResult.newAnchor;
    sunAnchorBearing = 0;
    mode = clickResult.nextMode ?? 'browse';
  }
  assert.equal(mode, 'browse');
  assert.deepEqual(sunAnchor, clickCoord);
  assert.equal(sunAnchorBearing, 0);

  // 5. Selected spot remains unchanged!
  assert.deepEqual(selectedSpot, { lat: -33.5, lng: 150.0 });

  // 6. Display origin is now the sun anchor (anchor overrides selected spot)
  assert.deepEqual(getOrigin(), sunAnchor);

  // 7. Panning camera changes viewport centre, but display origin stays at anchor
  centre = { lat: -33.6, lng: 150.2 };
  assert.deepEqual(getOrigin(), sunAnchor);

  // 8. Editing a spot: spotDraft exists, but anchor still wins over draft
  spotDraft = { lat: -33.48, lng: 149.6 };
  assert.deepEqual(getOrigin(), sunAnchor);

  // 9. Dragging the anchor updates sunAnchor and display origin
  const draggedCoord = { lat: -33.46, lng: 149.66 };
  sunAnchor = draggedCoord;
  sunAnchorBearing = 123.4;
  assert.deepEqual(getOrigin(), draggedCoord);

  // 10. Clear anchor / follow camera restores draft (or selected spot) and resets in-memory bearing
  sunAnchor = null;
  sunAnchorBearing = null;
  assert.deepEqual(getOrigin(), spotDraft);
  assert.equal(sunAnchorBearing, null);

  // Cancel edit -> restores selected spot
  spotDraft = null;
  assert.deepEqual(getOrigin(), selectedSpot);

  // Deselect spot -> falls back to current viewport centre
  selectedSpot = null;
  assert.deepEqual(getOrigin(), centre);
});
