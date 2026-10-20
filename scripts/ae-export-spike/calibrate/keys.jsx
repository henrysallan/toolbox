// Calibration job: keyed properties read back densely (valueAtTime), for the
// AE behaviours convert/keys.ts assumes (spec §14).
//
// cfg.tests: [{ id, kind: "scalar" | "color" | "path", keys: [AeKey], times: [s…] }]
// AeKey = { t, v, inInterp, outInterp, easeIn?: [AeEase], easeOut?: [AeEase] }
// (types.ts), written the way build.jsx writes them: setValuesAtTimes, then
// interpolation, ease, interpolation again. Paths are { vertices, inTangents,
// outTangents, closed }.

(function () {
  var C = $.global.CAL;
  var comp = C.comp("keys", 400, 400, 30, 4);
  var layer = comp.layers.addShape();
  var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  var vectors = group.property("ADBE Vectors Group");
  var pathItem = vectors.addProperty("ADBE Vector Shape - Group");
  var fill = vectors.addProperty("ADBE Vector Graphic - Fill");

  function interp(s) {
    // No nested ternaries: AE 26.5's ExtendScript parses a ? x : b ? y : z
    // as (a ? x : b) ? y : z (measured, spec §14).
    if (s === "hold") return KeyframeInterpolationType.HOLD;
    if (s === "linear") return KeyframeInterpolationType.LINEAR;
    return KeyframeInterpolationType.BEZIER;
  }
  function toShape(p) {
    var s = new Shape();
    s.vertices = p.vertices;
    s.inTangents = p.inTangents;
    s.outTangents = p.outTangents;
    s.closed = p.closed;
    return s;
  }
  function easeList(prop, list) {
    var t = prop.propertyValueType;
    var spatial = t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL;
    var n = 1, out = [], j, e;
    if (!spatial && t === PropertyValueType.TwoD) n = 2;
    if (!spatial && t === PropertyValueType.ThreeD) n = 3;
    for (j = 0; j < n; j++) {
      e = list[Math.min(j, list.length - 1)];
      out.push(new KeyframeEase(e.speed, e.influence));
    }
    return out;
  }
  function propFor(kind) {
    if (kind === "color") return group.property("ADBE Vectors Group").property(2).property("ADBE Vector Fill Color");
    if (kind === "path") return group.property("ADBE Vectors Group").property(1).property("ADBE Vector Shape");
    if (kind === "position") return layer.property("ADBE Transform Group").property("ADBE Position");
    return layer.property("ADBE Transform Group").property("ADBE Rotate Z");
  }
  function clear(prop) {
    while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
  }

  C.out.results = [];
  var i;
  for (i = 0; i < C.cfg.tests.length; i++) {
    (function (T) {
      C.attempt("test " + T.id, function () {
        var prop = propFor(T.kind);
        clear(prop);
        var times = [], values = [], j, k;
        for (j = 0; j < T.keys.length; j++) {
          times.push(T.keys[j].t);
          values.push(T.kind === "path" ? toShape(T.keys[j].v) : T.keys[j].v);
        }
        prop.setValuesAtTimes(times, values);
        for (j = 0; j < T.keys.length; j++) {
          var key = T.keys[j];
          k = j + 1;
          prop.setInterpolationTypeAtKey(k, interp(key.inInterp), interp(key.outInterp));
          if (key.easeIn || key.easeOut) {
            var inE = key.easeIn ? easeList(prop, key.easeIn) : prop.keyInTemporalEase(k);
            var outE = key.easeOut ? easeList(prop, key.easeOut) : prop.keyOutTemporalEase(k);
            prop.setTemporalEaseAtKey(k, inE, outE);
            prop.setInterpolationTypeAtKey(k, interp(key.inInterp), interp(key.outInterp));
          }
          if (T.kind === "position") {
            // A straight motion path, as build.jsx writes one.
            prop.setSpatialContinuousAtKey(k, false);
            prop.setSpatialAutoBezierAtKey(k, false);
            prop.setSpatialTangentsAtKey(k, [0, 0, 0], [0, 0, 0]);
          }
        }
        var read = [], eases = [];
        for (k = 1; k <= prop.numKeys; k++) {
          var ie = prop.keyInTemporalEase(k), oe = prop.keyOutTemporalEase(k), a = [], b = [], m;
          for (m = 0; m < ie.length; m++) a.push([ie[m].speed, ie[m].influence]);
          for (m = 0; m < oe.length; m++) b.push([oe[m].speed, oe[m].influence]);
          eases.push({ inEase: a, outEase: b, inInterp: String(prop.keyInInterpolationType(k)), outInterp: String(prop.keyOutInterpolationType(k)) });
        }
        for (j = 0; j < T.times.length; j++) {
          var v = prop.valueAtTime(T.times[j], false);
          if (T.kind === "path") read.push({ vertices: v.vertices, inTangents: v.inTangents, outTangents: v.outTangents });
          else read.push(v);
        }
        C.out.results.push({ id: T.id, kind: T.kind, eases: eases, values: read });
      });
    }(C.cfg.tests[i]));
  }
}());
