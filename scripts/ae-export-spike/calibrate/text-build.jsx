// Calibration job: build an exported scene with the real build.jsx, then
// queue frames of its comps (16-bit straight PNG) and save. text.mts merges
// every case's scene (the scene walk's own output) into one package so one
// aerender launch builds them all and one renders them.
//
// cfg: { pkg, project, renders, comps: [{ name, frames: [n…] }] }

(function () {
  var C = $.global.CAL;
  var cfg = C.cfg;
  $.global.TBX_AE_QUIET = true;
  $.global.TBX_AE_OVERWRITE = true;
  $.global.TBX_AE_PACKAGE = cfg.pkg;
  $.global.TBX_AE_RESULT = null;
  $.evalFile(new File(cfg.pkg + "/build.jsx"));
  var r = $.global.TBX_AE_RESULT;
  C.out.build = r ? { ok: r.ok, problems: r.problems, warnings: r.warnings, seconds: r.seconds, saved: r.saved } : null;
  var byName = {};
  var i, j;
  for (i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i) instanceof CompItem) byName[app.project.item(i).name] = app.project.item(i);
  }
  C.out.queued = 0;
  for (i = 0; i < cfg.comps.length; i++) {
    var want = cfg.comps[i];
    var comp = byName[want.name];
    if (!comp) {
      C.out.errors.push("no comp " + want.name);
      continue;
    }
    for (j = 0; j < want.frames.length; j++) {
      C.queue(comp, want.frames[j], cfg.renders + "/" + want.name + "_f" + want.frames[j] + "_[#####].tif", 16);
      C.out.queued++;
    }
  }
  C.save(cfg.project);
}());
