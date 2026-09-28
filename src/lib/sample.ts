// A demo property so the plan editor and 3D walkthrough can be explored
// before any real listings are added. Loosely modelled on a typical
// two-storey terrace with a closed-off rear kitchen return.

import { cloneLayout, deriveWalls, newId } from "./layout";
import type { Layout, Property, Room, Scenario } from "./types";

function room(id: string, name: string, type: Room["type"], x: number, y: number, w: number, d: number): Room {
  return { id, name, type, x, y, w, d };
}

export function sampleBaseLayout(): Layout {
  return {
    ceilingHeight: 2.6,
    wallStates: {},
    attached: ["left", "right"],
    floors: [
      {
        id: "gf",
        name: "Ground floor",
        level: 0,
        rooms: [
          room("living", "Front reception", "living", 0, 0, 3.8, 4.2),
          room("hall", "Hall & stairs", "hall", 3.8, 0, 1.2, 7.8),
          room("dining", "Dining room", "dining", 0, 4.2, 3.8, 3.6),
          room("kitchen", "Kitchen", "kitchen", 0, 7.8, 3.0, 3.2),
          room("utility", "Utility", "utility", 3.0, 7.8, 2.0, 1.6),
          room("wc", "WC", "wc", 3.0, 9.4, 2.0, 1.6),
        ],
      },
      {
        id: "ff",
        name: "First floor",
        level: 1,
        rooms: [
          room("bed1", "Bedroom 1", "bedroom", 0, 0, 5.0, 4.0),
          room("bed2", "Bedroom 2", "bedroom", 0, 4.0, 3.4, 3.4),
          room("landing", "Landing", "landing", 3.4, 4.0, 1.6, 4.4),
          room("bed3", "Bedroom 3", "bedroom", 0, 7.4, 3.4, 2.8),
          room("bath", "Bathroom", "bathroom", 3.4, 8.4, 1.6, 1.8),
        ],
      },
    ],
    connections: [
      { a: "hall", b: "outside", kind: "door", side: "top" },
      { a: "hall", b: "living", kind: "door" },
      { a: "hall", b: "dining", kind: "door" },
      { a: "dining", b: "kitchen", kind: "door" },
      { a: "kitchen", b: "utility", kind: "door" },
      { a: "utility", b: "wc", kind: "door" },
      { a: "landing", b: "bed1", kind: "door" },
      { a: "landing", b: "bed2", kind: "door" },
      { a: "landing", b: "bed3", kind: "door" },
      { a: "landing", b: "bath", kind: "door" },
    ],
  };
}

/** Knock kitchen/dining through and add a full-width glazed rear extension. */
export function sampleExtendedLayout(base: Layout): Layout {
  const l = cloneLayout(base);
  const gf = l.floors[0];
  gf.rooms = gf.rooms.filter((r) => r.id !== "utility" && r.id !== "wc");
  const kitchen = gf.rooms.find((r) => r.id === "kitchen")!;
  kitchen.name = "Kitchen";
  kitchen.type = "kitchen_dining";
  kitchen.w = 5.0;
  kitchen.finish = { floor: "tile", wall: "#EDE6DA" };
  gf.rooms.push({
    id: "ext",
    name: "Garden room extension",
    type: "kitchen_dining",
    x: 0,
    y: 11.0,
    w: 5.0,
    d: 3.5,
    isNew: true,
    finish: { floor: "tile", wall: "#F1ECE3" },
  });
  gf.rooms.push({ id: "wc2", name: "WC (under stairs)", type: "wc", x: 3.8, y: 6.6, w: 1.2, d: 1.2 });
  const hall = gf.rooms.find((r) => r.id === "hall")!;
  hall.d = 6.6;
  l.connections = l.connections.filter((c) => !["utility", "wc"].includes(c.a) && !["utility", "wc"].includes(c.b));
  l.connections.push({ a: "hall", b: "wc2", kind: "door" });

  for (const s of deriveWalls(gf, l)) {
    const pair = [s.sideA, s.sideB].sort().join("|");
    if (pair === ["dining", "kitchen"].sort().join("|")) l.wallStates[s.key] = "open";
    if (pair === ["ext", "kitchen"].sort().join("|")) l.wallStates[s.key] = "open";
    if (s.exterior && (s.sideA === "ext" || s.sideB === "ext") && s.orient === "h") l.wallStates[s.key] = "glazed";
  }
  return l;
}

export function sampleProperty(author: string): Property {
  const now = new Date().toISOString();
  const base = sampleBaseLayout();
  const scenario = (name: string, tier: Scenario["tier"], description: string, layout: Layout): Scenario => ({
    id: newId("s"),
    name,
    tier,
    description,
    layout,
    createdBy: author,
    createdAt: now,
    source: "manual",
  });
  const refresh = cloneLayout(base);
  for (const r of refresh.floors[0].rooms) {
    if (r.type === "living") r.finish = { wall: "#DCE3D5", floor: "oak" };
    if (r.type === "dining") r.finish = { wall: "#E8D9C4", floor: "oak" };
    if (r.type === "hall") r.finish = { wall: "#F2EEE6", floor: "tile" };
  }
  return {
    id: newId("p"),
    title: "Demo — Victorian terrace",
    address: "Example Street (demo data)",
    price: "Offers around £245,000",
    bedrooms: 3,
    bathrooms: 1,
    propertyType: "Terrace",
    description:
      "A demo property so you can try the plan editor and 3D walkthrough. Classic layout: two receptions, a small closed-off kitchen at the back, utility and WC in the return, three bedrooms above.",
    features: ["Two reception rooms", "Rear kitchen return", "Enclosed yard"],
    status: "viewing",
    ratings: {},
    photos: [],
    notes: [],
    wishes: [
      { id: newId("w"), author, tier: "reconfigure", room: "Kitchen", text: "Open the kitchen up to the dining room so we can see the garden while cooking.", priority: "must", createdAt: now },
      { id: newId("w"), author, tier: "extend", room: "Kitchen", text: "Glazed rear extension with bi-folds onto the yard.", priority: "dream", createdAt: now },
      { id: newId("w"), author, tier: "refresh", room: "Front reception", text: "Warm, calm front room — sage walls, oak floor.", priority: "nice", createdAt: now },
    ],
    scenarios: [
      scenario("As it stands", "base", "Layout traced from the agent's floor plan.", base),
      scenario("Fresh paint & floors", "refresh", "Same plan, new finishes in the reception rooms and hall.", refresh),
      scenario("Open-plan rear extension", "extend", "Knock kitchen through to dining, remove utility/WC, add a 3.5m full-width glazed extension, WC under the stairs.", sampleExtendedLayout(base)),
    ],
    renders: [],
    createdAt: now,
    updatedAt: now,
  };
}
