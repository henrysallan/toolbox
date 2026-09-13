// check-lyapunov: logistic-map Lyapunov exponent — sequence parse, bit pack,
// sign at known r, r=4 ≈ ln(2), and A=B making the sequence irrelevant.
//
//   npx tsx scripts/check-lyapunov.mts

import {
  lyapunovExponent,
  lyapunovNode,
  MAX_LYAPUNOV_SEQ,
  parseLyapunovSequence,
  packLyapunovBits,
  sequenceFromParams,
} from "../src/nodes/source/lyapunov.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

// --- parse ---
check(
  "parse AABAB",
  JSON.stringify(parseLyapunovSequence("AABAB")) === JSON.stringify([0, 0, 1, 0, 1])
);
check(
  "parse is case-insensitive and drops junk",
  JSON.stringify(parseLyapunovSequence("aa bab!C")) ===
    JSON.stringify([0, 0, 1, 0, 1])
);
check(
  "parse drops letters other than A/B",
  JSON.stringify(parseLyapunovSequence("AACAB")) === JSON.stringify([0, 0, 0, 1])
);
check(
  "parse empty falls back to AB",
  JSON.stringify(parseLyapunovSequence("")) === JSON.stringify([0, 1])
);
check(
  "parse truncates at MAX_LYAPUNOV_SEQ",
  parseLyapunovSequence("AB".repeat(40)).length === MAX_LYAPUNOV_SEQ
);

const packed = packLyapunovBits([0, 0, 1, 0, 1]);
check("pack AABAB bits", packed === 0b10100);

const longBits = packLyapunovBits(new Array(32).fill(1));
check("pack 32 B's is unsigned", longBits === 0xffffffff);

// --- params ---
check(
  "preset AABAB ignores custom string",
  JSON.stringify(sequenceFromParams({ preset: "AABAB", sequence: "BB" })) ===
    JSON.stringify([0, 0, 1, 0, 1])
);
check(
  "preset custom uses sequence",
  JSON.stringify(sequenceFromParams({ preset: "custom", sequence: "BBABABA" })) ===
    JSON.stringify([1, 1, 0, 1, 0, 1, 0])
);

// --- exponent ---
const r32 = lyapunovExponent({
  sequence: [0],
  a: 3.2,
  b: 3.2,
  x0: 0.5,
  warmup: 200,
  iterations: 200,
});
check(
  "r=3.2 (period-2) is stable (λ < 0)",
  !r32.diverged && r32.lambda < 0,
  `λ=${r32.lambda} diverged=${r32.diverged}`
);

const r39 = lyapunovExponent({
  sequence: [0],
  a: 3.9,
  b: 3.9,
  x0: 0.5,
  warmup: 200,
  iterations: 200,
});
check(
  "r=3.9 (chaotic) is λ > 0",
  !r39.diverged && r39.lambda > 0,
  `λ=${r39.lambda} diverged=${r39.diverged}`
);

// r=4, x0≠0.5 so we don't land on the critical-point orbit 0.5 → 1 → 0.
const r4 = lyapunovExponent({
  sequence: [0],
  a: 4,
  b: 4,
  x0: 0.1,
  warmup: 400,
  iterations: 400,
});
check(
  "r=4 ≈ ln(2)",
  !r4.diverged && close(r4.lambda, Math.log(2), 0.02),
  `λ=${r4.lambda} ln2=${Math.log(2)} diverged=${r4.diverged}`
);

const r2 = lyapunovExponent({
  sequence: [0],
  a: 2,
  b: 2,
  x0: 0.5,
  warmup: 10,
  iterations: 50,
});
check(
  "r=2 at x0=0.5 is superstable (floored log)",
  !r2.diverged && r2.lambda < -40,
  `λ=${r2.lambda} diverged=${r2.diverged}`
);

const ab = lyapunovExponent({
  sequence: parseLyapunovSequence("AB"),
  a: 3.5,
  b: 3.5,
  x0: 0.4,
  warmup: 100,
  iterations: 100,
});
const aabab = lyapunovExponent({
  sequence: parseLyapunovSequence("AABAB"),
  a: 3.5,
  b: 3.5,
  x0: 0.4,
  warmup: 100,
  iterations: 100,
});
check(
  "A=B makes sequence irrelevant",
  !ab.diverged && !aabab.diverged && close(ab.lambda, aabab.lambda, 1e-9),
  `AB=${ab.lambda} AABAB=${aabab.lambda}`
);

// Hand-unrolled three steps, deriv-before-update, sequence AB, x0=0.4.
{
  const a = 3;
  const b = 3.5;
  let x = 0.4;
  let sum = 0;
  // i=0 r=A
  sum += Math.log(Math.max(Math.abs(a * (1 - 2 * x)), 1e-20));
  x = a * x * (1 - x);
  // i=1 r=B
  sum += Math.log(Math.max(Math.abs(b * (1 - 2 * x)), 1e-20));
  x = b * x * (1 - x);
  // i=2 r=A
  sum += Math.log(Math.max(Math.abs(a * (1 - 2 * x)), 1e-20));
  x = a * x * (1 - x);
  const expected = sum / 3;
  const got = lyapunovExponent({
    sequence: [0, 1],
    a,
    b,
    x0: 0.4,
    warmup: 0,
    iterations: 3,
  });
  check(
    "hand-unrolled AB, 3 iters",
    !got.diverged && got.n === 3 && close(got.lambda, expected, 1e-12),
    `got=${got.lambda} expected=${expected} n=${got.n}`
  );
}

const edge = lyapunovExponent({
  sequence: [0],
  a: 4,
  b: 4,
  x0: 0.5,
  warmup: 0,
  iterations: 10,
});
check(
  "r=4 x0=0.5 diverges (0.5 → 1)",
  edge.diverged,
  `λ=${edge.lambda} n=${edge.n}`
);

check("def type is lyapunov", lyapunovNode.type === "lyapunov");
check("def is an image generator", lyapunovNode.category === "image");
check(
  "facts gotchas present",
  (lyapunovNode.facts?.gotchas?.length ?? 0) >= 4
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
