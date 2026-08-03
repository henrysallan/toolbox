// Shared ruler tick spacing for the tick-based timeline editors: pick a
// major frame interval so on-screen spacing is ~targetPx and the step is
// a "nice" frame number (1, 2, 5, 10, 20, 50, 100, ...).

export interface RulerSpacing {
  majorFrames: number;
  minorFrames: number;
}

export function rulerSpacing(
  pixelsPerTick: number,
  ticksPerFrame: number,
  targetPx = 80
): RulerSpacing {
  const pxPerFrame = pixelsPerTick * ticksPerFrame;
  if (pxPerFrame <= 0) return { majorFrames: 60, minorFrames: 10 };
  const rawFrames = targetPx / pxPerFrame;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawFrames))));
  const norm = rawFrames / pow;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3.5) nice = 2;
  else if (norm < 7.5) nice = 5;
  else nice = 10;
  const majorFrames = Math.max(1, Math.round(nice * pow));
  const minorFrames = Math.max(1, Math.round(majorFrames / 5));
  return { majorFrames, minorFrames };
}
