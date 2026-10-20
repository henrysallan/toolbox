// Toolbox AE spike: startup hook (scripts/ae-export-spike/run.mts).
//
// aerender has no "run this script" flag on macOS (its -r is a patch
// nexrender applies to Adobe's commandLineRenderer.jsx), and the render core
// it launches (aerendercore, com.adobe.aerendercore — a separate process from
// the After Effects GUI) runs its command line and quits. What it does run is
// the user Scripts/Startup folder. run.mts copies this file there for ONE
// aerender launch and deletes it afterwards.
//
// It does nothing unless TBX_AE_SPIKE_DRIVER is set in the environment, which
// only run.mts sets — an After Effects started from the Dock never has it.

(function () {
  var driver = $.getenv("TBX_AE_SPIKE_DRIVER");
  if (!driver) return;
  var f = new File(driver);
  if (!f.exists) return;
  try {
    $.evalFile(f);
  } catch (e) {
    var out = new File(f.parent.fsName + "/hook-error.txt");
    out.encoding = "UTF-8";
    out.lineFeed = "Unix";
    if (out.open("w")) {
      out.write(String(e) + (e && e.line ? " (line " + e.line + ")" : "") + "\n");
      out.close();
    }
  }
}());
