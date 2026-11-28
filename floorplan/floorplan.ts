#!/usr/bin/env node
// Draws a RoomPlan scan as a floorplan seen from each of its four corners, for the floorplan card in
// Home Assistant. See docs/homeassistant.md#floorplan.
//
//   node floorplan/floorplan.ts <data-dir>
//
// Reads scan.json and, if present, placements.json from the data dir. Writes floorplan-light-0.svg to
// floorplan-dark-3.svg and dashboard.json next to them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Vec = { x: number; y: number };

// One wall, door, window, opening or object of a RoomPlan capture. Lengths are metres.
// `transform` is a column-major 4x4 matrix: translation at 12-14, the local X axis at 0-2.
type Surface = {
  identifier: string;
  parentIdentifier?: string | null;
  dimensions: number[];
  transform: number[];
  category: Record<string, unknown>;
  story?: number;
};
type Section = { center: number[]; label: string; displayName?: string; story?: number };
type Scan = {
  walls: Surface[];
  doors?: Surface[];
  windows?: Surface[];
  openings?: Surface[];
  objects?: Surface[];
  sections?: Section[];
};

type Wall = { id: string; a: Vec; b: Vec; thickness: number };
type Opening = { kind: "door" | "window"; wall: string; at: Vec; width: number };
// `corners` run front right, front left, back left, back right. `base` and `top` are real heights above the floor.
type Furniture = { category: string; corners: Vec[]; base: number; top: number };
type Room = { name: string; at: Vec };
type Plan = { walls: Wall[]; openings: Opening[]; furniture: Furniture[]; rooms: Room[] };

// Where an entity sits: in a room, in metres from that room's top-left corner as this script prints it,
// x to the right and y down, and `z` above the floor.
type Placement = { entity: string; room: string; x: number; y: number; z?: number; icon?: string };

// An upright block. `from` and `to` are drawn heights.
type Box = { footprint: Vec[]; from: number; to: number; fill: string };
type Palette = {
  ground: string; floor: string; threshold: string; wall: string; glass: string; shadow: string;
  wood: string; fabric: string; linen: string; duvet: string; pillow: string; appliance: string; ceramic: string; water: string; screen: string; stone: string;
};

const PALETTES: Record<"light" | "dark", Palette> = {
  light: {
    ground: "#f4f0e9", floor: "#f1eadf", threshold: "#e6dccb", wall: "#ddd8d0", glass: "#c3dff0", shadow: "#6b5d4a",
    wood: "#dcc5a4", fabric: "#bccab9", linen: "#f6f2ec", duvet: "#bccbdb", pillow: "#fdfcfa", appliance: "#e8ebee", ceramic: "#fafbfc", water: "#cfe4ee", screen: "#69717d", stone: "#cbbdab",
  },
  dark: {
    ground: "#2b2e35", floor: "#353941", threshold: "#2d3038", wall: "#5d6470", glass: "#517f9f", shadow: "#000000",
    wood: "#7d6c57", fabric: "#5d6e65", linen: "#878c95", duvet: "#56677c", pillow: "#a4a9b1", appliance: "#767d88", ceramic: "#969da7", water: "#4b6a7d", screen: "#1d2025", stone: "#7a7166",
  },
};

const DEFAULT_WALL_THICKNESS = 0.15;
// The plan is drawn as if cut off just above the kitchen counters and then flattened, so nothing hides much.
// Walls are as tall as the tallest furniture, so a cupboard never sticks up over the wall it stands against.
const CUT_HEIGHT = 0.9;
const HEIGHT_SCALE = 0.45;
const WALL_HEIGHT = CUT_HEIGHT * HEIGHT_SCALE;
const SILL_HEIGHT = 0.14;
const COUNTER_HEIGHT = 0.85;
const SNAP_DEGREES = 5;
// Below a wall's thickness, so the two sides of a wall shared by two stitched scans stay apart.
const MERGE_DISTANCE = 0.1;
const MAX_PUSH = 0.25;
const DOUBLE_WALL = 0.3;
const OUTER_SNAP = 0.3;
const MAX_FILL = 1;
const MIN_ROOM_AREA = 0.5;
const PIXELS_PER_METRE = 50;
const MARGIN = 0.4;
// The plan is seen from a corner, from this many degrees above the floor. 35.26 would be true isometric;
// a little steeper shows more floor behind the walls.
const ELEVATION = 45;
const COS30 = Math.cos(Math.PI / 6);
// How far down the page a metre along either floor axis runs, and how far up a metre of height.
const RISE = COS30 * Math.sin((ELEVATION * Math.PI) / 180);
const LIFT = (COS30 / Math.SQRT1_2) * Math.cos((ELEVATION * Math.PI) / 180);
const EPSILON = 1e-4;

const add = (p: Vec, q: Vec): Vec => ({ x: p.x + q.x, y: p.y + q.y });
const sub = (p: Vec, q: Vec): Vec => ({ x: p.x - q.x, y: p.y - q.y });
const scale = (p: Vec, k: number): Vec => ({ x: p.x * k, y: p.y * k });
const dot = (p: Vec, q: Vec): number => p.x * q.x + p.y * q.y;
const cross = (p: Vec, q: Vec): number => p.x * q.y - p.y * q.x;
const length = (p: Vec): number => Math.hypot(p.x, p.y);
const unit = (p: Vec): Vec => scale(p, 1 / (length(p) || 1));
const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
const centroid = (points: Vec[]): Vec => ({ x: mean(points.map((p) => p.x)), y: mean(points.map((p) => p.y)) });
const rotate = (p: Vec, radians: number): Vec => ({
  x: p.x * Math.cos(radians) - p.y * Math.sin(radians),
  y: p.x * Math.sin(radians) + p.y * Math.cos(radians),
});
const quarterTurns = (p: Vec, turns: number): Vec => (turns === 0 ? p : quarterTurns({ x: -p.y, y: p.x }, turns - 1));
const key = (p: Vec): string => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

function area(polygon: Vec[]): number {
  return polygon.reduce((sum, p, i) => sum + cross(p, polygon[(i + 1) % polygon.length]), 0) / 2;
}

function contains(polygon: Vec[], p: Vec): boolean {
  const crossings = polygon.filter((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
  });
  return crossings.length % 2 === 1;
}

// Andrew's monotone chain.
function convexHull(points: Vec[]): Vec[] {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const half = (ordered: Vec[]): Vec[] =>
    ordered.reduce((hull: Vec[], p) => {
      while (hull.length > 1 && cross(sub(hull[hull.length - 1], hull[hull.length - 2]), sub(p, hull[hull.length - 1])) <= 0) hull.pop();
      return [...hull, p];
    }, []);
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

function distanceToWall(p: Vec, wall: Wall): number {
  const along = sub(wall.b, wall.a);
  const t = Math.min(1, Math.max(0, dot(sub(p, wall.a), along) / dot(along, along)));
  return length(sub(p, add(wall.a, scale(along, t))));
}

function mapPlan(plan: Plan, move: (p: Vec) => Vec): Plan {
  return {
    walls: plan.walls.map((w) => ({ ...w, a: move(w.a), b: move(w.b) })),
    openings: plan.openings.map((o) => ({ ...o, at: move(o.at) })),
    furniture: plan.furniture.map((f) => ({ ...f, corners: f.corners.map(move) })),
    rooms: plan.rooms.map((r) => ({ ...r, at: move(r.at) })),
  };
}

// ---- Reading the scan

// RoomPlan X is plan x and RoomPlan Z is plan y, which gives a top-down view with y pointing down the page.
const position = (s: Surface): Vec => ({ x: s.transform[12], y: s.transform[14] });
const heading = (s: Surface): Vec => unit({ x: s.transform[0], y: s.transform[2] });
const category = (s: Surface): string => Object.keys(s.category)[0] ?? "unknown";

function roomName(section: Section): string {
  // "Room 3" is what the OpenPlan3D editor calls a room nobody named, wall-thick slivers between scans included.
  if (/^Room \d+$/.test(section.displayName ?? "")) return "";
  if (section.displayName) return section.displayName;
  if (section.label === "unidentified") return "";
  const words = section.label.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readPlan(scan: Scan): Plan {
  // A scan can hold several storeys. Only the one with the most walls is drawn.
  const counts = new Map<number, number>();
  for (const w of scan.walls) counts.set(w.story ?? 0, (counts.get(w.story ?? 0) ?? 0) + 1);
  const story = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const onStory = <T extends { story?: number }>(items: T[] | undefined): T[] => (items ?? []).filter((i) => (i.story ?? 0) === story);

  const walls = onStory(scan.walls);
  const floorLevel = Math.min(...walls.map((w) => w.transform[13] - w.dimensions[1] / 2));
  const opening = (kind: Opening["kind"]) => (s: Surface): Opening => ({ kind, wall: s.parentIdentifier ?? "", at: position(s), width: s.dimensions[0] });

  return {
    walls: walls.map((w) => {
      const half = scale(heading(w), w.dimensions[0] / 2);
      return { id: w.identifier, a: sub(position(w), half), b: add(position(w), half), thickness: w.dimensions[2] || DEFAULT_WALL_THICKNESS };
    }),
    openings: [
      ...onStory(scan.doors).map(opening("door")),
      ...onStory(scan.openings).map(opening("door")),
      ...onStory(scan.windows).map(opening("window")),
    ],
    furniture: onStory(scan.objects).map((o) => {
      const across = scale(heading(o), o.dimensions[0] / 2);
      const deep = scale(unit({ x: o.transform[8], y: o.transform[10] }), o.dimensions[2] / 2);
      const top = Math.max(0.05, o.transform[13] + o.dimensions[1] / 2 - floorLevel);
      const front = add(position(o), deep);
      const back = sub(position(o), deep);
      return {
        category: category(o),
        corners: [add(front, across), sub(front, across), sub(back, across), add(back, across)],
        base: Math.max(0, top - o.dimensions[1]),
        top,
      };
    }),
    rooms: onStory(scan.sections).map((s) => ({ name: roomName(s), at: { x: s.center[0], y: s.center[2] } })),
  };
}

// ---- Tidying the geometry

// Wall directions repeat every quarter turn, so they are averaged on a circle that is four times as fast.
function dominantAngle(walls: Wall[]): number {
  const sum = walls.reduce((total, w) => {
    const along = sub(w.b, w.a);
    return add(total, rotate({ x: length(along), y: 0 }, Math.atan2(along.y, along.x) * 4));
  }, { x: 0, y: 0 });
  return Math.atan2(sum.y, sum.x) / 4;
}

function snapToAxis(wall: Wall): Wall {
  const along = sub(wall.b, wall.a);
  const degrees = (Math.atan2(along.y, along.x) * 180) / Math.PI;
  const offAxis = Math.abs(degrees - Math.round(degrees / 90) * 90);
  if (offAxis > SNAP_DEGREES) return wall;
  const middle = scale(add(wall.a, wall.b), 0.5);
  if (Math.abs(along.x) > Math.abs(along.y)) return { ...wall, a: { x: wall.a.x, y: middle.y }, b: { x: wall.b.x, y: middle.y } };
  return { ...wall, a: { x: middle.x, y: wall.a.y }, b: { x: middle.x, y: wall.b.y } };
}

const isHorizontal = (w: Wall): boolean => w.a.y === w.b.y;
const isVertical = (w: Wall): boolean => w.a.x === w.b.x;

function groupBy<T>(items: T[], together: (a: T, b: T) => boolean): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const joined = groups.filter((g) => g.some((other) => together(item, other)));
    const rest = groups.filter((g) => !joined.includes(g));
    groups.length = 0;
    groups.push(...rest, [...joined.flat(), item]);
  }
  return groups;
}

function lineCrossing(a: Wall, b: Wall): Vec | null {
  const da = sub(a.b, a.a);
  const db = sub(b.b, b.a);
  const denominator = cross(da, db);
  if (Math.abs(denominator) < 0.1 * length(da) * length(db)) return null;
  return add(a.a, scale(da, cross(sub(b.a, a.a), db) / denominator));
}

// Makes wall ends that almost meet meet exactly, without tilting the walls that were snapped to an axis.
function joinWalls(input: Wall[]): Wall[] {
  type End = { wall: number; end: "a" | "b" };
  const walls = input.map((w) => ({ ...w }));
  const ends: End[] = walls.flatMap((_, wall): End[] => [{ wall, end: "a" }, { wall, end: "b" }]);
  const at = (e: End): Vec => walls[e.wall][e.end];
  const corners = groupBy(ends, (p, q) => length(sub(at(p), at(q))) < MERGE_DISTANCE);

  // Walls that continue each other end to end share one line.
  const continues = (i: number, j: number): boolean =>
    corners.some((c) => c.some((e) => e.wall === i) && c.some((e) => e.wall === j)) &&
    ((isHorizontal(walls[i]) && isHorizontal(walls[j])) || (isVertical(walls[i]) && isVertical(walls[j])));
  for (const run of groupBy(walls.map((_, i) => i), continues)) {
    if (run.length < 2) continue;
    const weights = run.map((i) => length(sub(walls[i].b, walls[i].a)));
    const weighted = (pick: (w: Wall) => number): number =>
      run.reduce((sum, i, n) => sum + pick(walls[i]) * weights[n], 0) / weights.reduce((sum, w) => sum + w, 0);
    if (isHorizontal(walls[run[0]])) {
      const y = weighted((w) => w.a.y);
      for (const i of run) walls[i] = { ...walls[i], a: { x: walls[i].a.x, y }, b: { x: walls[i].b.x, y } };
    } else {
      const x = weighted((w) => w.a.x);
      for (const i of run) walls[i] = { ...walls[i], a: { x, y: walls[i].a.y }, b: { x, y: walls[i].b.y } };
    }
  }

  for (const corner of corners) {
    const members = corner.map((e) => walls[e.wall]);
    if (corner.length === 1) {
      // A lone end close to the side of another wall is a T-junction: run it up to that wall's line.
      const own = members[0];
      const other = walls.find((w) => w !== own && distanceToWall(at(corner[0]), w) < MERGE_DISTANCE);
      const meet = other ? lineCrossing(own, other) : null;
      if (meet) walls[corner[0].wall] = { ...own, [corner[0].end]: meet };
      continue;
    }
    const horizontal = members.find(isHorizontal);
    const vertical = members.find(isVertical);
    const angled = members.filter((w) => !isHorizontal(w) && !isVertical(w));
    const anchor = horizontal ?? vertical ?? angled[0];
    const crossing = members.map((w) => lineCrossing(anchor, w)).find((p) => p !== null) ?? centroid(corner.map(at));
    const point = { x: vertical ? vertical.a.x : crossing.x, y: horizontal ? horizontal.a.y : crossing.y };
    for (const e of corner) walls[e.wall] = { ...walls[e.wall], [e.end]: point };
  }
  return walls.filter((w) => length(sub(w.b, w.a)) > 0.01);
}

type Axis = "x" | "y";
const span = (w: Wall, axis: Axis): [number, number] => [Math.min(w.a[axis], w.b[axis]), Math.max(w.a[axis], w.b[axis])];
const lengthOf = (w: Wall): number => length(sub(w.b, w.a));

// Moves walls that run along the other axis onto one line, the average of where they are,
// and takes along every wall end that touches one of them.
function alignWalls(walls: Wall[], group: Wall[], axis: Axis): { walls: Wall[]; line: number } {
  const line = group.reduce((sum, w) => sum + w.a[axis] * lengthOf(w), 0) / group.reduce((sum, w) => sum + lengthOf(w), 0);
  const move = (p: Vec): Vec => (group.some((w) => distanceToWall(p, w) < 0.002) ? { ...p, [axis]: line } : p);
  return { walls: walls.map((w) => ({ ...w, a: move(w.a), b: move(w.b) })).filter((w) => lengthOf(w) > 0.01), line };
}

// Each scan draws the wall between two rooms from its own side, so a stitched plan has it twice, a wall's
// thickness apart. Parallel walls that close which run side by side, or continue each other, become one wall.
// Returns the walls and, for the walls that went into another one, the id of the wall they are part of now.
function mergeDoubles(input: Wall[]): { walls: Wall[]; mergedInto: Map<string, string> } {
  const mergedInto = new Map<string, string>();
  let walls = input;
  for (const [axis, across] of [["x", "y"], ["y", "x"]] as const) {
    const parallel = walls.filter((w) => w.a[axis] === w.b[axis]);
    const double = (p: Wall, q: Wall): boolean =>
      Math.abs(p.a[axis] - q.a[axis]) < DOUBLE_WALL && Math.min(span(p, across)[1], span(q, across)[1]) - Math.max(span(p, across)[0], span(q, across)[0]) > -0.01;
    for (const group of groupBy(parallel, double)) {
      if (group.length < 2) continue;
      const ids = new Set(group.map((w) => w.id));
      const aligned = alignWalls(walls, walls.filter((w) => ids.has(w.id)), axis);
      const members = aligned.walls.filter((w) => ids.has(w.id)).sort((p, q) => span(p, across)[0] - span(q, across)[0]);
      const runs: Wall[] = [];
      for (const wall of members) {
        const [from, to] = span(wall, across);
        const run = runs[runs.length - 1];
        if (!run || from > span(run, across)[1] + 0.01) {
          const at = (along: number): Vec => (axis === "x" ? { x: aligned.line, y: along } : { x: along, y: aligned.line });
          runs.push({ ...wall, a: at(from), b: at(to) });
          continue;
        }
        runs[runs.length - 1] = { ...run, b: { ...run.b, [across]: Math.max(run.b[across], to) }, thickness: Math.max(run.thickness, wall.thickness) };
        mergedInto.set(wall.id, run.id);
      }
      walls = [...aligned.walls.filter((w) => !ids.has(w.id)), ...runs];
    }
  }
  return { walls, mergedInto };
}

// The outer walls of scans that were stitched together rarely line up either. Walls close to an edge of the plan
// move onto one line per edge, and short gaps in that line are walled up.
function squareOutside(input: Wall[]): Wall[] {
  type Edge = { axis: Axis; across: Axis; line: number };
  let walls = input;
  const edges: Edge[] = [];
  for (const [axis, across] of [["x", "y"], ["y", "x"]] as const) {
    for (const outermost of [Math.min, Math.max]) {
      const limit = outermost(...walls.flatMap((w) => [w.a[axis], w.b[axis]]));
      const aligned = alignWalls(walls, walls.filter((w) => w.a[axis] === w.b[axis] && Math.abs(w.a[axis] - limit) < OUTER_SNAP), axis);
      walls = aligned.walls;
      edges.push({ axis, across, line: aligned.line });
    }
  }

  const fillers = edges.flatMap(({ axis, across, line }) => {
    const ends = edges.filter((e) => e.axis === across).map((e) => e.line);
    const spans = walls.filter((w) => w.a[axis] === line && w.b[axis] === line).map((w) => span(w, across)).sort((p, q) => p[0] - q[0]);
    const gaps: [number, number][] = [];
    let cursor = Math.min(...ends);
    for (const [from, to] of [...spans, [Math.max(...ends), Math.max(...ends)]]) {
      if (from - cursor > 0.01 && from - cursor < MAX_FILL) gaps.push([cursor, from]);
      cursor = Math.max(cursor, to);
    }
    return gaps.map(([from, to]): Wall => {
      const at = (along: number): Vec => (axis === "x" ? { x: line, y: along } : { x: along, y: line });
      return { id: `outside ${axis} ${line.toFixed(2)} ${from.toFixed(2)}`, a: at(from), b: at(to), thickness: DEFAULT_WALL_THICKNESS };
    });
  });
  return [...walls, ...fillers];
}

// RoomPlan measures furniture up to the surface of a wall, which is the middle of the wall as drawn here.
// Furniture that reaches into a wall is pushed back out, so the two do not overlap.
function clearOfWalls(item: Furniture, walls: Wall[]): Furniture {
  return walls.reduce((moved, wall) => {
    const along = unit(sub(wall.b, wall.a));
    const normal = { x: -along.y, y: along.x };
    const span = length(sub(wall.b, wall.a));
    const middle = sub(centroid(moved.corners), wall.a);
    // A wall the piece is not standing alongside is not its wall, even if a corner pokes past the end of it.
    if (dot(middle, along) < 0 || dot(middle, along) > span) return moved;
    const side = Math.sign(dot(middle, normal)) || 1;
    const depths = moved.corners
      .filter((c) => dot(sub(c, wall.a), along) > 0 && dot(sub(c, wall.a), along) < span)
      .map((c) => wall.thickness / 2 - side * dot(sub(c, wall.a), normal));
    const depth = Math.max(0, ...depths);
    if (depth === 0 || depth > MAX_PUSH) return moved;
    return { ...moved, corners: moved.corners.map((c) => add(c, scale(normal, side * depth))) };
  }, item);
}

// Turns the plan square to the page, straightens it, and moves its top-left corner to the origin.
function tidy(plan: Plan): Plan {
  const angle = dominantAngle(plan.walls);
  const square = mapPlan(plan, (p) => rotate(p, -angle));
  const single = mergeDoubles(joinWalls(square.walls.map(snapToAxis)));
  const walls = squareOutside(single.walls);
  const points = walls.flatMap((w) => [w.a, w.b]);
  const origin = { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) };
  const openings = square.openings.map((o) => ({ ...o, wall: single.mergedInto.get(o.wall) ?? o.wall }));
  const furniture = square.furniture.map((item) => clearOfWalls(item, walls));
  return mapPlan({ ...square, walls, openings, furniture }, (p) => sub(p, origin));
}

// ---- Rooms

// Finds the closed loops of walls. Walks every wall in both directions, always turning into the next wall
// clockwise, which traces rooms with a positive area and the outside of the building with a negative one.
// A loop too small to stand in is a shaft or a chimney, not a room.
function wallLoops(walls: Wall[]): { rooms: Vec[][]; shafts: Vec[][] } {
  const nodes = new Map<string, Vec>(walls.flatMap((w) => [w.a, w.b]).map((p) => [key(p), p]));
  const neighbours = new Map<string, Set<string>>([...nodes.keys()].map((k) => [k, new Set<string>()]));
  for (const wall of walls) {
    const along = sub(wall.b, wall.a);
    const onWall = [...nodes.values()].filter((p) => distanceToWall(p, wall) < 0.002).sort((p, q) => dot(sub(p, q), along));
    for (let i = 1; i < onWall.length; i++) {
      neighbours.get(key(onWall[i - 1]))?.add(key(onWall[i]));
      neighbours.get(key(onWall[i]))?.add(key(onWall[i - 1]));
    }
  }
  const direction = (from: string, to: string): number => {
    const d = sub(nodes.get(to) as Vec, nodes.get(from) as Vec);
    return Math.atan2(d.y, d.x);
  };
  const around = new Map<string, string[]>([...neighbours].map(([k, set]) => [k, [...set].sort((p, q) => direction(k, p) - direction(k, q))]));

  const walked = new Set<string>();
  const rooms: Vec[][] = [];
  const shafts: Vec[][] = [];
  for (const [start, nexts] of around) {
    for (const first of nexts) {
      const outline: Vec[] = [];
      let from = start;
      let to = first;
      while (!walked.has(`${from}>${to}`)) {
        walked.add(`${from}>${to}`);
        outline.push(nodes.get(from) as Vec);
        const turns = around.get(to) as string[];
        const next = turns[(turns.indexOf(from) - 1 + turns.length) % turns.length];
        from = to;
        to = next;
      }
      if (area(outline) > MIN_ROOM_AREA) rooms.push(outline);
      else if (area(outline) > 0.01) shafts.push(outline);
    }
  }
  return { rooms, shafts };
}

// ---- Walls as solids

type Piece = { from: number; to: number; kind: "wall" | "door" | "window" };

// Cuts a wall of the given span into stretches of wall, door gaps and windows.
function wallPieces(from: number, to: number, cuts: Piece[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = from;
  for (const cut of [...cuts].sort((p, q) => p.from - q.from)) {
    const start = Math.max(cut.from, cursor);
    const end = Math.min(cut.to, to);
    if (end - start < 0.01) continue;
    if (start - cursor > 0.01) pieces.push({ from: cursor, to: start, kind: "wall" });
    pieces.push({ from: start, to: end, kind: cut.kind });
    cursor = end;
  }
  if (to - cursor > 0.01) pieces.push({ from: cursor, to, kind: "wall" });
  return pieces;
}

// Walls stop short of the corners they share and a square post fills each corner,
// so no two solids overlap and they can be painted strictly back to front.
function wallBoxes(plan: Plan, palette: Palette): { boxes: Box[]; thresholds: Vec[][] } {
  const ends = plan.walls.flatMap((w) => [{ at: w.a, wall: w }, { at: w.b, wall: w }]);
  const posts = new Map<string, { at: Vec; size: number }>();
  for (const group of groupBy(ends, (p, q) => key(p.at) === key(q.at))) {
    if (group.length > 1) posts.set(key(group[0].at), { at: group[0].at, size: Math.max(...group.map((e) => e.wall.thickness)) });
  }
  const trim = (end: Vec, wall: Wall): number => {
    const post = posts.get(key(end));
    if (post) return post.size / 2;
    const through = plan.walls.find((w) => w !== wall && distanceToWall(end, w) < 0.002);
    return through ? through.thickness / 2 : 0;
  };

  const boxes: Box[] = [...posts.values()].map((post) => ({
    footprint: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }].map((c) => add(post.at, scale(c, post.size / 2))),
    from: 0,
    to: WALL_HEIGHT,
    fill: palette.wall,
  }));
  const thresholds: Vec[][] = [];
  for (const wall of plan.walls) {
    const along = unit(sub(wall.b, wall.a));
    const side = scale({ x: -along.y, y: along.x }, wall.thickness / 2);
    // A door or window stops at the face of a wall that meets this one, so it never eats into the corner.
    const meeting = plan.walls
      .filter((w) => w !== wall)
      .flatMap((w) => [w.a, w.b].filter((end) => distanceToWall(end, wall) < 0.002).map((end) => ({ at: dot(sub(end, wall.a), along), half: w.thickness / 2 })));
    const clear = (cut: Piece): Piece =>
      meeting.reduce((c, m) => {
        if (m.at + m.half <= c.from || m.at - m.half >= c.to) return c;
        return m.at > (c.from + c.to) / 2 ? { ...c, to: m.at - m.half } : { ...c, from: m.at + m.half };
      }, cut);
    const cuts = plan.openings
      .filter((o) => o.wall === wall.id)
      .map((o): Piece => {
        const centre = dot(sub(o.at, wall.a), along);
        return clear({ from: centre - o.width / 2, to: centre + o.width / 2, kind: o.kind });
      });
    for (const piece of wallPieces(trim(wall.a, wall), length(sub(wall.b, wall.a)) - trim(wall.b, wall), cuts)) {
      const start = add(wall.a, scale(along, piece.from));
      const end = add(wall.a, scale(along, piece.to));
      const footprint = [add(start, side), add(end, side), sub(end, side), sub(start, side)];
      if (piece.kind === "door") thresholds.push(footprint);
      if (piece.kind === "wall") boxes.push({ footprint, from: 0, to: WALL_HEIGHT, fill: palette.wall });
      if (piece.kind !== "window") continue;
      // A window is a low sill with a thinner pane of glass standing on it.
      const pane = scale(side, 0.4);
      boxes.push({ footprint, from: 0, to: SILL_HEIGHT, fill: palette.wall });
      boxes.push({ footprint: [add(start, pane), add(end, pane), sub(end, pane), sub(start, pane)], from: SILL_HEIGHT, to: WALL_HEIGHT, fill: palette.glass });
    }
  }
  return { boxes, thresholds };
}

// ---- Furniture as solids

// Longer names first: the first one a category starts with wins.
const KINDS = [
  "bed", "sofa_chaise", "sofa", "chair", "table", "toilet", "bathtub_corner", "bathtub", "sink", "shower", "television", "fireplace_corner", "fireplace",
  "stove", "fridge", "refrigerator", "dishwasher", "washer", "water_heater", "oven", "vacuum_dock",
];
const SOFA_DEPTH = 0.78;
const FIREPLACE_SIDE = 0.25;

// A block of a piece of furniture. `points` outline it on the footprint, across from 0 to 1 and from 0 at the back
// to 1 at the front. `z0` and `z1` are real heights in metres.
type Part = { points: number[][]; z0: number; z1: number; fill: string };
const shape = (points: number[][], z0: number, z1: number, fill: string): Part => ({ points, z0, z1, fill });
const part = (u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, fill: string): Part =>
  shape([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], z0, z1, fill);
const ROUND = Array.from({ length: 12 }, (_, i) => [0.5 + 0.5 * Math.cos((i * Math.PI) / 6), 0.5 + 0.5 * Math.sin((i * Math.PI) / 6)]);

// The shapes follow OpenPlan3D's models: the back of a sofa, the head of a bed and the tank of a toilet are at the back.
function furnitureParts(item: Furniture, width: number, depth: number, c: Palette): Part[] {
  const name = item.category.toLowerCase();
  const kind = KINDS.find((k) => name.startsWith(k)) ?? "storage";
  const h = item.top;
  const u = (metres: number): number => Math.min(0.45, metres / width);
  const v = (metres: number): number => Math.min(0.45, metres / depth);
  const seat = shade(c.fabric, 1.06);

  if (kind === "bed") {
    const top = Math.min(h, 0.55);
    const head = v(0.07);
    const pillows = width > 1.5 ? [[0.08, 0.46], [0.54, 0.92]] : [[0.2, 0.8]];
    return [
      part(0, 1, 0, head, 0, top + 0.35, c.wood),
      part(0, 1, head, 1, 0, top - 0.2, c.wood),
      part(u(0.03), 1 - u(0.03), head, 1 - v(0.03), top - 0.2, top, c.linen),
      ...pillows.map(([from, to]) => part(from, to, head + v(0.08), head + v(0.45), top, top + 0.1, c.pillow)),
      part(u(0.03), 1 - u(0.03), head + v(0.6), 1 - v(0.03), top, top + 0.05, c.duvet),
    ];
  }
  if (kind === "sofa") {
    const back = v(0.22);
    const arm = u(0.16);
    return [
      part(0, 1, 0, back, 0, Math.min(h, 0.85), c.fabric),
      part(0, arm, back, 1, 0, 0.6, c.fabric),
      part(1 - arm, 1, back, 1, 0, 0.6, c.fabric),
      part(arm, 1 - arm, back, 1, 0, 0.42, seat),
    ];
  }
  // An L: a sofa whose seat sticks out at the left end, as seen from the back, to put your legs up on.
  // It has an armrest at both ends like any sofa, and the part that sticks out has neither back nor arms.
  if (kind === "sofa_chaise") {
    const back = v(0.22);
    const arm = u(0.16);
    const along = v(SOFA_DEPTH);
    return [
      part(0, 1, 0, back, 0, Math.min(h, 0.85), c.fabric),
      part(0, arm, back, along, 0, 0.6, c.fabric),
      part(1 - arm, 1, back, along, 0, 0.6, c.fabric),
      part(arm, 1 - arm, back, along, 0, 0.42, seat),
      part(0, u(SOFA_DEPTH), along, 1, 0, 0.42, seat),
    ];
  }
  if (kind === "chair") {
    const back = v(0.07);
    return [part(0.08, 0.92, 0, back, 0, h, c.wood), part(0.08, 0.92, back, 1, 0, 0.45, shade(c.wood, 1.06))];
  }
  if (kind === "table") {
    const legs = [[0, 0], [1 - u(0.07), 0], [0, 1 - v(0.07)], [1 - u(0.07), 1 - v(0.07)]];
    return [...legs.map(([x, y]) => part(x, x + u(0.07), y, y + v(0.07), 0, h - 0.05, c.wood)), part(0, 1, 0, 1, h - 0.05, h, c.wood)];
  }
  if (kind === "toilet") return [part(0.05, 0.95, 0, 0.3, 0, Math.min(h, 0.8), c.ceramic), part(0.15, 0.85, 0.3, 1, 0, 0.42, c.ceramic)];
  // A tub for a corner of the room. Its side towards the room is a quarter circle as big as the tub is deep,
  // which takes up the front right corner.
  if (kind === "bathtub_corner") {
    const rim = Math.min(h, 0.6);
    const round = Math.min(width, depth);
    const quarter = Array.from({ length: 13 }, (_, i) => (i * Math.PI) / 24);
    const outline = (inset: number): number[][] => [
      [inset / width, inset / depth],
      [1 - inset / width, inset / depth],
      ...quarter.map((a) => [1 - (round - (round - inset) * Math.cos(a)) / width, 1 - (round - (round - inset) * Math.sin(a)) / depth]),
      [inset / width, 1 - inset / depth],
    ];
    return [shape(outline(0), 0, rim, c.ceramic), shape(outline(0.07), rim, rim + 0.01, c.water)];
  }
  if (kind === "bathtub") {
    const rim = Math.min(h, 0.6);
    return [
      part(0, 1, 0, v(0.07), 0, rim, c.ceramic),
      part(0, 1, 1 - v(0.07), 1, 0, rim, c.ceramic),
      part(0, u(0.07), v(0.07), 1 - v(0.07), 0, rim, c.ceramic),
      part(1 - u(0.07), 1, v(0.07), 1 - v(0.07), 0, rim, c.ceramic),
      part(u(0.07), 1 - u(0.07), v(0.07), 1 - v(0.07), 0, rim - 0.12, c.water),
    ];
  }
  // RoomPlan measures a basin as a low slab that lies on a piece of storage of its own.
  // A sink that is given its full height brings its own cupboard.
  if (kind === "sink") {
    const basin = [part(0, 1, 0, 1, COUNTER_HEIGHT - 0.04, COUNTER_HEIGHT + 0.02, c.ceramic), part(0.15, 0.85, 0.2, 0.85, COUNTER_HEIGHT + 0.02, COUNTER_HEIGHT + 0.03, c.water)];
    return h > 0.5 ? [part(0, 1, 0, 1, 0, COUNTER_HEIGHT - 0.04, c.wood), ...basin] : basin;
  }
  // A tray in a corner, with glass on the two sides away from the walls.
  if (kind === "shower") {
    return [
      part(0, 1, 0, 1, 0, 0.08, c.ceramic),
      part(0.12, 0.88, 0.12, 0.88, 0.08, 0.09, c.water),
      part(0, 1, 1 - v(0.03), 1, 0.08, 0.9, c.glass),
      part(1 - u(0.03), 1, 0, 1 - v(0.03), 0.08, 0.9, c.glass),
    ];
  }
  if (kind === "television") return [part(0, 1, 0, 1, item.base, h, c.screen)];
  if (kind === "fireplace") {
    return [
      part(0, 0.25, 0, 1, 0, h, c.stone),
      part(0.75, 1, 0, 1, 0, h, c.stone),
      part(0.25, 0.75, 0, 0.9, 0, 0.6, c.screen),
      part(0.25, 0.75, 0, 1, 0.6, h, c.stone),
    ];
  }
  // Fills a corner, the right angle at the back right. The front left is cut off at a slant, which leaves
  // a short flat side against each wall. The opening is a dark plate on the slant.
  if (kind === "fireplace_corner") {
    const left = [0, v(FIREPLACE_SIDE)];
    const right = [1 - u(FIREPLACE_SIDE), 1];
    const slant = (t: number): number[] => [left[0] + t * (right[0] - left[0]), left[1] + t * (right[1] - left[1])];
    const proud = ([x, y]: number[]): number[] => [x - u(0.03), y + v(0.03)];
    return [
      shape([[0, 0], [1, 0], [1, 1], right, left], 0, h, c.stone),
      shape([slant(0.3), slant(0.7), proud(slant(0.7)), proud(slant(0.3))], 0, 0.6, c.screen),
    ];
  }
  if (kind === "stove") {
    const rings = [[0.12, 0.12], [0.58, 0.12], [0.12, 0.58], [0.58, 0.58]];
    return [
      part(0, 1, 0, 1, 0, COUNTER_HEIGHT, c.appliance),
      part(0, 1, 0, 1, COUNTER_HEIGHT, COUNTER_HEIGHT + 0.03, c.screen),
      ...rings.map(([x, y]) => part(x, x + 0.3, y, y + 0.3, COUNTER_HEIGHT + 0.03, COUNTER_HEIGHT + 0.04, c.appliance)),
    ];
  }
  if (kind === "fridge" || kind === "refrigerator") return [part(0, 1, 0, 1, 0, h, c.appliance), part(0.08, 0.14, 1, 1 + v(0.04), 0.5, 1.1, c.screen)];
  // A row of buttons along the top of the door.
  if (kind === "dishwasher") return [part(0, 1, 0, 1 - v(0.06), 0, h, c.appliance), part(0, 1, 1 - v(0.06), 1, 0, h - 0.1, c.appliance), part(0, 1, 1 - v(0.06), 1, h - 0.1, h, c.screen)];
  // A porthole in the door.
  if (kind === "washer") return [part(0, 1, 0, 1, 0, h, c.appliance), part(0.2, 0.8, 1, 1 + v(0.03), 0.2, 0.65, c.screen)];
  if (kind === "water_heater") return [shape(ROUND, 0, h, c.appliance)];
  if (kind === "oven") return [part(0, 1, 0, 1, 0, h, c.appliance)];
  // A tower at the back, and the round robot parked on the ramp in front of it.
  if (kind === "vacuum_dock") {
    const robot = ROUND.map(([x, y]) => [0.5 + (x - 0.5) * 2 * u(0.17), 0.7 + (y - 0.5) * 2 * v(0.17)]);
    return [part(0, 1, 0, 0.4, 0, h, c.appliance), part(0, 1, 0.4, 1, 0, 0.03, c.appliance), shape(robot, 0.03, 0.13, c.screen)];
  }
  return [part(0, 1, 0, 1, item.base, h, c.wood)];
}

// How high a real height is drawn.
const drawnHeight = (metres: number): number => Math.min(metres, CUT_HEIGHT) * HEIGHT_SCALE;

function furnitureBoxes(item: Furniture, palette: Palette): Box[] {
  const [, frontLeft, backLeft, backRight] = item.corners;
  const across = sub(backRight, backLeft);
  const deep = sub(frontLeft, backLeft);
  return furnitureParts(item, length(across), length(deep), palette)
    .filter((p) => drawnHeight(p.z1) - drawnHeight(p.z0) > 0.001)
    .map((p) => ({
      footprint: p.points.map(([u, v]) => add(backLeft, add(scale(across, u), scale(deep, v)))),
      from: drawnHeight(p.z0),
      to: drawnHeight(p.z1),
      fill: p.fill,
    }));
}

// ---- Painting order

// The viewer looks along (-1, -1) in plan coordinates: x + y is how near a point is, x - y is where it lands sideways.
const sideways = (p: Vec): number => p.x - p.y;
const nearness = (p: Vec): number => p.x + p.y;

// The nearness range a footprint covers along the view line at one sideways position.
function nearnessAt(footprint: Vec[], where: number): [number, number] {
  const hits = footprint.flatMap((p, i) => {
    const q = footprint[(i + 1) % footprint.length];
    const sp = sideways(p) - where;
    const sq = sideways(q) - where;
    if (sp * sq > 0) return [];
    if (sp === sq) return [nearness(p), nearness(q)];
    return [nearness(p) + ((nearness(q) - nearness(p)) * sp) / (sp - sq)];
  });
  return [Math.min(...hits), Math.max(...hits)];
}

// 1 when `a` hides part of `b`, -1 the other way round, 0 when neither can cover the other.
function inFront(a: Box, b: Box): number {
  const left = Math.max(Math.min(...a.footprint.map(sideways)), Math.min(...b.footprint.map(sideways)));
  const right = Math.min(Math.max(...a.footprint.map(sideways)), Math.max(...b.footprint.map(sideways)));
  if (right - left < EPSILON) return 0;
  const [aNear, aFar] = nearnessAt(a.footprint, (left + right) / 2);
  const [bNear, bFar] = nearnessAt(b.footprint, (left + right) / 2);
  if (aNear >= bFar - EPSILON) return 1;
  if (bNear >= aFar - EPSILON) return -1;
  // One stands on, or hangs over, the other: seen from above, the higher one hides the lower one.
  if (a.from >= b.to - EPSILON) return 1;
  if (b.from >= a.to - EPSILON) return -1;
  return Math.sign(aNear + aFar - bNear - bFar);
}

// Back to front. Boxes that overlap in the scan can ask for an impossible order;
// then the one whose centre is furthest away goes first.
function paintOrder(solids: Box[]): Box[] {
  const waitingFor = solids.map(() => 0);
  const hides: number[][] = solids.map(() => []);
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const order = inFront(solids[i], solids[j]);
      if (order === 0) continue;
      const [back, front] = order > 0 ? [j, i] : [i, j];
      hides[back].push(front);
      waitingFor[front]++;
    }
  }
  const centre = solids.map((s) => mean(s.footprint.map(nearness)));
  const left = new Set(solids.map((_, i) => i));
  const ordered: Box[] = [];
  while (left.size > 0) {
    const free = [...left].filter((i) => waitingFor[i] === 0);
    const next = (free.length > 0 ? free : [...left]).reduce((best, i) => (centre[i] < centre[best] ? i : best));
    left.delete(next);
    ordered.push(solids[next]);
    for (const front of hides[next]) waitingFor[front]--;
  }
  return ordered;
}

// ---- Drawing

// Both floor axes run at the same slant off the horizontal, one to each side, and height runs straight up.
function project(p: Vec, z = 0): Vec {
  return { x: (p.x - p.y) * COS30 * PIXELS_PER_METRE, y: ((p.x + p.y) * RISE - z * LIFT) * PIXELS_PER_METRE };
}

function shade(colour: string, brightness: number): string {
  const channels = [1, 3, 5].map((i) => Math.round(Math.min(255, parseInt(colour.slice(i, i + 2), 16) * brightness)));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// A hairline stroke in the fill colour hides the seams between faces that touch.
function polygon(points: Vec[], fill: string): string {
  const list = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return `<polygon points="${list}" fill="${fill}" stroke="${fill}" stroke-width="0.6" stroke-linejoin="round"/>`;
}

function drawBox(box: Box): string[] {
  const clockwise = area(box.footprint) < 0 ? [...box.footprint].reverse() : box.footprint;
  const sides = clockwise.flatMap((p, i) => {
    const q = clockwise[(i + 1) % clockwise.length];
    const outward = unit({ x: q.y - p.y, y: p.x - q.x });
    if (outward.x + outward.y <= EPSILON) return [];
    const face = [project(p, box.from), project(q, box.from), project(q, box.to), project(p, box.to)];
    return [polygon(face, shade(box.fill, 0.88 + 0.05 * (outward.x - outward.y)))];
  });
  return [...sides, polygon(clockwise.map((p) => project(p, box.to)), box.fill)];
}

type Frame = { left: number; top: number; width: number; height: number };

function frameOf(plan: Plan): Frame {
  const points = [...plan.walls.flatMap((w) => [w.a, w.b]), ...plan.furniture.flatMap((f) => f.corners)];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const corners = [
    { x: Math.min(...xs) - MARGIN, y: Math.min(...ys) - MARGIN },
    { x: Math.max(...xs) + MARGIN, y: Math.min(...ys) - MARGIN },
    { x: Math.max(...xs) + MARGIN, y: Math.max(...ys) + MARGIN },
    { x: Math.min(...xs) - MARGIN, y: Math.max(...ys) + MARGIN },
  ];
  const screen = [...corners.map((c) => project(c)), ...corners.map((c) => project(c, WALL_HEIGHT))];
  const left = Math.min(...screen.map((p) => p.x));
  const top = Math.min(...screen.map((p) => p.y));
  return { left, top, width: Math.max(...screen.map((p) => p.x)) - left, height: Math.max(...screen.map((p) => p.y)) - top };
}

// `plan` is already turned to the viewing angle.
function drawPlan(plan: Plan, frame: Frame, palette: Palette): string {
  const { boxes, thresholds } = wallBoxes(plan, palette);
  const furniture = plan.furniture.flatMap((item) => furnitureBoxes(item, palette));
  const { rooms: outlines, shafts } = wallLoops(plan.walls);
  // A shaft is solid: a lid at the height of the walls closes it.
  const lids = shafts.map((outline): Box => ({ footprint: outline, from: WALL_HEIGHT, to: WALL_HEIGHT, fill: palette.wall }));
  // A room the walls do not close has no outline. It then gets its floor from one slab under the whole plan.
  const allClosed = plan.rooms.every((room) => outlines.some((outline) => contains(outline, room.at)));
  const ground = allClosed && outlines.length > 0 ? [] : [convexHull(plan.walls.flatMap((w) => [w.a, w.b]))];
  const box = [frame.left, frame.top, frame.width, frame.height].map((n) => n.toFixed(1)).join(" ");
  // A blurred copy of the plan's outline, a little below it, as a soft shadow on the page.
  const shadow = convexHull(plan.walls.flatMap((w) => [w.a, w.b])).map((p) => add(project(p), { x: 0, y: 0.12 * PIXELS_PER_METRE }));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">`,
    '<defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter></defs>',
    `<polygon points="${shadow.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${palette.shadow}" opacity="0.16" filter="url(#soft)"/>`,
    ...ground.map((slab) => polygon(slab.map((p) => project(p)), palette.ground)),
    ...outlines.map((outline) => polygon(outline.map((p) => project(p)), palette.floor)),
    ...thresholds.map((strip) => polygon(strip.map((p) => project(p)), palette.threshold)),
    ...paintOrder([...boxes, ...lids, ...furniture]).flatMap(drawBox),
    "</svg>",
    "",
  ].join("\n");
}

function planCorners(plan: Plan): Vec[] {
  const points = plan.walls.flatMap((w) => [w.a, w.b]);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return [
    { x: Math.min(...xs), y: Math.min(...ys) },
    { x: Math.max(...xs), y: Math.min(...ys) },
    { x: Math.max(...xs), y: Math.max(...ys) },
    { x: Math.min(...xs), y: Math.max(...ys) },
  ];
}

// ---- Dashboard

// What the card needs to show the plan from one corner: the two drawings, their shape,
// and where on them each entity's icon and each room's name goes, in percent.
type View = { light: string; dark: string; aspect: number; elements: object[]; labels: object[] };
type NamedRoom = { name: string; outline: Vec[]; corner: Vec; size: Vec; middle: Vec };

function cardView(placements: Placement[], rooms: NamedRoom[], turns: number, frame: Frame, drawings: { light: string; dark: string }): View {
  const spot = (p: Vec, height: number): { left: number; top: number } => {
    const at = project(quarterTurns(p, turns), height);
    return { left: Number((((at.x - frame.left) / frame.width) * 100).toFixed(2)), top: Number((((at.y - frame.top) / frame.height) * 100).toFixed(2)) };
  };
  const elements = placements.map((placement) => ({
    entity: placement.entity,
    ...(placement.icon ? { icon: placement.icon } : {}),
    ...spot(placement, drawnHeight(placement.z ?? 0)),
  }));
  const labels = rooms.map((room) => ({ name: room.name, ...spot(room.middle, 0) }));
  return { ...drawings, aspect: Number((frame.width / frame.height).toFixed(4)), elements, labels };
}

function dashboard(views: View[]): object {
  const card = { type: "custom:floorplan-card", views };
  return { title: "Floorplan", views: [{ title: "Floorplan", path: "floorplan", type: "panel", cards: [card] }] };
}

// ---- Main

function main(): void {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error("usage: node floorplan/floorplan.ts <data-dir>");
    process.exit(1);
  }

  const scan = JSON.parse(readFileSync(join(dataDir, "scan.json"), "utf8")) as Scan;
  const placementsFile = join(dataDir, "placements.json");
  const placements = existsSync(placementsFile) ? (JSON.parse(readFileSync(placementsFile, "utf8")) as Placement[]) : [];
  const plan = tidy(readPlan(scan));

  // Every named room with its outline's top-left corner, which placements are measured from.
  const outlines = wallLoops(plan.walls).rooms;
  const named = plan.rooms.flatMap((room): NamedRoom[] => {
    const outline = room.name === "" ? undefined : outlines.find((o) => contains(o, room.at));
    if (!outline) return [];
    const corner = { x: Math.min(...outline.map((p) => p.x)), y: Math.min(...outline.map((p) => p.y)) };
    const size = sub({ x: Math.max(...outline.map((p) => p.x)), y: Math.max(...outline.map((p) => p.y)) }, corner);
    // The name goes in the middle of the room, unless the room bends around that point.
    const middle = add(corner, scale(size, 0.5));
    return [{ name: room.name, outline, corner, size, middle: contains(outline, middle) ? middle : room.at }];
  });
  const onPlan = placements.map((placement) => {
    const room = named.find((r) => r.name === placement.room);
    if (!room) throw new Error(`placements.json: ${placement.entity} is in "${placement.room}", which is not a room on the plan`);
    return { ...placement, ...add(room.corner, placement) };
  });

  // One pair of drawings for each corner the card can look from.
  const views = [0, 1, 2, 3].map((turns) => {
    const turned = mapPlan(plan, (p) => quarterTurns(p, turns));
    const frame = frameOf(turned);
    const draw = (theme: "light" | "dark"): string => {
      const svg = drawPlan(turned, frame, PALETTES[theme]);
      const file = `floorplan-${theme}-${turns}.svg`;
      writeFileSync(join(dataDir, file), svg);
      // Home Assistant caches /local files for a long time. The hash makes a new drawing a new address.
      return `/local/floorplan/${file}?v=${createHash("sha256").update(svg).digest("hex").slice(0, 8)}`;
    };
    return cardView(onPlan, named, turns, frame, { light: draw("light"), dark: draw("dark") });
  });
  writeFileSync(join(dataDir, "dashboard.json"), `${JSON.stringify(dashboard(views), null, 2)}\n`);

  // The rooms and what stands in them, in the coordinates placements use.
  const size = planCorners(plan)[2];
  console.log(`plan ${size.x.toFixed(2)} x ${size.y.toFixed(2)} m, ${named.length} named rooms`);
  for (const room of named) {
    console.log(`${room.name}  ${room.size.x.toFixed(2)} x ${room.size.y.toFixed(2)} m`);
    for (const item of plan.furniture) {
      const at = sub(centroid(item.corners), room.corner);
      if (contains(room.outline, centroid(item.corners))) console.log(`  ${item.category.padEnd(18)} x ${at.x.toFixed(2)}  y ${at.y.toFixed(2)}`);
    }
  }
  console.log(`wrote 8 drawings and dashboard.json to ${dataDir} (${placements.length} placements)`);
}

main();
