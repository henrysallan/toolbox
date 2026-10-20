// Calibration job: every installed effect (app.effects), then the property
// tree of each effect in cfg.dump applied to a solid — match names, display
// names, defaults and ranges as AE 26.5 reports them.

(function () {
  var C = $.global.CAL;
  var list = [], i, e;
  for (i = 0; i < app.effects.length; i++) {
    e = app.effects[i];
    list.push({ displayName: e.displayName, matchName: e.matchName, category: e.category, version: e.version });
  }
  C.out.effects = list;
  var comp = C.comp("effects", 64, 64, 30, 1);
  C.out.trees = {};
  var dump = C.cfg.dump || [];
  for (i = 0; i < dump.length; i++) {
    (function (match) {
      C.attempt("dump " + match, function () {
        var solid = comp.layers.addSolid([0.5, 0.5, 0.5], match, 64, 64, 1);
        var fx = solid.property("ADBE Effect Parade").addProperty(match);
        if (!fx) throw new Error("addProperty returned null");
        C.out.trees[match] = { name: fx.name, props: C.dumpProps(fx, 3) };
      });
    }(dump[i]));
  }
}());
