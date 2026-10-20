// After Effects export — conversion math (spec 091926_after-effects-handoff.md
// §4, Appendix A/B). Pure TypeScript, gated offline by
// scripts/ae-export/check-convert-*.mts (`npx tsx scripts/check-ae-export.mts
// convert`). Everything returned is already in AE terms — layer px, seconds,
// degrees, percent, 0–1 colors — so build.jsx never does math.
//
// Named re-exports, not `export *`: tsx loads these .ts files as CommonJS for
// the .mts gates, and Node cannot see star re-exports through that.

export {
  ticksPerFrameOf,
  ticksToSeconds,
  secondsToTicks,
  framesToSeconds,
  frameToTick,
  localTickToCompSeconds,
  compDurationSeconds,
  layerClockOffsetTicks,
  layerTimings,
} from "./time";
export type {
  AeTimebase,
  AeLayerTiming,
} from "./time";
export {
  canvasXToPx,
  canvasYToPx,
  pxToCanvasX,
  pxToCanvasY,
  canvasToPx,
  pxToCanvas,
  canvasDeltaToPx,
  pxDeltaToCanvas,
  canvasAxisAffine,
  widthRelativeToPx,
  strokeWidthToPx,
  uv01ToPx,
  pxToUv01,
  uv01AxisAffine,
  uv01ToCanvas,
  canvasToUv01,
  DEG_PER_RAD,
  radToDeg,
  degToRad,
  subpathToAePath,
  splineToAePaths,
  AE_ROUND_CORNER_KAPPA,
  aeRoundCornersPath,
  pathDeviationPx,
  planCorners,
} from "./coords";
export type {
  AeCanvas,
  Vec2,
  AeCornerPlan,
} from "./coords";
export {
  AE_INFLUENCE_MIN,
  AE_INFLUENCE_MAX,
  clampInfluence,
  cubicToAeEase,
  aeEaseToCubic,
  cubicPiece,
  pieceEases,
  pieceControlPoints,
  solveCubicX,
  evaluatePiece,
  evaluatePieces,
  piecesMonotone,
  mirrorCubic,
  ELASTIC_EXTREMA,
  AE_EASINGS,
  aeEasingRow,
  planSegmentEase,
  planError,
} from "./easing";
export type {
  AeEasePiece,
  AeEasePlan,
  AeEasingClass,
  AeEasingRow,
} from "./easing";
export {
  parseAnimationKey,
  animationKeyParamType,
  AE_COLOR_EASE_SCALE,
  AE_SHAPE_EASE_MAGNITUDE,
  evaluateAeKeys,
  evaluateAeProp,
  evaluateAePathProp,
  component,
  frameTime,
  isKeyed,
  partsOracle,
  numericTrackToAe,
  combinedTracksToAe,
  tracksShareTiming,
  spatialTrackToAe,
  sampledTrackToAe,
  keyFrameSpan,
  stepTrackToAe,
  splineTrackToAe,
  verifyAeProp,
} from "./keys";
export type {
  AeAnimationKey,
  AeEaseMode,
  AeKeyContext,
  AeAffine,
  AeTrackReport,
  AeTrackResult,
  AeTrackSource,
  AeNumericOptions,
  AePathTrackResult,
} from "./keys";
export {
  opToAeStatic,
  opToAeLayerTransform,
  opToAeShapeTransform,
  aeTransformToAffine,
  canvasAffineToPx,
  transformChainToAe,
  chainToAffine,
  opsToPxAffine,
  opToPxAffine,
  transformOpAt,
  transformTracksToAe,
} from "./transform";
export type {
  AeStaticTransform,
  AeTransformTracks,
  AeTransformOptions,
  AeTransformResult,
} from "./transform";
export {
  colorToRgba,
  hexToAeRgb,
  clampRgb,
  oklabLerp,
  rgbLerp,
  deltaEOK,
  colorTrackValueAt,
  colorSegmentsNeeded,
  denseColorTrackToAe,
  colorEaseSpecs,
  colorExpressionText,
  colorTrackToAe,
  evaluateAeGradient,
  rampToAeStops,
} from "./color";
export type {
  Rgba,
  AeColorReport,
  AeColorTrackResult,
  AeColorEaseSpec,
  AeColorOptions,
  AeRampResult,
} from "./color";
