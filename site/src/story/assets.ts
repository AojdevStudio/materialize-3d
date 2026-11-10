/**
 * The 3D story's models, loaded once and parsed into typed values. The GLBs and the
 * JSON come from the scripts in site/models, which name every object the scene uses.
 */
import { Vector2, Vector3, type Group } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import dockUrl from "../assets/story/dock.glb?url";
import slicesFile from "../assets/story/dock-slices.json";
import printerFile from "../assets/story/printer-parts.json";
import printerUrl from "../assets/story/printer.glb?url";
import { PARTS, type Part } from "./parts";

export type Edge = { a: Vector2; b: Vector2; length: number };

/** One slice of the printed part: its outlines at height z (mm), and the longest outline, which the nozzle follows. */
export type Slice = { z: number; loops: readonly (readonly Edge[])[]; path: { edges: readonly Edge[]; length: number } };

export type Models = {
  printer: Group;
  dock: Group;
  /** The build plate's top centre, in metres. */
  plateTop: Vector3;
  /** Each part with its explode offset in metres, in PARTS order. */
  parts: readonly { part: Part; offset: Vector3 }[];
  slices: readonly Slice[];
};

function vector3(values: readonly number[], what: string): Vector3 {
  if (values.length !== 3) throw new Error(`printer-parts.json: ${what} needs 3 numbers, got ${values.length}`);
  return new Vector3().fromArray(values);
}

function points(flat: readonly number[]): Vector2[] {
  const out: Vector2[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (x === undefined || y === undefined) throw new Error("dock-slices.json: an outline has an odd number of values");
    out.push(new Vector2(x, y));
  }
  return out;
}

/** Each point with the next one, wrapping to the first: the edges of a closed outline. */
function edges(loop: readonly Vector2[]): Edge[] {
  return loop.map((a, i) => {
    // (i + 1) % length is always an index of loop.
    const b = loop[(i + 1) % loop.length] as Vector2;
    return { a, b, length: a.distanceTo(b) };
  });
}

const parts = PARTS.map((part) => {
  const row = printerFile.parts.find((candidate) => candidate.name === part.name);
  if (!row) throw new Error(`printer-parts.json has no part named ${part.name}`);
  return { part, offset: vector3(row.offset, `${part.name} offset`) };
});

const slices: Slice[] = slicesFile.slices.map((slice) => {
  const loops = slice.polys.map((poly) => edges(points(poly)));
  let path: Slice["path"] = { edges: [], length: 0 };
  for (const loop of loops) {
    const length = loop.reduce((sum, edge) => sum + edge.length, 0);
    if (length > path.length) path = { edges: loop, length };
  }
  if (path.edges.length === 0) throw new Error(`dock-slices.json: the slice at ${slice.z} mm has no outline`);
  return { z: slice.z, loops, path };
});
if (slices.length === 0) throw new Error("dock-slices.json has no slices");

export async function loadModels(): Promise<Models> {
  const loader = new GLTFLoader();
  const [printer, dock] = await Promise.all([loader.loadAsync(printerUrl), loader.loadAsync(dockUrl)]);
  return { printer: printer.scene, dock: dock.scene, plateTop: vector3(printerFile.plate_top_center, "plate_top_center"), parts, slices };
}
