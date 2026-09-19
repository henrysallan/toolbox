import { useEffect, useState } from "react";
import LiveViewer from "@/lib/live-viewer/LiveViewer";
import { LiveRoot } from "@/lib/live-viewer/live-root";
import {
  LiveLoadOverlay,
  liveLoadLabel,
  useLiveLoad,
} from "@/lib/live-viewer/LiveLoadOverlay";
import "@/lib/live-viewer/styles.css";
import { loadData, type ExportData } from "./load-data";

export default function App() {
  const [data, setData] = useState<ExportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The same project-load veil /live shows (LiveLoadOverlay): up from the
  // first paint, through the data read, the viewer's deserialize and its
  // first frame, then a hold and a fade. Was "Loading…" in the `.fatal`
  // red until 2026-09-16.
  const { load, onLoadPhase, onFaded } = useLiveLoad();

  useEffect(() => {
    let cancelled = false;
    loadData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("Export load failed", err);
        if (!cancelled) setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <LiveRoot>
        <div className="fatal">
          Export failed to load:{"\n"}
          {error}
        </div>
      </LiveRoot>
    );
  }

  const veil = load && (
    <LiveLoadOverlay
      label={liveLoadLabel(data?.manifest.appName ?? "")}
      progress={load.progress}
      fading={load.fading}
      onFaded={onFaded}
    />
  );

  if (!data) {
    // The design block rides the data, so until it lands the veil wears
    // the default (dark) token sheet.
    return <LiveRoot>{veil}</LiveRoot>;
  }

  return (
    <LiveRoot design={data.manifest.design}>
      <LiveViewer
        graph={data.graph}
        manifest={data.manifest}
        onLoadPhase={onLoadPhase}
      />
      {veil}
    </LiveRoot>
  );
}
