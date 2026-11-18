/**
 * The printer's teardown. site/models/blender/build_printer.py writes printer-parts.json beside printer.glb: each
 * part's object name and label, in the order the labels number them, and the printer's sizes. This file adds how
 * the page lays out each part. `anchor` is the point a leader line starts from, in metres on the assembled printer.
 * `lift` is the part's turn in the top-down teardown (parts that share a turn lift together). The build plate never
 * lifts: it is where the story goes next.
 */
import printer from "../assets/story/printer-parts.json" with { type: "json" };

type Layout = {
  /** The label on narrow screens, when it is shorter than the part's label. */
  short?: string;
  anchor: readonly [x: number, y: number, z: number];
  side: "left" | "right";
  lift: number | null;
};

const LAYOUT = {
  lid: { short: "Glass lid", anchor: [0.15, 0.476, 0.16], side: "right", lift: 0 },
  screen: { anchor: [-0.04, 0.47, 0.215], side: "right", lift: 1 },
  top_frame: { anchor: [0.196, 0.445, 0.1], side: "right", lift: 2 },
  toolhead: { anchor: [0.034, 0.385, 0.085], side: "right", lift: 3 },
  gantry: { short: "CoreXY gantry", anchor: [0.16, 0.392, -0.04], side: "right", lift: 4 },
  door: { anchor: [-0.1, 0.33, 0.203], side: "left", lift: 5 },
  panel_left: { anchor: [-0.196, 0.3, 0], side: "left", lift: 6 },
  panel_right: { anchor: [0.196, 0.25, 0.06], side: "right", lift: 6 },
  panel_back: { anchor: [0.12, 0.36, -0.203], side: "right", lift: 7 },
  frame: { short: "Frame, Z rods", anchor: [0.182, 0.34, 0.188], side: "right", lift: 8 },
  // The heatbed reads from its left edge, so the bottom right does not crowd with the side panel and the plate.
  bed: { anchor: [-0.131, 0.158, 0.06], side: "left", lift: 9 },
  base: { anchor: [0.196, 0.03, 0.12], side: "right", lift: 10 },
  build_plate: { short: "Build plate", anchor: [0.11, 0.165, 0.1], side: "right", lift: null },
} as const satisfies Record<string, Layout>;

const laidOut = (name: string): name is keyof typeof LAYOUT => Object.hasOwn(LAYOUT, name);

export const PARTS = printer.parts.map(({ name, label }) => {
  if (!laidOut(name)) throw new Error(`printer-parts.json: the teardown has no layout for ${name}`);
  const layout: Layout = LAYOUT[name];
  return { name, label, short: layout.short ?? label, anchor: layout.anchor, side: layout.side, lift: layout.lift };
});
const named = new Set(PARTS.map((part) => part.name));
if (named.size !== PARTS.length || named.size !== Object.keys(LAYOUT).length) {
  throw new Error("printer-parts.json must name each laid-out part exactly once");
}

export type Part = (typeof PARTS)[number];

/** The parts that lift, the count the readout shows. */
export const LIFTED_PARTS = PARTS.filter((part) => part.lift !== null).length;

const plate = PARTS.find((part) => part.lift === null);
if (!plate) throw new Error("the teardown has no part that stays put");

function size(values: readonly number[], what: string): readonly [number, number, number] {
  const [x, y, z, ...rest] = values;
  if (x === undefined || y === undefined || z === undefined || rest.length > 0) throw new Error(`printer-parts.json: ${what} needs 3 numbers`);
  return [x, y, z];
}
const [areaW, areaD] = size(printer.build_volume_mm, "build_volume_mm");

/** The part left standing at the end of the teardown, with the printer's outer size and print area in mm. */
export const PRINTER = { plate: plate.label, outerMm: size(printer.outer_mm, "outer_mm"), areaMm: [areaW, areaD] };
