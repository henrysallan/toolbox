// Toolbox AE spike: verify synthesized .ffx gradient presets in the After
// Effects APP (scripts/ae-export-spike/gui-ffx-check.mts). applyPreset hangs
// aerender's render core, so this is the one check that needs the GUI.
//
// Never touches the designer's work: phase 1 refuses when the open project
// has unsaved changes, then imports a test project as a folder, applies each
// preset to its gradient's Colors (selected, as build.jsx does) and asks for
// one frame (saveFrameToPng, asynchronous in 26.5). Phase 2, run once the PNG
// exists, removes the imported folder and re-opens the comp that was active.
// No new/open/close/save of the project, no render queue. Config arrives in
// $.global.TBX_FFX_CHECK_CFG from the generated driver.

/* eslint-disable @typescript-eslint/no-unused-vars -- ES3 has no optional catch binding */

(function () {
  var cfg = $.global.TBX_FFX_CHECK_CFG;
  var res = { phase: cfg.phase, ok: false, steps: [] };

  function quote(s) {
    return '"' + String(s).replace(/[\\"\u0000-\u001f]/g, function (ch) {
      if (ch === '"') return '\\"';
      if (ch === "\\") return "\\\\";
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
    for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) parts.push(quote(k) + ":" + toJSON(v[k]));
    return "{" + parts.join(",") + "}";
  }
  function write() {
    var f = new File(cfg.result);
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    if (f.open("w")) {
      f.write(toJSON(res));
      f.close();
    }
  }
  function errText(e) {
    return (e && e.toString ? e.toString() : String(e)) + (e && e.line ? " (line " + e.line + ")" : "");
  }
  function itemById(id) {
    var i;
    for (i = 1; i <= app.project.numItems; i++) if (app.project.item(i).id === id) return app.project.item(i);
    return null;
  }
  function inFolder(item, folder) {
    var p = item.parentFolder;
    while (p) {
      if (p.id === folder.id) return true;
      if (p === app.project.rootFolder) return false;
      p = p.parentFolder;
    }
    return false;
  }
  // First Gradient Fill / Stroke under a layer's contents, depth first.
  function findGradient(group) {
    var i, p, r;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      if (p.matchName === "ADBE Vector Graphic - G-Fill" || p.matchName === "ADBE Vector Graphic - G-Stroke") return p;
      if (p.matchName === "ADBE Vector Group") {
        r = findGradient(p.property("ADBE Vectors Group"));
        if (r) return r;
      }
    }
    return null;
  }
  function countItems(group) {
    var n = 0, i, p;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      n++;
      if (p.matchName === "ADBE Vector Group") n += countItems(p.property("ADBE Vectors Group"));
    }
    return n;
  }
  function deselect(comp) {
    var j, s = comp.selectedLayers;
    for (j = 0; j < s.length; j++) s[j].selected = false;
    s = comp.selectedProperties;
    for (j = 0; j < s.length; j++) {
      try { s[j].selected = false; } catch (e) {}
    }
  }

  function phase1() {
    if (!app.project) {
      res.aborted = "no project open";
      return;
    }
    if (app.project.dirty) {
      res.aborted = "the open project has unsaved changes; nothing was touched";
      return;
    }
    var prev = app.project.activeItem;
    res.prevActiveId = prev ? prev.id : null;
    res.prevActiveName = prev ? prev.name : null;
    res.itemsBefore = app.project.numItems;
    app.beginUndoGroup("Toolbox .ffx check (import)");
    app.beginSuppressDialogs();
    try {
      var folder = app.project.importFile(new ImportOptions(new File(cfg.aep)));
      if (!folder) throw new Error("import returned nothing");
      res.folderId = folder.id;
      res.folderName = folder.name;
      var comp = null, i, it;
      for (i = 1; i <= app.project.numItems; i++) {
        it = app.project.item(i);
        if (it instanceof CompItem && it.name === cfg.comp && inFolder(it, folder)) comp = it;
      }
      if (!comp) throw new Error("no comp " + cfg.comp + " in the import");
      res.steps.push("imported " + folder.name + "; comp " + comp.name + " has " + comp.numLayers + " layers");
      comp.openInViewer();
      res.jobs = [];
      for (i = 0; i < cfg.jobs.length; i++) {
        var job = cfg.jobs[i], out = { layer: job.layer, preset: job.preset };
        try {
          var layer = comp.layer(job.layer);
          var root = layer.property("ADBE Root Vectors Group");
          var layersBefore = comp.numLayers, itemsBefore = countItems(root);
          deselect(comp);
          layer.selected = true;
          findGradient(layer.property("ADBE Root Vectors Group")).property("ADBE Vector Grad Colors").selected = true;
          layer.applyPreset(new File(job.preset));
          out.layersAfter = comp.numLayers - layersBefore;
          out.itemsAdded = countItems(comp.layer(job.layer).property("ADBE Root Vectors Group")) - itemsBefore;
          out.ok = true;
          deselect(comp);
        } catch (e) {
          out.error = errText(e);
        }
        res.jobs.push(out);
      }
      var r = comp.saveFrameToPng(0, new File(cfg.png));
      res.steps.push("saveFrameToPng requested (" + typeof r + ")");
      res.ok = true;
    } finally {
      app.endSuppressDialogs(false);
      app.endUndoGroup();
    }
  }

  function phase2() {
    var st = cfg.state;
    app.beginUndoGroup("Toolbox .ffx check (cleanup)");
    try {
      var folder = st.folderId !== null ? itemById(st.folderId) : null;
      if (folder && folder instanceof FolderItem && folder.name === st.folderName) {
        folder.remove();
        res.steps.push("removed the imported folder " + st.folderName);
      } else res.steps.push("imported folder already gone");
    } finally {
      app.endUndoGroup();
    }
    var prev = st.prevActiveId !== null ? itemById(st.prevActiveId) : null;
    if (prev && prev instanceof CompItem) {
      prev.openInViewer();
      res.steps.push("re-opened " + prev.name);
    }
    res.itemsAfter = app.project.numItems;
    res.ok = true;
  }

  try {
    if (cfg.phase === 1) phase1();
    else phase2();
  } catch (e) {
    res.error = errText(e);
  }
  write();
}());
