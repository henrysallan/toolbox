// check-material-3d: Ambient Occlusion UV bake (concave corner darker
// than open faces; a plane stays white) and MaterialDesc class/sig
// (clearcoat upgrades to physical; AO map moves the fingerprint).
//
//   npx tsx scripts/check-material-3d.mts

import type { ImageValue } from "../src/engine/types.ts";
import { bakeAmbientOcclusion } from "../src/engine/ao-bake.ts";
import {
  makeMaterialDesc,
  materialClassFor,
} from "../src/engine/three-geometry.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sampleR(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  u: number,
  v: number
): number {
  const x = Math.round(u * (w - 1));
  const y = Math.round((1 - v) * (h - 1));
  return pixels[(y * w + x) * 4]!;
}

// Two quads meeting at 90° along the Y axis (a concave book-corner).
// Floor z=0, x∈[0,1], UV in the left half; wall x=0, z∈[0,1], UV in
// the right half. Unique UVs so the bake doesn't overlap.
function lCorner() {
  // floor: (0,0,0) (1,0,0) (1,1,0) (0,1,0)
  // wall:  (0,0,0) (0,0,1) (0,1,1) (0,1,0)
  const positions = new Float32Array([
    // floor
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    // wall (duplicated crease verts so each face keeps its normal)
    0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]);
  const uvs = new Float32Array([
    0, 0, 0.5, 0, 0.5, 1, 0, 1,
    0.5, 0, 1, 0, 1, 1, 0.5, 1,
  ]);
  const index = [
    0, 1, 2, 0, 2, 3, // floor
    4, 5, 6, 4, 6, 7, // wall
  ];
  return { positions, normals, uvs, index, vertexCount: 8 };
}

{
  const mesh = lCorner();
  const baked = bakeAmbientOcclusion({
    ...mesh,
    resolution: 64,
    samples: 32,
    radius: 0.9,
    seed: 7,
  });
  check("AO bake size", baked.width === 64 && baked.height === 64);
  const crease = sampleR(baked.pixels, 64, 64, 0.06, 0.5);
  const open = sampleR(baked.pixels, 64, 64, 0.42, 0.5);
  check(
    "concave crease is darker than the open floor",
    crease < open - 20,
    `crease=${crease} open=${open}`
  );
  check(
    "open floor stays mostly unoccluded",
    open > 180,
    `open=${open}`
  );
}

{
  // Unit plane in XY, z=0, outward +Z. Convex — no self-occlusion.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  ]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const baked = bakeAmbientOcclusion({
    positions,
    normals,
    uvs,
    index: [0, 1, 2, 0, 2, 3],
    vertexCount: 4,
    resolution: 32,
    samples: 16,
    radius: 1,
    seed: 1,
  });
  const mid = sampleR(baked.pixels, 32, 32, 0.5, 0.5);
  check("plane center is unoccluded", mid > 240, `mid=${mid}`);
}

{
  const base = makeMaterialDesc({
    baseColor: "#cccccc",
    roughness: 0.5,
    metalness: 0,
    transmission: 0,
    ior: 1.5,
    alpha: 1,
  });
  check("default PBR is standard class", materialClassFor(base) === "standard");

  const glass = makeMaterialDesc({ ...base, transmission: 0.8 });
  check("transmission upgrades to physical", materialClassFor(glass) === "physical");

  const coat = makeMaterialDesc({ ...base, clearcoat: 0.6, clearcoatRoughness: 0.1 });
  check("clearcoat upgrades to physical", materialClassFor(coat) === "physical");

  const cloth = makeMaterialDesc({ ...base, sheen: 0.8, sheenColor: "#4466aa" });
  check("sheen upgrades to physical", materialClassFor(cloth) === "physical");

  const toon = makeMaterialDesc({ ...base, shading: "toon", clearcoat: 1 });
  check("toon wins over clearcoat", materialClassFor(toon) === "toon");

  const fakeImg = { kind: "image", texture: {} as WebGLTexture, width: 8, height: 8 } as ImageValue;
  const withAo = makeMaterialDesc({
    ...base,
    ao: { map: fakeImg, intensity: 1 },
  });
  check("AO map moves material sig", withAo.sig !== base.sig);

  const withEmissive = makeMaterialDesc({
    ...base,
    emissive: "#ff4400",
    emissiveIntensity: 2,
  });
  check("emissive moves material sig", withEmissive.sig !== base.sig);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll material/AO checks passed.");
