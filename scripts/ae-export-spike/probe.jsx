// Toolbox AE spike: read a built project back (scripts/ae-export-spike/run.mts).
//
// Evaluated by the generated driver right after build.jsx, in the same
// aerendercore process. Config arrives in $.global.TBX_SPIKE_PROBE (written
// by run.mts — our own data, not scene.json). Writes probe.json with: the
// project settings as AE reports them, every layer's structural facts,
// sampled property values and keys, property trees, an SVG import probe,
// then queues the requested frames as TIFF with alpha.

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

(function () {
  var cfg = $.global.TBX_SPIKE_PROBE;
  var out = { fileName: String($.fileName), errors: [] };

  function quote(s) {
    return '"' + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (ch) {
      if (ch === '"') return '\\"';
      if (ch === "\\") return "\\\\";
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
  }
  function toJSON(v) {
    var parts = [], i, k;
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return quote(v);
    if (v instanceof Array) {
      for (i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
      return "[" + parts.join(",") + "]";
    }
    for (k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] !== "function") parts.push(quote(k) + ":" + toJSON(v[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  function attempt(label, fn) {
    try {
      return fn();
    } catch (e) {
      out.errors.push(label + ": " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
      return null;
    }
  }

  function findComp(name) {
    var i, it;
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    }
    throw new Error("no comp " + name);
  }
  function resolve(layer, path) {
    var p = layer, i, step;
    for (i = 0; i < path.length; i++) {
      step = path[i];
      p = typeof step === "number" ? p.property(step) : p.property(step);
      if (!p) throw new Error("no property " + path.slice(0, i + 1).join(" > "));
    }
    return p;
  }
  function interpName(t) {
    if (t === KeyframeInterpolationType.LINEAR) return "linear";
    if (t === KeyframeInterpolationType.BEZIER) return "bezier";
    if (t === KeyframeInterpolationType.HOLD) return "hold";
    return String(t);
  }
  function enumName(en, v) {
    var k;
    for (k in en) {
      try { if (en[k] === v) return k; } catch (e) {}
    }
    return String(v);
  }
  function pvtName(t) {
    var names = ["NO_VALUE", "ThreeD_SPATIAL", "ThreeD", "TwoD_SPATIAL", "TwoD", "OneD", "COLOR", "CUSTOM_VALUE", "MARKER",
      "LAYER_INDEX", "MASK_INDEX", "SHAPE", "TEXT_DOCUMENT"];
    var i;
    for (i = 0; i < names.length; i++) if (PropertyValueType[names[i]] === t) return names[i];
    return String(t);
  }
  function easeList(list) {
    var r = [], i;
    for (i = 0; i < list.length; i++) r.push({ speed: list[i].speed, influence: list[i].influence });
    return r;
  }
  function plain(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    if (v instanceof Array) return v;
    if (v instanceof Shape) return { vertices: v.vertices, inTangents: v.inTangents, outTangents: v.outTangents, closed: v.closed };
    if (v instanceof TextDocument) return docFacts(v);
    return String(v);
  }
  function docFacts(d) {
    var r = {}, names = ["text", "font", "fontSize", "tracking", "leading", "autoLeading", "applyFill", "fillColor", "applyStroke",
      "strokeColor", "strokeWidth", "strokeOverFill", "boxText", "pointText", "boxTextSize", "boxTextPos", "allCaps", "smallCaps",
      "fauxBold", "fauxItalic", "horizontalScale", "verticalScale", "baselineShift", "tsume", "superscript", "subscript", "justification"];
    var i;
    for (i = 0; i < names.length; i++) {
      try { r[names[i]] = plain(d[names[i]]); } catch (e) { r[names[i]] = "!" + e.toString(); }
    }
    return r;
  }

  function sample(s) {
    var layer = findComp(s.comp).layer(s.layer);
    if (!layer) throw new Error("no layer " + s.layer);
    var p = resolve(layer, s.path);
    var r = { comp: s.comp, layer: s.layer, path: s.path, pvt: pvtName(p.propertyValueType), isSpatial: p.isSpatial,
      numKeys: p.numKeys, values: [], keys: [], expression: p.expression, expressionError: p.expressionError };
    var i;
    for (i = 0; i < s.times.length; i++) r.values.push(plain(p.valueAtTime(s.times[i], false)));
    for (i = 1; i <= p.numKeys; i++) {
      r.keys.push({
        t: p.keyTime(i), v: plain(p.keyValue(i)),
        inInterp: interpName(p.keyInInterpolationType(i)), outInterp: interpName(p.keyOutInterpolationType(i)),
        easeIn: easeList(p.keyInTemporalEase(i)), easeOut: easeList(p.keyOutTemporalEase(i)),
        spatialIn: p.isSpatial ? p.keyInSpatialTangent(i) : null, spatialOut: p.isSpatial ? p.keyOutSpatialTangent(i) : null
      });
    }
    // values are post-expression (valueAtTime(t, false)); pre adds the
    // value under the expression.
    if (s.preExpression) {
      r.pre = [];
      for (i = 0; i < s.times.length; i++) r.pre.push(plain(p.valueAtTime(s.times[i], true)));
    }
    return r;
  }

  function tree(p, depth) {
    var r = { mn: p.matchName, name: p.name };
    var i;
    try { r.type = p.propertyType === PropertyType.PROPERTY ? "prop" : "group"; } catch (e) {}
    if (r.type === "prop") {
      try { r.pvt = pvtName(p.propertyValueType); } catch (e2) {}
      try {
        if (p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) r.value = plain(p.value);
        else r.value = "(no value)";
      } catch (e3) { r.value = "!" + e3.toString(); }
      try { if (p.numKeys) r.numKeys = p.numKeys; } catch (e4) {}
      return r;
    }
    if (depth <= 0) return r;
    r.children = [];
    for (i = 1; i <= p.numProperties; i++) r.children.push(tree(p.property(i), depth - 1));
    return r;
  }

  function layerFacts(layer) {
    var f = { index: layer.index, name: layer.name, matchName: layer.matchName };
    var names = ["inPoint", "outPoint", "startTime", "enabled", "comment", "threeDLayer", "adjustmentLayer", "nullLayer",
      "hasTrackMatte", "isTrackMatte", "trackMatteType", "blendingMode", "timeRemapEnabled", "stretch"];
    var i, m, fx;
    for (i = 0; i < names.length; i++) {
      try { f[names[i]] = plain(layer[names[i]]); } catch (e) {}
    }
    try { f.blendingModeName = enumName(BlendingMode, layer.blendingMode); } catch (e0) {}
    try { f.trackMatteTypeName = enumName(TrackMatteType, layer.trackMatteType); } catch (e00) {}
    try { f.parent = layer.parent ? layer.parent.name : null; } catch (e1) {}
    try { f.trackMatteLayer = layer.trackMatteLayer ? layer.trackMatteLayer.name : null; } catch (e2) {}
    try { f.source = layer.source ? layer.source.name : null; } catch (e3) {}
    try {
      var masks = layer.property("ADBE Mask Parade");
      f.masks = [];
      for (i = 1; masks && i <= masks.numProperties; i++) {
        m = masks.property(i);
        f.masks.push({ name: m.name, mode: m.maskMode, inverted: m.inverted });
      }
    } catch (e4) {}
    try {
      var parade = layer.property("ADBE Effect Parade");
      f.effects = [];
      for (i = 1; parade && i <= parade.numProperties; i++) {
        fx = parade.property(i);
        var ent = { matchName: fx.matchName, name: fx.name, enabled: fx.enabled, maskRefs: [] };
        var bip = fx.property("ADBE Effect Built In Params");
        if (bip) {
          var mp = bip.property("ADBE Effect Mask Parade");
          for (var k = 1; mp && k <= mp.numProperties; k++) ent.maskRefs.push(mp.property(k).property("ADBE Effect Path Stream Ref").value);
          ent.effectOpacity = bip.property("ADBE Effect Mask Opacity").value;
        }
        f.effects.push(ent);
      }
    } catch (e5) {}
    if (layer instanceof TextLayer) {
      try { f.document = docFacts(layer.property("ADBE Text Properties").property("ADBE Text Document").value); } catch (e6) {}
    }
    return f;
  }

  function projectFacts() {
    var p = app.project, r = {}, names = ["bitsPerChannel", "workingSpace", "linearBlending", "linearizeWorkingSpace",
      "expressionEngine", "workingGamma", "compensateForSceneReferredProfiles", "colorManagementSystem", "numItems"];
    var i, it;
    for (i = 0; i < names.length; i++) {
      try { r[names[i]] = plain(p[names[i]]); } catch (e) { r[names[i]] = "!" + e.toString(); }
    }
    r.file = p.file ? p.file.fsName : null;
    r.items = [];
    for (i = 1; i <= p.numItems; i++) {
      it = p.item(i);
      r.items.push({ name: it.name, type: it.typeName, w: it.width, h: it.height });
    }
    r.comps = [];
    for (i = 1; i <= p.numItems; i++) {
      it = p.item(i);
      if (!(it instanceof CompItem)) continue;
      var c = { name: it.name, width: it.width, height: it.height, frameRate: it.frameRate, duration: it.duration, bgColor: it.bgColor, layers: [] };
      for (var j = 1; j <= it.numLayers; j++) c.layers.push(layerFacts(it.layer(j)));
      r.comps.push(c);
    }
    return r;
  }

  function svgProbe(path) {
    var io = new ImportOptions(new File(path));
    return {
      footage: io.canImportAs(ImportAsType.FOOTAGE),
      comp: io.canImportAs(ImportAsType.COMP),
      compCroppedLayers: io.canImportAs(ImportAsType.COMP_CROPPED_LAYERS)
    };
  }

  function queueRenders(list) {
    var r = [], i, j, comp, rq, om, st;
    for (i = 0; i < list.length; i++) {
      comp = findComp(list[i].comp);
      for (j = 0; j < list[i].frames.length; j++) {
        rq = app.project.renderQueue.items.add(comp);
        rq.applyTemplate("Best Settings");
        rq.timeSpanStart = list[i].frames[j] * comp.frameDuration;
        rq.timeSpanDuration = comp.frameDuration;
        om = rq.outputModule(1);
        om.applyTemplate("TIFF Sequence with Alpha");
        // One file name per item: AE skips an item whose output name another
        // queued item already uses.
        om.file = new File(list[i].dir + "/" + list[i].prefix + "_f" + list[i].frames[j] + "_[#####].tif");
        if (i === 0 && j === 0) {
          st = om.getSettings(GetSettingsFormat.STRING);
          out.outputModule = { format: st["Format"], channels: st["Channels"], depth: st["Depth"], color: st["Color"] };
        }
      }
    }
    // renderQueue.render() returns without rendering inside a startup script
    // (items stay QUEUED, status 3015); the queue is saved into the project
    // and run.mts renders it with a plain `aerender -project`.
    app.project.save();
    for (i = 1; i <= app.project.renderQueue.numItems; i++) r.push(String(app.project.renderQueue.item(i).status));
    return r;
  }

  out.ae = app.version;
  out.build = $.global.TBX_AE_RESULT || null;
  out.project = attempt("project facts", projectFacts);
  var i;
  out.samples = [];
  for (i = 0; cfg.samples && i < cfg.samples.length; i++) {
    (function (s) { out.samples.push(attempt("sample " + s.layer + " " + s.path.join(">"), function () { return sample(s); })); }(cfg.samples[i]));
  }
  out.trees = [];
  for (i = 0; cfg.trees && i < cfg.trees.length; i++) {
    (function (t) {
      out.trees.push(attempt("tree " + t.layer, function () {
        var layer = findComp(t.comp).layer(t.layer);
        return { comp: t.comp, layer: t.layer, tree: tree(t.path ? resolve(layer, t.path) : layer, t.depth || 6) };
      }));
    }(cfg.trees[i]));
  }
  if (cfg.otherCompTrees) {
    attempt("other comp trees", function () {
      var k, it, j, skip;
      for (k = 1; k <= app.project.numItems; k++) {
        it = app.project.item(k);
        if (!(it instanceof CompItem)) continue;
        skip = false;
        for (j = 0; j < cfg.otherCompTrees.exclude.length; j++) if (cfg.otherCompTrees.exclude[j] === it.name) skip = true;
        if (skip) continue;
        for (j = 1; j <= it.numLayers; j++) out.trees.push({ comp: it.name, layer: it.layer(j).name, tree: tree(it.layer(j), cfg.otherCompTrees.depth) });
      }
    });
  }
  if (cfg.svg) out.svg = attempt("svg probe", function () { return svgProbe(cfg.svg); });
  if (cfg.render && cfg.render.length) out.renderStatus = attempt("render", function () { return queueRenders(cfg.render); });

  var f = new File(cfg.out);
  f.encoding = "UTF-8";
  f.lineFeed = "Unix";
  if (f.open("w")) {
    f.write(toJSON(out));
    f.close();
  }
}());
