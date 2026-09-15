// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const echartsMock = vi.hoisted(() => ({
  chart: {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  },
  init: vi.fn(),
  use: vi.fn(),
}));

const themeState = vi.hoisted(() => ({ resolvedTheme: 'light' as 'light' | 'dark' }));

vi.mock('echarts/core', () => ({
  init: echartsMock.init,
  use: echartsMock.use,
}));

vi.mock('echarts/charts', () => ({ LineChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));

vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ resolvedTheme: themeState.resolvedTheme }),
}));

import {
  UsageDashboard,
  chartSafeRgba,
  normalizeUsageResponse,
} from '@/components/settings/usage-dashboard';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  echartsMock.chart.setOption.mockClear();
  echartsMock.chart.resize.mockClear();
  echartsMock.chart.dispose.mockClear();
  echartsMock.init.mockReset();
  echartsMock.init.mockReturnValue(echartsMock.chart);
  themeState.resolvedTheme = 'light';
  document.documentElement.style.setProperty('--brand-shadow', '76 35 128');
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

async function mountWithUsage(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(UsageDashboard)));
  await flush();
  await flush();
  return host;
}

describe('usage dashboard runtime hardening', () => {
  it('normalizes malformed usage payloads before rendering', () => {
    const normalized = normalizeUsageResponse({
      success: true,
      totals: { requests: 'many', llmTokens: Number.NaN },
      byDay: [
        null,
        { key: 7, requests: -1, totalTokens: 'bad', quantity: 4 },
        { key: '2026-09-15', kind: 'video', requests: 2, quantity: 120 },
      ],
      byModel: 'not-an-array',
      byKind: [{ key: 'image', kind: 'image', requests: 1, quantity: 3 }],
    });

    expect(normalized.totals).toEqual({ requests: 2, llmTokens: 0 });
    expect(normalized.byModel).toEqual([]);
    expect(normalized.byDay).toMatchObject([
      { key: 'unknown', kind: 'llm', unit: 'token', requests: 0 },
      { key: '2026-09-15', kind: 'video', unit: 'second', requests: 2 },
    ]);
    expect(normalized.byKind[0]).toMatchObject({ key: 'image', kind: 'image', unit: 'image' });
  });

  it('passes ECharts legacy-safe rgba colors in light mode', async () => {
    await mountWithUsage({
      success: true,
      totals: { requests: 1, llmTokens: 8 },
      byDay: [{ key: '2026-09-15', kind: 'llm', unit: 'token', requests: 1, totalTokens: 8 }],
      byModel: [],
      byKind: [],
    });

    const option = echartsMock.chart.setOption.mock.calls.at(-1)?.[0] as {
      series: Array<{ areaStyle: { color: { colorStops: Array<{ color: string }> } } }>;
    };
    expect(option.series[0]?.areaStyle.color.colorStops[0]?.color).toBe('rgba(76, 35, 128, 0.22)');
    expect(option.series[0]?.areaStyle.color.colorStops[1]?.color).toBe('rgba(76, 35, 128, 0.02)');
  });

  it('keeps dark-mode chart colors in the same safe format', async () => {
    themeState.resolvedTheme = 'dark';
    document.documentElement.style.setProperty('--brand-shadow', '#2a0f4f');

    await mountWithUsage({
      success: true,
      totals: { requests: 1, llmTokens: 8 },
      byDay: [{ key: '2026-09-15', kind: 'llm', unit: 'token', requests: 1, totalTokens: 8 }],
      byModel: [],
      byKind: [],
    });

    const option = echartsMock.chart.setOption.mock.calls.at(-1)?.[0] as {
      series: Array<{ areaStyle: { color: { colorStops: Array<{ color: string }> } } }>;
    };
    expect(option.series[0]?.areaStyle.color.colorStops[0]?.color).toBe('rgba(42, 15, 79, 0.16)');
  });

  it('falls back to the MIT ADT shadow color for malformed CSS variables', () => {
    expect(chartSafeRgba('not rgb channels', 0.35)).toBe('rgba(76, 35, 128, 0.35)');
  });
});
