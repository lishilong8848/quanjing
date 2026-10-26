import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  countAt,
  getTourFrame,
  roundedRoutePath,
  advanceCarousel,
} from '../../client/src/pages/NantongBaseHome/motion';

import { createCampusAnimation } from '../../client/src/pages/NantongBaseHome/campus-animation';
import {
  SYSTEMS,
  type CampusStop,
} from '../../client/src/pages/NantongBaseHome/portal-data';

const portalIndexSource = readFileSync(
  join(process.cwd(), 'client/src/pages/NantongBaseHome/index.tsx'),
  'utf8',
);
const portalTourSource = readFileSync(
  join(process.cwd(), 'client/src/pages/NantongBaseHome/CampusTour.tsx'),
  'utf8',
);
const portalCssSource = readFileSync(
  join(process.cwd(), 'client/src/pages/NantongBaseHome/portal.css'),
  'utf8',
);

const portalAssetDirectory = join(
  process.cwd(),
  'client/public/portal/vnet-photo-20260909',
);

const fieldPhotoFiles = [
  'field-ups.jpg',
  'field-generator-paralleling-cabinet.jpg',
  'field-generator-paralleling-system.jpg',
  'field-humidifier.jpg',
  'field-non-negative-pressure-makeup.jpg',
  'field-side-stream-filter.jpg',
  'field-water-treatment-dosing.jpg',
  'field-network-switch.jpg',
  'field-ddc-control-cabinet.jpg',
  'field-valve-control-cabinet.jpg',
  'field-water-mist-system.jpg',
  'field-fire-alarm-panel.jpg',
  'field-preaction-system.jpg',
] as const;

describe('Nantong portal production layout guard', () => {
  it('publishes the complete field-photo expansion in the four system galleries', () => {
    const systemPhotoCounts = ['power', 'cooling', 'weak', 'fire'].map(
      (key) => SYSTEMS[key].photos.length,
    );
    const publishedFiles = new Set(
      Object.values(SYSTEMS).flatMap((system) =>
        system.photos.map(([, file]) => file),
      ),
    );

    expect(systemPhotoCounts).toEqual([7, 9, 4, 6]);
    expect(systemPhotoCounts.reduce((total, count) => total + count, 0)).toBe(
      26,
    );
    expect(fieldPhotoFiles.every((file) => publishedFiles.has(file))).toBe(true);

    for (const file of fieldPhotoFiles) {
      const assetPath = join(portalAssetDirectory, file);
      const bytes = readFileSync(assetPath).byteLength;
      expect(bytes).toBeGreaterThan(20_000);
      expect(bytes).toBeLessThan(500_000);
    }
  });

  it('keeps the portal theme available when the first emitted CSS rule is lost', () => {
    expect(portalCssSource.trimStart()).toMatch(
      /^\.portal-css-integrity-sentinel\s*\{/,
    );
    expect(portalIndexSource).toContain('style={PORTAL_THEME_STYLE}');
    for (const variable of [
      '--portal-blue',
      '--portal-mint',
      '--portal-paper',
      '--portal-ink',
      '--portal-navy',
      '--portal-light',
      '--portal-radius',
      '--portal-gutter',
    ]) {
      expect(portalIndexSource).toContain(`'${variable}'`);
    }
  });

  it('places the hero in the same bounded container as the global navigation', () => {
    expect(portalTourSource).toContain('className="photo-hero wrap"');
    expect(portalCssSource).toMatch(
      /--portal-gutter:\s*clamp\(0\.75rem,\s*2vw,\s*1\.5rem\)/,
    );
    expect(portalCssSource).toMatch(
      /\.nantong-portal \.photo-hero\s*\{[^}]*border-radius:\s*var\(--portal-radius\)/s,
    );
  });

  it('reserves a compact copy column before the mobile breakpoint', () => {
    expect(portalCssSource).toMatch(
      /@media \(max-width:\s*1120px\)[\s\S]*?\.nantong-portal \.photo-copy > \*\s*\{[^}]*max-width:\s*20rem/s,
    );
    expect(portalCssSource).toMatch(
      /@media \(max-width:\s*1120px\)[\s\S]*?\.nantong-portal \.photo-copy h1\s*\{[^}]*max-width:\s*18rem/s,
    );
    expect(portalCssSource).toMatch(
      /@media \(max-width:\s*1120px\)[\s\S]*?\.nantong-portal \.photo-canvas\s*\{[^}]*right:\s*-8%/s,
    );
  });

  it('keeps expanded equipment lists compact and thumbnails responsive', () => {
    expect(portalCssSource).toMatch(
      /\.nantong-portal \.system-device-list\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(portalCssSource.replace(/\s+/g, '')).toContain(
      'grid-template-columns:repeat(auto-fit,minmax(min(100%,12.5rem),1fr));',
    );
    expect(portalCssSource).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*?\.nantong-portal \.system-photo-thumbnails\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
    );
  });
});

describe('campus animation lifecycle', () => {
  it('cancels animation frames and removes observers/listeners when the page unmounts', () => {
    const properties = [
      'window',
      'document',
      'IntersectionObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ];
    const descriptors = properties.map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    const media = Object.assign(new EventTarget(), { matches: false });
    const documentStub = Object.assign(new EventTarget(), { hidden: false });
    const visibilityRemove = jest.spyOn(documentStub, 'removeEventListener');
    const mediaRemove = jest.spyOn(media, 'removeEventListener');
    let observerCallback: IntersectionObserverCallback = () => undefined;
    let callback: FrameRequestCallback = () => undefined;
    const disconnect = jest.fn();
    const schedule = jest.fn((next: FrameRequestCallback) => {
      callback = next;
      return 51;
    });
    const cancel = jest.fn();
    const node = () => ({
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      setAttribute: jest.fn(),
    });
    const geometry = {
      getTotalLength: () => 100,
      getPointAtLength: (length: number) => ({ x: length, y: 0 }),
    };
    const nodes: Record<string, unknown> = {
      '[data-route-geometry]': geometry,
    };
    [
      '[data-illumination]',
      '[data-route-beacon]',
      '[data-tour-route]',
      ...['glow', 'far', 'mid', 'near'].map(
        (value) => `[data-tail="${value}"]`,
      ),
    ].forEach((key) => {
      nodes[key] = node();
    });
    const image = { dataset: { stop: '1' }, classList: { toggle: jest.fn() } };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector: (selector: string) => nodes[selector],
      querySelectorAll: (selector: string) =>
        selector === '[data-building-label]' ? [node(), node()] : [image],
    };
    const stops: CampusStop[] = [
      { id: 'gate', name: '大门', label: [0, 0], route: [[0, 0]], polygon: '' },
      {
        id: '110',
        name: '110 站',
        label: [100, 0],
        route: [[100, 0]],
        polygon: '0,0 1,1 2,0',
      },
    ];
    try {
      const replacements: Record<string, unknown> = {
        window: { matchMedia: () => media },
        document: documentStub,
        requestAnimationFrame: schedule,
        cancelAnimationFrame: cancel,
        IntersectionObserver: class {
          constructor(cb: IntersectionObserverCallback) {
            observerCallback = cb;
          }
          observe() {}
          disconnect = disconnect;
        },
      };
      properties.forEach((key) =>
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: replacements[key],
        }),
      );
      const animation = createCampusAnimation(
        root as unknown as HTMLElement,
        stops,
      );
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      expect(schedule).toHaveBeenCalledTimes(1);
      animation.seek(1);
      expect(root.dataset.allLit).toBe('true');
      expect(image.classList.toggle).toHaveBeenLastCalledWith('is-lit', true);
      animation.dispose();
      expect(cancel).toHaveBeenCalledWith(51);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(visibilityRemove).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );
      expect(mediaRemove).toHaveBeenCalledWith('change', expect.any(Function));
      callback(1000);
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      descriptors.forEach(([key, descriptor]) =>
        descriptor
          ? Object.defineProperty(globalThis, key, descriptor)
          : Reflect.deleteProperty(globalThis, key),
      );
      jest.restoreAllMocks();
    }
  });
});

describe('Nantong portal motion', () => {
  it('counts monotonically from zero to the exact target without overshoot', () => {
    for (const target of [2994, 7, 5, 150]) {
      const values = Array.from({ length: 181 }, (_, i) =>
        countAt(target, i * 10),
      );
      expect(values[0]).toBe(0);
      expect(values[180]).toBe(target);
      expect(
        values.every((v, i) => v >= (values[i - 1] ?? 0) && v <= target),
      ).toBe(true);
      expect(countAt(target, 5000)).toBe(target);
    }
  });

  it('keeps every building lit at the destination and resets at the next cycle', () => {
    const milestones = [0, 100, 250, 400, 550, 700, 850, 1000];
    for (const elapsed of [17000, 18000, 19500]) {
      expect(getTourFrame(elapsed, milestones).active).toBe(7);
      expect(getTourFrame(elapsed, milestones).distance).toBe(1000);
    }
    expect(getTourFrame(20000, milestones).active).toBe(0);
    expect(getTourFrame(0, milestones, true)).toMatchObject({
      active: 7,
      trailOpacity: 0,
      lightOpacity: 1,
    });
  });

  it('rounds road corners and tolerates repeated adjacent coordinates', () => {
    const route = roundedRoutePath([
      [0, 0],
      [0, 0],
      [20, 0],
      [20, 30],
    ]);
    expect(route).toContain('Q20,0');
    expect(route.endsWith('L20,30')).toBe(true);
    expect(route).not.toMatch(/NaN|Infinity/);
  });

  it('cycles through every system and eventually every equipment photo', () => {
    const lengths = (['power', 'cooling', 'weak', 'fire'] as const).map(
      (key) => SYSTEMS[key].photos.length,
    );
    let state = { system: 0, photo: 0, phase: 0, cursors: [1, 0, 0, 0] };
    const seen = new Set<string>(['0:0']);
    const systems = [0];
    for (let i = 0; i < 96; i++) {
      const before = state.system;
      state = advanceCarousel(state, lengths);
      if (before !== state.system) systems.push(state.system);
      expect(state.photo).toBeLessThan(lengths[state.system]);
      seen.add(`${state.system}:${state.photo}`);
    }
    expect(systems.slice(0, 5)).toEqual([0, 1, 2, 3, 0]);
    expect(seen.size).toBe(26);
  });
});
