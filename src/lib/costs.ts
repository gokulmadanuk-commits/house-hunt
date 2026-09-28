// Rough cost roll-up for a scenario versus the current layout. Rates are
// user-editable starting assumptions — they are not sourced benchmarks and
// the UI says so. Replace them with local builder quotes.

import { deriveWalls, roomArea } from "./layout";
import type { Layout } from "./types";

export interface Range {
  low: number;
  high: number;
}

export interface Rates {
  extensionPerM2: Range;
  structuralOpening: Range;
  glazingPerM: Range;
  refreshPerM2: Range;
}

export const DEFAULT_RATES: Rates = {
  extensionPerM2: { low: 1800, high: 2800 },
  structuralOpening: { low: 2500, high: 6000 },
  glazingPerM: { low: 1200, high: 2200 },
  refreshPerM2: { low: 60, high: 150 },
};

export const RATE_LABELS: Record<keyof Rates, { label: string; unit: string }> = {
  extensionPerM2: { label: "New build (extension)", unit: "£ / m²" },
  structuralOpening: { label: "Wall taken out (incl. beam)", unit: "£ each" },
  glazingPerM: { label: "Glazing / bi-folds", unit: "£ / m run" },
  refreshPerM2: { label: "Redecorate & new floor", unit: "£ / m²" },
};

export interface CostLine {
  key: keyof Rates;
  qty: number;
  unit: string;
  low: number;
  high: number;
}

export function costLines(base: Layout, scenario: Layout, rates: Rates): CostLine[] {
  const rooms = scenario.floors.flatMap((f) => f.rooms);
  const baseRooms = new Map(base.floors.flatMap((f) => f.rooms).map((r) => [r.id, r]));
  const newArea = rooms.filter((r) => r.isNew).reduce((s, r) => s + roomArea(r), 0);

  const openCount = (l: Layout) => l.floors.reduce((n, f) => n + deriveWalls(f, l).filter((s) => !s.exterior && s.state === "open").length, 0);
  const glazedLen = (l: Layout) => l.floors.reduce((n, f) => n + deriveWalls(f, l).filter((s) => s.state === "glazed").reduce((m, s) => m + s.length, 0), 0);
  const openings = Math.max(0, openCount(scenario) - openCount(base));
  const glazing = Math.max(0, glazedLen(scenario) - glazedLen(base));
  const refreshed = rooms
    .filter((r) => !r.isNew && r.finish && JSON.stringify(r.finish) !== JSON.stringify(baseRooms.get(r.id)?.finish))
    .reduce((s, r) => s + roomArea(r), 0);

  const line = (key: keyof Rates, qty: number, unit: string): CostLine => ({ key, qty: Math.round(qty * 10) / 10, unit, low: qty * rates[key].low, high: qty * rates[key].high });
  return [
    line("extensionPerM2", newArea, "m²"),
    line("structuralOpening", openings, "×"),
    line("glazingPerM", glazing, "m"),
    line("refreshPerM2", refreshed, "m²"),
  ].filter((l) => l.qty > 0);
}

export function formatGBP(n: number) {
  if (n >= 1000) return `£${Math.round(n / 1000).toLocaleString("en-GB")}k`;
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}
