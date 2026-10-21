// Calibration job: the value-graph expressions (M4 lane 1), read back.
//
// cfg.packages: [{ name, dir, comps: [comp names], times: [s…], mark }] —
// package folders written by expressions-roundtrip.mts (scene.json +
// build.jsx). Each is built by its own build.jsx (which saves and, for the
// next package, closes the project), then every property whose expression
// starts with `mark` in those comps is read back before the next build:
// its match-name path, expressionError, the expression text and
// valueAtTime(t, false) at every time — each number as its exact bits,
// "d:<sign>:<exponent>:<hi26>:<lo26>" (ExtendScript prints numbers to 15
// significant digits, and toPrecision(17) is no better: measured), decoded
// by expressions-roundtrip.mts.

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  C.out.packages = [];

  function compNamed(name) {
    var i, it;
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    }
    return null;
  }

  // A finite double as sign, binary exponent and a 53-bit mantissa split in
  // two 26-bit integers: halving / doubling and those integers are exact.
  // No nested ternaries in ExtendScript (left-associative ?:).
  function num(x) {
    var s = 1, a, e = 0, m, hi;
    if (typeof x !== "number") return x;
    if (!isFinite(x)) return String(x);
    if (x === 0) return 1 / x < 0 ? "d:-1:0:0:0" : "d:1:0:0:0";
    if (x < 0) {
      s = -1;
      a = -x;
    } else a = x;
    while (a >= 2) {
      a /= 2;
      e++;
    }
    while (a < 1) {
      a *= 2;
      e--;
    }
    m = a * 4503599627370496;
    hi = Math.floor(m / 67108864);
    return "d:" + s + ":" + e + ":" + hi + ":" + (m - hi * 67108864);
  }
  function plain(v) {
    var r, k;
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return num(v);
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (v instanceof Array) {
      r = [];
      for (k = 0; k < v.length; k++) r.push(num(v[k]));
      return r;
    }
    return String(v);
  }

  function walk(group, path, P, rec, comp, layer) {
    var i, p, x, j, values;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      if (!p) continue;
      if (p.propertyType === PropertyType.PROPERTY) {
        x = "";
        try { x = p.expression; } catch (e) { x = ""; }
        if (!x || x.indexOf(P.mark) !== 0) continue;
        values = [];
        for (j = 0; j < P.times.length; j++) {
          try { values.push(plain(p.valueAtTime(P.times[j], false))); } catch (e2) { values.push("!" + e2.toString()); }
        }
        rec.props.push({
          comp: comp.name,
          layer: layer.name,
          path: path.concat([p.matchName]),
          name: p.name,
          expression: x,
          expressionError: p.expressionError,
          expressionEnabled: p.expressionEnabled,
          values: values
        });
      } else {
        walk(p, path.concat([p.matchName]), P, rec, comp, layer);
      }
    }
  }

  var i;
  for (i = 0; i < cfg.packages.length; i++) {
    (function (P) {
      C.attempt("package " + P.name, function () {
        var G = $.global;
        G.TBX_AE_PACKAGE = P.dir;
        G.TBX_AE_QUIET = true;
        G.TBX_AE_OVERWRITE = true;
        G.TBX_AE_RESULT = null;
        var t0 = new Date().getTime();
        $.evalFile(new File(P.dir + "/build.jsx"));
        var res = G.TBX_AE_RESULT;
        var rec = { name: P.name, build: res ? { ok: res.ok, problems: res.problems, warnings: res.warnings, counts: res.counts, seconds: res.seconds } : null, props: [], readSeconds: 0 };
        var t1 = new Date().getTime();
        var c, comp, l;
        for (c = 0; c < P.comps.length; c++) {
          comp = compNamed(P.comps[c]);
          if (!comp) continue;
          for (l = 1; l <= comp.numLayers; l++) walk(comp.layer(l), [], P, rec, comp, comp.layer(l));
        }
        rec.readSeconds = (new Date().getTime() - t1) / 1000;
        rec.totalSeconds = (new Date().getTime() - t0) / 1000;
        C.out.packages.push(rec);
      });
    }(cfg.packages[i]));
  }
}());
