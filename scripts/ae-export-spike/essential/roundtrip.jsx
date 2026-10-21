// Essential Properties lane: the live round trip's job (roundtrip.mts runs it
// in aerender's render core through calibrate/ae.mts — never the AE GUI).
//
// Per package: build.jsx builds it headless; then this reads the driven
// properties, changes the controls the way an After Effects user would
// (a Controls null's Expression Controls, a precomp layer's Essential
// Properties), reads the properties again, queues frames and saves.
//
// cfg.packages[i]: { name, dir, reads: [{ id, comp, layer, path, t }],
//   edits: [{ comp, layer, effect | essential, value }], renders: [{ comp,
//   frame, prefix }], essential: [{ comp, layer }], controllers: [comp] }
// `path` is a list of property names / match names below the layer.

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  var out = C.out;
  out.packages = {};

  function compNamed(name) {
    var j;
    for (j = 1; j <= app.project.numItems; j++) {
      var it = app.project.item(j);
      if (it instanceof CompItem && it.name === name) return it;
    }
    throw new Error("no comp \"" + name + "\"");
  }
  function propAt(layer, path) {
    var p = layer;
    var j;
    for (j = 0; j < path.length; j++) {
      p = p.property(path[j]);
      if (!p) throw new Error("no property \"" + path[j] + "\" under " + layer.name);
    }
    return p;
  }
  function read(P, R) {
    var p = propAt(compNamed(R.comp).layer(R.layer), R.path);
    return { value: p.valueAtTime(R.t || 0, false), error: p.expressionError, expression: p.expression };
  }

  var i, j;
  for (i = 0; i < cfg.packages.length; i++) {
    (function (P) {
      var res = { build: null, before: {}, after: {}, essential: {}, controllers: {}, errors: [] };
      out.packages[P.name] = res;
      try {
        $.global.TBX_AE_PACKAGE = P.dir;
        $.global.TBX_AE_QUIET = true;
        $.global.TBX_AE_OVERWRITE = true;
        $.global.TBX_AE_RESULT = null;
        $.evalFile(new File(P.dir + "/build.jsx"));
        var b = $.global.TBX_AE_RESULT;
        res.build = b ? { ok: b.ok, saved: b.saved, problems: b.problems, warnings: b.warnings, counts: b.counts } : null;
        for (j = 0; j < P.reads.length; j++) {
          (function (R) {
            try { res.before[R.id] = read(P, R); } catch (e) { res.errors.push("read " + R.id + ": " + e.toString()); }
          }(P.reads[j]));
        }
        for (j = 0; j < P.controllers.length; j++) {
          (function (name) {
            try {
              var c = compNamed(name);
              var list = [];
              var k;
              for (k = 1; k <= c.motionGraphicsTemplateControllerCount; k++) list.push(c.getMotionGraphicsTemplateControllerName(k));
              res.controllers[name] = { names: list, template: c.motionGraphicsTemplateName };
            } catch (e) { res.errors.push("controllers " + name + ": " + e.toString()); }
          }(P.controllers[j]));
        }
        for (j = 0; j < P.essential.length; j++) {
          (function (E) {
            try {
              var ep = compNamed(E.comp).layer(E.layer).essentialProperty;
              var list = [];
              var k;
              for (k = 1; k <= ep.numProperties; k++) list.push({ name: ep.property(k).name, match: ep.property(k).matchName, value: ep.property(k).value });
              res.essential[E.comp + "/" + E.layer] = list;
            } catch (e) { res.errors.push("essential " + E.layer + ": " + e.toString()); }
          }(P.essential[j]));
        }
        // What an After Effects user does: change the controls.
        for (j = 0; j < P.edits.length; j++) {
          (function (E) {
            try {
              var L = compNamed(E.comp).layer(E.layer);
              var p = E.effect ? L.property("ADBE Effect Parade").property(E.effect).property(1) : L.essentialProperty.property(E.essential);
              p.setValue(E.value);
            } catch (e) { res.errors.push("edit " + (E.effect || E.essential) + ": " + e.toString()); }
          }(P.edits[j]));
        }
        for (j = 0; j < P.reads.length; j++) {
          (function (R) {
            try { res.after[R.id] = read(P, R); } catch (e) { res.errors.push("read " + R.id + ": " + e.toString()); }
          }(P.reads[j]));
        }
        for (j = 0; j < P.renders.length; j++) C.queue(compNamed(P.renders[j].comp), P.renders[j].frame, P.dir + "/renders/" + P.renders[j].prefix + "_[#####].tif", 8);
        app.project.save();
      } catch (e) {
        res.errors.push("package: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
      }
    }(cfg.packages[i]));
  }
}());
