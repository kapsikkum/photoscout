import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirCurrentsOverlay } from '../src/map/airCurrents.js';

test('air currents animate while weather is visible and stop cleanly when hidden', () => {
  const scheduled: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  const clears: Array<[number, number, number, number]> = [];
  const context = {
    clearRect: (...args: [number, number, number, number]) => clears.push(args),
    setTransform: () => {}, scale: () => {}, save: () => {}, restore: () => {}, fillRect: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, arc: () => {}, fill: () => {}, fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
  } as unknown as CanvasRenderingContext2D;
  const canvas = { className: '', style: {}, width: 0, height: 0, setAttribute: () => {}, remove: () => {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const listeners = new Map<string, EventListener>();
  (globalThis as { document: Document }).document = {
    hidden: false,
    createElement: () => canvas,
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Document;
  (globalThis as { window: Window }).window = { devicePixelRatio: 1 } as Window;
  (globalThis as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame = (frame) => { scheduled.push(frame); return scheduled.length; };
  (globalThis as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame = (id) => { cancelled.push(id); };

  const map = {
    getContainer: () => ({ clientWidth: 800, clientHeight: 500, appendChild: () => {} }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 500 }),
    getBounds: () => ({ getWest: () => 149, getEast: () => 151, getSouth: () => -34, getNorth: () => -32 }),
    getBearing: () => 0, isMoving: () => false, project: () => ({ x: 400, y: 250 }), on: () => {}, off: () => {},
  };

  const overlay = new AirCurrentsOverlay(map as never);
  overlay.update({ visible: true, windKmh: 25, windDeg: 180 });
  assert.equal(scheduled.length, 1, 'visible weather starts a particle animation frame');

  overlay.update({ visible: false });
  assert.deepEqual(cancelled, [1], 'hiding weather cancels the animation frame');
  assert.ok(clears.length > 0, 'hiding weather clears its canvas');
  overlay.destroy();
});
