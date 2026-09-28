// Core domain model. Everything is plain JSON so it can be stored as files
// and sent to/from the browser without transformation.

export type Tier = "refresh" | "reconfigure" | "extend";

export const TIERS: { id: Tier; label: string; blurb: string }[] = [
  { id: "refresh", label: "Refresh", blurb: "Work within the existing plan — finishes, kitchens, bathrooms, light." },
  { id: "reconfigure", label: "Reconfigure", blurb: "Change the plan — take walls out, move doors, re-purpose rooms." },
  { id: "extend", label: "Extend", blurb: "Add space — rear/side extensions, attic, garage conversion." },
];

export type RoomType =
  | "living"
  | "kitchen"
  | "dining"
  | "kitchen_dining"
  | "bedroom"
  | "bathroom"
  | "ensuite"
  | "wc"
  | "hall"
  | "landing"
  | "utility"
  | "study"
  | "garage"
  | "conservatory"
  | "storage"
  | "other";

export const ROOM_TYPES: RoomType[] = [
  "living", "kitchen", "dining", "kitchen_dining", "bedroom", "bathroom", "ensuite", "wc",
  "hall", "landing", "utility", "study", "garage", "conservatory", "storage", "other",
];

export type FloorFinish = "oak" | "walnut" | "tile" | "stone" | "carpet" | "concrete" | "vinyl";
export const FLOOR_FINISHES: FloorFinish[] = ["oak", "walnut", "tile", "stone", "carpet", "concrete", "vinyl"];

export interface RoomFinish {
  wall?: string; // hex colour
  floor?: FloorFinish;
}

/** Axis-aligned rectangular room on a plan. Units are metres; x → right, y → down. */
export interface Room {
  id: string;
  name: string;
  type: RoomType;
  x: number;
  y: number;
  w: number;
  d: number;
  finish?: RoomFinish;
  /** True for space added by an extension scenario. */
  isNew?: boolean;
}

export interface Floor {
  id: string;
  name: string;
  level: number;
  rooms: Room[];
}

export type WallState = "solid" | "door" | "window" | "glazed" | "open";
export const WALL_STATES: { id: WallState; label: string }[] = [
  { id: "solid", label: "Solid wall" },
  { id: "door", label: "Doorway" },
  { id: "window", label: "Window" },
  { id: "glazed", label: "Glazing / bi-folds" },
  { id: "open", label: "Removed (open)" },
];

export type PlanSide = "top" | "bottom" | "left" | "right";

export interface Connection {
  a: string; // room id
  b: string; // room id, or "outside"
  kind: "door" | "open";
  /** For b === "outside": which edge of room `a` the door is on. */
  side?: PlanSide;
}

export interface Layout {
  floors: Floor[];
  /** Explicit state for individual wall segments, keyed by wallKey(). */
  wallStates: Record<string, WallState>;
  /** Door/opening hints used to pick default wall states. */
  connections: Connection[];
  /** Sides of the building joined to a neighbour (party walls: no windows or doors). */
  attached?: PlanSide[];
  ceilingHeight: number;
}

export interface Scenario {
  id: string;
  name: string;
  tier: Tier | "base";
  description: string;
  layout: Layout;
  createdBy: string;
  createdAt: string;
  source: "manual" | "ai" | "trace";
}

export interface Photo {
  id: string;
  file: string; // relative path inside the uploads dir
  caption?: string;
  kind: "photo" | "floorplan";
  sourceUrl?: string;
}

export interface Note {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface Wish {
  id: string;
  author: string;
  tier: Tier;
  room?: string;
  text: string;
  priority: "must" | "nice" | "dream";
  createdAt: string;
}

export interface Idea {
  id: string;
  tier: Tier;
  title: string;
  summary: string;
  rooms: string[];
  impact: string;
  costBand: string;
  complexity: "low" | "medium" | "high";
  permissions: string;
  risks: string;
  /** Short brief an image model can use to visualise it. */
  visualBrief: string;
}

export interface Analysis {
  createdAt: string;
  overview: string;
  ideas: Idea[];
  caveats: string[];
}

export interface Render {
  id: string;
  file: string;
  sourcePhotoId?: string;
  sourceFile?: string;
  scenarioId?: string;
  prompt: string;
  brief: string;
  createdBy: string;
  createdAt: string;
  provider: string;
}

export type PropertyStatus = "viewing" | "shortlisted" | "offer" | "passed";
export const STATUSES: { id: PropertyStatus; label: string }[] = [
  { id: "viewing", label: "Viewed" },
  { id: "shortlisted", label: "Shortlisted" },
  { id: "offer", label: "Offer" },
  { id: "passed", label: "Passed" },
];

export interface Property {
  id: string;
  title: string;
  address: string;
  price?: string;
  listingUrl?: string;
  bedrooms?: number;
  bathrooms?: number;
  propertyType?: string;
  description?: string;
  features: string[];
  status: PropertyStatus;
  ratings: Record<string, number>;
  photos: Photo[];
  notes: Note[];
  wishes: Wish[];
  scenarios: Scenario[];
  analysis?: Analysis;
  renders: Render[];
  createdAt: string;
  updatedAt: string;
}
