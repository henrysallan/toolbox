// Calibration job: text layers with hand-built animators, selectors and path
// options, one comp per item, the listed frames queued (16-bit straight PNG),
// project saved. Used for the text-animator questions (spec §4.7) scripting
// cannot read back: how AE stacks animators, what a selector's shapes select,
// where a character pivots, how Path Options place a run. calibrate/text.mts
// drives it and measures the renders glyph by glyph.
//
// cfg: { project, renders, items: [item…] }
// item: { name, w, h, text, font, size, tracking, just: "left"|"center"|"right",
//   pos: [x, y], baselineShift?, grouping?: 1–4, groupAlign?: [x, y],
//   path?: { vertices, inTangents?, outTangents?, reverse?, perpendicular?,
//            force?, first?, last? },
//   animators: [{ props: { "<match>": value }, trackingType?: 1–3,
//                 selectors: [selector…] }],
//   frames: [n…], dump?: true, slider?: number (an "Amt" Slider Control),
//   stroke?: width (red, under the fill), fill?: [r, g, b] }
// selector: { kind: "range", start?, end?, offset?, units?: 1|2, basedOn?: 1–4,
//   mode?: 1–6, amount?, shape?: 1–6, smooth?, easeHigh?, easeLow?,
//   random?: bool, seed?, keys?: { "<prop>": [[t, v]…] } }
//   | { kind: "expression", basedOn?: 1–4, mode?, expression, value?, keys?: [[t, v]…] }

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  // The startup project may come up OCIO-managed (colorManagementSystem 1;
  // bit depth then refuses 16): switch this project to Adobe color
  // management (0) first. There is no enum object for it in 26.5.
  C.out.cms = C.attempt("cms read", function () { return app.project.colorManagementSystem; });
  C.attempt("cms", function () { app.project.colorManagementSystem = 0; });
  app.project.bitsPerChannel = 16;
  C.attempt("expressionEngine", function () { app.project.expressionEngine = "javascript-1.0"; });
  C.attempt("workingSpace", function () { app.project.workingSpace = ""; });
  C.out.items = [];

  var NEUTRAL = { fauxBold: false, fauxItalic: false, smallCaps: false, allCaps: false, horizontalScale: 1, verticalScale: 1, baselineShift: 0, tsume: 0 };
  var JUST = { left: "LEFT_JUSTIFY", center: "CENTER_JUSTIFY", right: "RIGHT_JUSTIFY" };

  function doc(layer, I) {
    var p = layer.property("ADBE Text Properties").property("ADBE Text Document");
    var td = p.value;
    td.text = I.text;
    td.font = I.font;
    td.fontSize = I.size;
    td.applyFill = true;
    td.fillColor = I.fill || [1, 1, 1];
    if (I.stroke) {
      td.applyStroke = true;
      td.strokeColor = [1, 0, 0];
      td.strokeWidth = I.stroke;
      td.strokeOverFill = false;
    } else td.applyStroke = false;
    td.tracking = I.tracking || 0;
    td.autoLeading = true;
    td.justification = ParagraphJustification[JUST[I.just || "left"]];
    var k;
    for (k in NEUTRAL) if (Object.prototype.hasOwnProperty.call(NEUTRAL, k)) C.attempt("doc " + k, function () { td[k] = NEUTRAL[k]; });
    if (I.baselineShift) td.baselineShift = I.baselineShift;
    if (I.autoKern) C.attempt("autoKernType", function () { td.autoKernType = AutoKernType[I.autoKern]; });
    p.setValue(td);
    C.attempt("kern read", function () { var v = p.value; I.kernRead = String(v.autoKernType) + " / " + String(v.kerning); });
  }

  function shape(P) {
    var s = new Shape();
    var n = P.vertices.length, i, z = [];
    for (i = 0; i < n; i++) z.push([0, 0]);
    s.vertices = P.vertices;
    s.inTangents = P.inTangents || z;
    s.outTangents = P.outTangents || z;
    s.closed = P.closed === true;
    return s;
  }

  function setOrKey(prop, v, keys) {
    var j;
    if (keys) {
      for (j = 0; j < keys.length; j++) prop.setValueAtTime(keys[j][0], keys[j][1]);
      for (j = 1; j <= prop.numKeys; j++) {
        prop.setInterpolationTypeAtKey(j, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      }
    } else if (v !== undefined) prop.setValue(v);
  }

  function selector(anim, S, rec) {
    var sels = function () { return anim().property("ADBE Text Selectors"); };
    var keys = S.keys || {};
    if (S.kind === "expression") {
      sels().addProperty("ADBE Text Expressible Selector");
      var e = function () { return sels().property(sels().numProperties); };
      if (S.basedOn) e().property("ADBE Text Range Type2").setValue(S.basedOn);
      if (S.mode) e().property("ADBE Text Selector Mode").setValue(S.mode);
      var amt = function () { return e().property("ADBE Text Expressible Amount"); };
      if (S.value !== undefined) amt().setValue(S.value);
      if (S.keys) {
        var q;
        for (q = 0; q < S.keys.length; q++) amt().setValueAtTime(S.keys[q][0], S.keys[q][1]);
      }
      rec.amountType = C.pvtName(amt().propertyValueType);
      rec.amountValue = amt().value;
      amt().expression = S.expression;
      rec.exprError = e().property("ADBE Text Expressible Amount").expressionError;
      return;
    }
    sels().addProperty("ADBE Text Selector");
    var s = function () { return sels().property(sels().numProperties); };
    var adv = function () { return s().property("ADBE Text Range Advanced"); };
    if (S.units) adv().property("ADBE Text Range Units").setValue(S.units);
    if (S.basedOn) adv().property("ADBE Text Range Type2").setValue(S.basedOn);
    if (S.mode) adv().property("ADBE Text Selector Mode").setValue(S.mode);
    var byIndex = S.units === 2;
    var names = { start: byIndex ? "ADBE Text Index Start" : "ADBE Text Percent Start", end: byIndex ? "ADBE Text Index End" : "ADBE Text Percent End", offset: byIndex ? "ADBE Text Index Offset" : "ADBE Text Percent Offset" };
    var k;
    for (k in names) {
      if (!Object.prototype.hasOwnProperty.call(names, k)) continue;
      (function (key) {
        C.attempt("set " + key, function () { setOrKey(s().property(names[key]), S[key], keys[key]); });
        C.attempt("read " + key, function () { rec[key] = s().property(names[key]).value; });
      }(k));
    }
    if (S.amount !== undefined) C.attempt("amount", function () { adv().property("ADBE Text Selector Max Amount").setValue(S.amount); rec.amount = adv().property("ADBE Text Selector Max Amount").value; });
    if (S.shape) adv().property("ADBE Text Range Shape").setValue(S.shape);
    if (S.smooth !== undefined) C.attempt("smooth", function () { adv().property("ADBE Text Selector Smoothness").setValue(S.smooth); });
    if (S.easeHigh !== undefined) C.attempt("easeHigh", function () { adv().property("ADBE Text Levels Max Ease").setValue(S.easeHigh); rec.easeHigh = adv().property("ADBE Text Levels Max Ease").value; });
    if (S.easeLow !== undefined) C.attempt("easeLow", function () { adv().property("ADBE Text Levels Min Ease").setValue(S.easeLow); rec.easeLow = adv().property("ADBE Text Levels Min Ease").value; });
    if (S.random) adv().property("ADBE Text Randomize Order").setValue(1);
    if (S.seed !== undefined) adv().property("ADBE Text Random Seed").setValue(S.seed);
  }

  function animator(layer, A, rec) {
    var all = function () { return layer.property("ADBE Text Properties").property("ADBE Text Animators"); };
    all().addProperty("ADBE Text Animator");
    var idx = all().numProperties;
    var anim = function () { return all().property(idx); };
    var k;
    for (k in A.props) if (Object.prototype.hasOwnProperty.call(A.props, k)) anim().property("ADBE Text Animator Properties").addProperty(k);
    if (A.trackingType) C.attempt("tracking type", function () { anim().property("ADBE Text Animator Properties").property("ADBE Text Track Type").setValue(A.trackingType); });
    for (k in A.props) {
      if (!Object.prototype.hasOwnProperty.call(A.props, k)) continue;
      (function (key) {
        C.attempt("prop " + key, function () {
          var p = anim().property("ADBE Text Animator Properties").property(key);
          if (A.props[key] && A.props[key].expression) p.expression = A.props[key].expression;
          else p.setValue(A.props[key]);
        });
      }(k));
    }
    var j;
    for (j = 0; j < (A.selectors || []).length; j++) {
      var r = {};
      rec.selectors.push(r);
      (function (S, R) { C.attempt("selector", function () { selector(anim, S, R); }); }(A.selectors[j], r));
    }
  }

  var i, j;
  for (i = 0; i < cfg.items.length; i++) {
    (function (I) {
      C.attempt("item " + I.name, function () {
        var rec = { name: I.name, selectors: [] };
        rec.kernTypes = C.attempt("kern enum", function () { var r = {}, k; for (k in AutoKernType) r[k] = String(AutoKernType[k]); return r; });
        var comp = C.comp(I.name, I.w, I.h, 30, I.duration || 1);
        var layer = comp.layers.addText(I.text);
        doc(layer, I);
        layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
        layer.property("ADBE Transform Group").property("ADBE Position").setValue(I.pos);
        if (I.slider !== undefined) {
          var sl = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
          sl.name = "Amt";
          sl.property(1).setValue(I.slider);
        }
        if (I.grouping) layer.property("ADBE Text Properties").property("ADBE Text More Options").property("ADBE Text Anchor Point Option").setValue(I.grouping);
        if (I.groupAlign) layer.property("ADBE Text Properties").property("ADBE Text More Options").property("ADBE Text Anchor Point Align").setValue(I.groupAlign);
        if (I.path) {
          var m = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
          m.property("ADBE Mask Shape").setValue(shape(I.path));
          m.maskMode = MaskMode.NONE;
          var po = function () { return layer.property("ADBE Text Properties").property("ADBE Text Path Options"); };
          po().property("ADBE Text Path").setValue(1);
          if (I.path.reverse !== undefined) po().property("ADBE Text Reverse Path").setValue(I.path.reverse ? 1 : 0);
          if (I.path.perpendicular !== undefined) po().property("ADBE Text Perpendicular To Path").setValue(I.path.perpendicular ? 1 : 0);
          if (I.path.force !== undefined) po().property("ADBE Text Force Align Path").setValue(I.path.force ? 1 : 0);
          if (I.path.first !== undefined) po().property("ADBE Text First Margin").setValue(I.path.first);
          if (I.path.last !== undefined) po().property("ADBE Text Last Margin").setValue(I.path.last);
        }
        for (j = 0; j < (I.animators || []).length; j++) animator(layer, I.animators[j], rec);
        // A TextDocument value throws on its box-only keys when serialized.
        var strip = function (list) {
          var q;
          for (q = 0; q < list.length; q++) {
            if (list[q].type === "TEXT_DOCUMENT") delete list[q].value;
            if (list[q].props) strip(list[q].props);
          }
          return list;
        };
        if (I.dump) rec.tree = strip(C.dumpProps(layer.property("ADBE Text Properties"), 6));
        C.attempt("rect", function () { rec.rect = layer.sourceRectAtTime(0, false); });
        for (j = 0; j < (I.frames || [0]).length; j++) {
          var f = (I.frames || [0])[j];
          C.queue(comp, f, cfg.renders + "/" + I.name + "_f" + f + "_[#####].tif", 16);
        }
        rec.kern = I.kernRead;
        C.out.items.push(rec);
      });
    }(cfg.items[i]));
  }
  C.save(cfg.project);
}());
