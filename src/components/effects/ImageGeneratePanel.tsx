"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import {
  loadSession,
  newGenerationId,
  privateImageUrl,
  publishSelected,
  uploadPrivateImage,
  upsertSession,
  type ImageGenMessage,
  type ImageGenSession,
} from "@/lib/supabase/image-gen";
import {
  base64ToBlob,
  formatToExt,
  formatToMime,
  generateImage,
  type OpenAIError,
} from "@/lib/openai/image-generate";
import { setCachedImage } from "@/lib/openai/image-cache";
import { loadUserPreferences } from "@/lib/supabase/user-preferences";

export interface ImageGeneratePanelProps {
  node: Node<NodeDataPayload>;
  projectId: string | null;
  signedIn: boolean;
  // Live edge list — we filter for edges targeting our ref_a/b/c
  // input handles to know which sockets are wired so we can both
  // (a) light up the badge in the chat input row and (b) attach the
  // upstream bytes to the next OpenAI request.
  edges: Edge[];
  // Bridge into the engine to grab the upstream node's primary
  // IMAGE output as a PNG Blob — used at send-time to package each
  // wired ref socket as an input_image attachment.
  getRefImageBlob?: (sourceNodeId: string) => Promise<Blob | null>;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

// AI Image Generate panel. Chat → OpenAI gpt-image-2 → Supabase
// storage → thumbnail grid → click-to-select → public bucket copy.
//
// Per spec, the chat history + every generation lives in a
// user-scoped Supabase row (image_gen_sessions), not in the saved
// project. Only the SELECTED image's public URL travels with the
// project (stored on `params.selectedImagePath`).

export default function ImageGeneratePanel({
  node,
  projectId,
  signedIn,
  edges,
  getRefImageBlob,
  onParamChange,
}: ImageGeneratePanelProps) {
  const view = (node.data.params.view as string) ?? "grid";
  const size = (node.data.params.size as string) ?? "1024x1024";
  const quality = (node.data.params.quality as string) ?? "auto";
  const format = (node.data.params.format as string) ?? "png";
  const selectedPath =
    (node.data.params.selectedImagePath as string) ?? "";

  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Filter the live edge list down to the refs that target this
  // node's ref_a/b/c handles. ReactFlow stores target handles as
  // `in:<inputName>` (the same convention NodeEditor uses elsewhere
  // for per-input wiring), so we look those up to know which ref
  // socket each edge plugs into.
  const refSources = useMemo(() => {
    const out: { a: string | null; b: string | null; c: string | null } = {
      a: null,
      b: null,
      c: null,
    };
    for (const e of edges) {
      if (e.target !== node.id) continue;
      if (e.targetHandle === "in:ref_a") out.a = e.source;
      else if (e.targetHandle === "in:ref_b") out.b = e.source;
      else if (e.targetHandle === "in:ref_c") out.c = e.source;
    }
    return out;
  }, [edges, node.id]);
  const wiredRefLabels: string[] = [];
  if (refSources.a) wiredRefLabels.push("A");
  if (refSources.b) wiredRefLabels.push("B");
  if (refSources.c) wiredRefLabels.push("C");
  const [session, setSession] = useState<ImageGenSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  // Resolved signed URLs for every private image we've shown so far,
  // keyed by storage path. Memoized in component scope so we don't
  // re-sign on every render — only when a new path appears.
  const signedRef = useRef<Map<string, string>>(new Map());
  const [, bumpSigned] = useState(0);

  // Track whether the initial load actually succeeded. Critical
  // for the send path — if the row failed to load (e.g. transient
  // network blip), we can't trust the cached `session` and must
  // refuse to send to avoid clobbering an existing row with empty
  // history.
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  // Load session whenever the (project, node) target changes.
  useEffect(() => {
    if (!signedIn || !projectId) {
      setSession(null);
      setLoadFailed(null);
      return;
    }
    setLoading(true);
    setLoadFailed(null);
    loadSession(projectId, node.id)
      .then((res) => {
        if (res.kind === "error") {
          setLoadFailed(res.error);
          setSession(null);
        } else {
          setSession(res.session);
        }
      })
      .finally(() => setLoading(false));
  }, [signedIn, projectId, node.id]);

  // Sign URLs for any image paths we don't have yet.
  useEffect(() => {
    if (!session) return;
    const need: string[] = [];
    for (const m of session.messages) {
      for (const img of m.images) {
        if (!signedRef.current.has(img.path)) need.push(img.path);
      }
    }
    if (need.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of need) {
        const url = await privateImageUrl(p);
        if (cancelled) return;
        if (url) signedRef.current.set(p, url);
      }
      if (!cancelled) bumpSigned((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const retryLoad = async () => {
    if (!signedIn || !projectId) return;
    setLoading(true);
    setLoadFailed(null);
    const res = await loadSession(projectId, node.id);
    if (res.kind === "error") setLoadFailed(res.error);
    else setSession(res.session);
    setLoading(false);
  };

  // ---- Send ---------------------------------------------------------
  const send = async () => {
    if (busy) return;
    if (!signedIn) {
      setTopError("Sign in to use Image Generate.");
      return;
    }
    if (!projectId) {
      setTopError("Save the project first — generations are scoped to a project.");
      return;
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;

    setTopError(null);

    // Pull the active key fresh on every send. Cheap query, and
    // sidesteps any stale cache after the user updates the key in
    // Preferences mid-session.
    const prefs = await loadUserPreferences();
    if (!prefs.openaiApiKey) {
      setTopError(
        "No OpenAI API key on file. Open Toolbox → User Preferences."
      );
      return;
    }

    // Read-modify-write at send time. Re-fetch the session row
    // from the DB right now so we never overwrite messages that
    // the cached `session` state didn't know about (transient load
    // blips, multi-tab edits, etc.). If the read fails we BLOCK
    // the send — far better to surface an error than to clobber
    // the user's chat history.
    const fresh = await loadSession(projectId, node.id);
    if (fresh.kind === "error") {
      setTopError(
        `Couldn't load chat history (${fresh.error}). Refusing to send to avoid overwriting existing messages — try again.`
      );
      setLoadFailed(fresh.error);
      return;
    }
    const baseSession: ImageGenSession =
      fresh.session ?? {
        id: "",
        userId: "",
        projectId,
        nodeId: node.id,
        lastResponseId: null,
        messages: [],
      };
    // Reflect the freshest base into the panel state before we
    // overlay the optimistic pending message — keeps the chat
    // visible in the UI honest with what's actually in the DB.
    setSession(baseSession);

    // Optimistic pending message.
    const msgId = newGenerationId();
    const pending: ImageGenMessage = {
      id: msgId,
      prompt: trimmed,
      status: "pending",
      createdAt: Date.now(),
      images: [],
    };
    const optimistic: ImageGenSession = {
      ...baseSession,
      messages: [...baseSession.messages, pending],
    };
    setSession(optimistic);
    setPrompt("");
    setBusy(true);

    try {
      // Resolve any wired ref sockets to base64 data URLs. We pull
      // the upstream node's primary IMAGE output from the eval
      // cache, render it to a PNG via canvas readback, and inline
      // it in the request. Inline (vs signed URL upload) keeps the
      // round-trip simple at the cost of a fatter payload — fine
      // at typical canvas sizes.
      const refUrls: string[] = [];
      const refSourcesOrdered = [
        refSources.a,
        refSources.b,
        refSources.c,
      ].filter((id): id is string => !!id);
      if (refSourcesOrdered.length > 0 && getRefImageBlob) {
        for (const sid of refSourcesOrdered) {
          const blob = await getRefImageBlob(sid);
          if (!blob) continue;
          const dataUrl = await blobToDataUrl(blob);
          refUrls.push(dataUrl);
        }
      }

      const result = await generateImage({
        apiKey: prefs.openaiApiKey,
        prompt: trimmed,
        size,
        quality,
        outputFormat: format,
        previousResponseId: baseSession.lastResponseId,
        referenceImageUrls: refUrls.length > 0 ? refUrls : undefined,
      });

      // Upload each returned image to private bucket.
      const ext = formatToExt(format);
      const mime = formatToMime(format);
      const uploads: ImageGenMessage["images"] = [];
      for (const img of result.images) {
        const blob = base64ToBlob(img.b64, mime);
        const id = newGenerationId();
        const up = await uploadPrivateImage({
          projectId,
          nodeId: node.id,
          imageId: id,
          ext,
          mime,
          blob,
        });
        if ("error" in up) throw new Error(up.error);
        uploads.push({
          path: up.path,
          format,
          revisedPrompt: img.revisedPrompt,
        });
      }

      const completed: ImageGenMessage = {
        ...pending,
        status: "done",
        images: uploads,
      };
      const nextMessages = optimistic.messages.map((m) =>
        m.id === msgId ? completed : m
      );
      const nextSession: ImageGenSession = {
        ...optimistic,
        lastResponseId: result.responseId,
        messages: nextMessages,
      };
      setSession(nextSession);

      const persist = await upsertSession({
        projectId,
        nodeId: node.id,
        messages: nextMessages,
        lastResponseId: result.responseId,
      });
      if (!persist.ok) {
        // The images uploaded successfully — only the metadata
        // failed. Surface but don't roll back.
        setTopError(`Saved images but session save failed: ${persist.error}`);
      }

      // Auto-select the first image if nothing is selected yet.
      if (!selectedPath && uploads.length > 0) {
        await selectImage(uploads[0].path, ext, mime);
      }
    } catch (e) {
      const oe = e as OpenAIError | Error;
      const message =
        "message" in oe ? oe.message : "Generation failed.";
      const failedMessages = optimistic.messages.map((m) =>
        m.id === msgId ? { ...m, status: "error" as const, error: message } : m
      );
      setSession({
        ...optimistic,
        messages: failedMessages,
      });
      setTopError(message);
      // Persist the error message too so the chat survives a reload.
      await upsertSession({
        projectId,
        nodeId: node.id,
        messages: failedMessages,
        lastResponseId: baseSession.lastResponseId,
      });
    } finally {
      setBusy(false);
    }
  };

  // ---- Selection → publish to public bucket -------------------------
  const selectImage = async (
    privatePath: string,
    ext: string,
    mime: string
  ) => {
    if (!projectId) return;
    // Reuse the SAME imageId for the public copy so:
    //   1. The selected-state highlight in the thumb grid can match
    //      a private path against the saved public URL via the
    //      shared filename basename.
    //   2. Clicking the same thumbnail twice doesn't create
    //      orphaned dupes in the public bucket — `upsert: true`
    //      overwrites the existing object at the deterministic path.
    const fname = privatePath.split("/").pop() ?? "";
    const imageId = fname.replace(/\.[^.]+$/, "") || newGenerationId();
    try {
      const supa = await import("@/lib/supabase/client").then((m) =>
        m.createClient()
      );
      const dl = await supa.storage
        .from("image-gen-private")
        .download(privatePath);
      if (dl.error || !dl.data) {
        setTopError(dl.error?.message ?? "Couldn't fetch selected image.");
        return;
      }
      const pub = await publishSelected({
        projectId,
        nodeId: node.id,
        imageId,
        ext,
        mime,
        blob: dl.data,
      });
      if ("error" in pub) {
        setTopError(`Publish failed: ${pub.error}`);
        return;
      }
      // Decode the bytes we ALREADY have into an ImageBitmap and
      // hand it to the global image cache, keyed by the public URL.
      // The node compute reads this cache synchronously — so the
      // very first frame after the param change can blit the
      // texture, no second-pass pipeline-bump dance required.
      // (Falls back to async fetch in compute when the cache is
      // cold, e.g. on project reload.)
      try {
        const bitmap = await createImageBitmap(dl.data);
        setCachedImage(pub.url, bitmap);
      } catch {
        // Bitmap decode failure is non-fatal — the compute path
        // will still try to fetch the URL on its own.
      }
      onParamChange(node.id, "selectedImagePath", pub.url);
      // Belt-and-suspenders: nudge a pipeline re-eval explicitly.
      // The param change already triggers a re-render, but the
      // explicit bump guarantees the renderFrame effect re-runs
      // even if some upstream React state happens to be unchanged.
      window.dispatchEvent(new Event("pipeline-bump"));
    } catch (e) {
      setTopError((e as Error).message ?? "Selection failed.");
    }
  };

  const onClickThumb = (privatePath: string, imgFormat: string) => {
    const ext = formatToExt(imgFormat);
    const mime = formatToMime(imgFormat);
    void selectImage(privatePath, ext, mime);
  };

  // ---- Render -------------------------------------------------------
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        gap: 0,
      }}
    >
      {/* Node-specific menu bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "#111114",
          border: "1px solid #27272a",
          borderRadius: 4,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            color: "#fafafa",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          Image Generate
        </div>
        <div style={{ color: "#52525b", fontSize: 10 }}>
          {size} · {quality} · {format}
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          title="Size & format settings"
          style={iconBtnStyle(settingsOpen)}
        >
          ⚙
        </button>
      </div>

      {/* Settings popover */}
      {settingsOpen && (
        <div
          style={{
            margin: "6px 0 0 0",
            padding: "8px 10px",
            background: "#111114",
            border: "1px solid #27272a",
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <Field label="Size">
            <Select
              value={size}
              options={[
                "auto",
                "1024x1024",
                "1536x1024",
                "1024x1536",
                "2048x2048",
                "3840x2160",
              ]}
              onChange={(v) => onParamChange(node.id, "size", v)}
            />
          </Field>
          <Field label="Quality">
            <Select
              value={quality}
              options={["auto", "low", "medium", "high"]}
              onChange={(v) => onParamChange(node.id, "quality", v)}
            />
          </Field>
          <Field label="Format">
            <Select
              value={format}
              options={["png", "jpeg", "webp"]}
              onChange={(v) => onParamChange(node.id, "format", v)}
            />
          </Field>
        </div>
      )}

      {/* Load-failed banner — surfaced when the session row failed
          to fetch (network blip, RLS misconfig, etc.). Critical to
          show this loud so the user knows the chat is in an
          undefined state — sending while in this state would
          overwrite history with an empty record. */}
      {loadFailed && (
        <div
          style={{
            margin: "6px 0 0 0",
            padding: "6px 10px",
            background: "rgba(180, 83, 9, 0.12)",
            border: "1px solid #b45309",
            color: "#fde68a",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>
            Couldn&apos;t load chat history: {loadFailed}. Sends are
            blocked until this clears so we don&apos;t overwrite
            existing messages.
          </span>
          <button
            type="button"
            onClick={retryLoad}
            style={{
              padding: "2px 10px",
              background: "transparent",
              border: "1px solid #b45309",
              color: "#fde68a",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Top-level error banner — survives across messages */}
      {topError && (
        <div
          style={{
            margin: "6px 0 0 0",
            padding: "6px 10px",
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid #b91c1c",
            color: "#fecaca",
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.4,
            flexShrink: 0,
          }}
        >
          {topError}
        </div>
      )}

      {/* Two-column body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginTop: 6,
        }}
      >
        {/* Left: chat log + input */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "#0a0a0a",
            border: "1px solid #27272a",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {loading && (
              <div style={{ color: "#52525b", fontStyle: "italic" }}>
                Loading…
              </div>
            )}
            {!loading &&
              (!session || session.messages.length === 0) && (
                <div style={{ color: "#52525b", fontStyle: "italic" }}>
                  No prompts yet. Type below and hit Send.
                </div>
              )}
            {session?.messages.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: "6px 8px",
                  background: "#0f0f12",
                  border: "1px solid #27272a",
                  borderRadius: 3,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div
                  style={{
                    color: "#e5e7eb",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.prompt}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    color: "#71717a",
                    fontSize: 10,
                  }}
                >
                  <span>{statusBadge(m.status)}</span>
                  <span>{m.images.length} img</span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {m.status === "pending" && <InlineSpinner />}
                    {relativeTime(m.createdAt)}
                  </span>
                </div>
                {m.error && (
                  <div style={{ color: "#fecaca", fontSize: 10 }}>
                    {m.error}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div
            style={{
              padding: 8,
              borderTop: "1px solid #27272a",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  prompt.trim()
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Describe the image…"
              rows={3}
              disabled={busy}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "6px 8px",
                background: "#0f0f12",
                border: "1px solid #27272a",
                borderRadius: 3,
                color: "#e5e7eb",
                fontFamily: "inherit",
                fontSize: 11,
                resize: "vertical",
                opacity: busy ? 0.6 : 1,
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <div
                style={{ color: "#52525b", fontSize: 10 }}
                title={
                  wiredRefLabels.length > 0
                    ? `Will attach reference images from ref_${wiredRefLabels
                        .join(", ref_")
                        .toLowerCase()} on next send.`
                    : "Wire ref_a / ref_b / ref_c sockets on the node to attach reference images."
                }
              >
                refs:{" "}
                {(["A", "B", "C"] as const).map((k) => {
                  const on = wiredRefLabels.includes(k);
                  return (
                    <span
                      key={k}
                      style={{
                        color: on ? "#bfdbfe" : "#3f3f46",
                        marginLeft: 4,
                        fontWeight: on ? 600 : 400,
                      }}
                    >
                      {k}
                    </span>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={send}
                disabled={!prompt.trim() || busy || !!loadFailed}
                title={
                  loadFailed
                    ? "Resolve the load-failed banner above before sending."
                    : undefined
                }
                style={{
                  ...btnStyle(),
                  background:
                    prompt.trim() && !busy && !loadFailed
                      ? "#1e3a8a"
                      : "transparent",
                  border: `1px solid ${
                    prompt.trim() && !busy && !loadFailed
                      ? "#1d4ed8"
                      : "#3f3f46"
                  }`,
                  color:
                    prompt.trim() && !busy && !loadFailed
                      ? "#bfdbfe"
                      : "#52525b",
                  opacity:
                    prompt.trim() && !busy && !loadFailed ? 1 : 0.6,
                }}
              >
                {busy ? "Generating…" : "Send"}
              </button>
            </div>
          </div>
        </div>

        {/* Right: thumbnails */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "#0a0a0a",
            border: "1px solid #27272a",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "4px 8px",
              borderBottom: "1px solid #27272a",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
            }}
          >
            <div style={{ color: "#a1a1aa", fontSize: 10 }}>Generations</div>
            <div style={{ display: "flex", gap: 0 }}>
              {(["grid", "list"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onParamChange(node.id, "view", v)}
                  style={{
                    ...btnStyle(),
                    padding: "1px 8px",
                    fontSize: 10,
                    background: view === v ? "#0a0a0a" : "transparent",
                    border: `1px solid ${
                      view === v ? "#52525b" : "#3f3f46"
                    }`,
                    color: view === v ? "#fafafa" : "#a1a1aa",
                    borderRadius: 0,
                    marginLeft: -1,
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <ThumbList
            session={session}
            view={view as "grid" | "list"}
            signed={signedRef.current}
            selectedPath={selectedPath}
            onClickThumb={onClickThumb}
          />
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Thumbnails
// ----------------------------------------------------------------------

function ThumbList({
  session,
  view,
  signed,
  selectedPath,
  onClickThumb,
}: {
  session: ImageGenSession | null;
  view: "grid" | "list";
  signed: Map<string, string>;
  selectedPath: string;
  onClickThumb: (path: string, format: string) => void;
}) {
  // Flatten newest-first.
  const items: Array<{
    path: string;
    format: string;
    revised: string;
  }> = [];
  if (session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      for (const img of m.images) {
        items.push({
          path: img.path,
          format: img.format,
          revised: img.revisedPrompt ?? "",
        });
      }
    }
  }

  // Custom drag mime so the node editor's drop handler can
  // distinguish our thumbnails from native OS file drags.
  const onDragStart = (
    e: React.DragEvent<HTMLButtonElement>,
    path: string,
    fmt: string
  ) => {
    e.dataTransfer.setData(
      "application/x-toolbox-image-gen",
      JSON.stringify({ privatePath: path, format: fmt })
    );
    e.dataTransfer.effectAllowed = "copy";
  };

  if (items.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: 8,
          color: "#52525b",
          fontSize: 11,
          fontStyle: "italic",
        }}
      >
        Thumbnails will appear here after the first generation.
      </div>
    );
  }

  // Match a private path against the saved public URL by their
  // shared imageId basename. Both paths are
  //   …/<imageId>.<ext>
  // because selectImage() reuses the private imageId on publish.
  const isSelected = (path: string) => {
    if (!selectedPath) return false;
    const fname = path.split("/").pop() ?? "";
    const imageId = fname.replace(/\.[^.]+$/, "");
    return imageId !== "" && selectedPath.includes(imageId);
  };

  if (view === "list") {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {items.map((it) => {
          const url = signed.get(it.path);
          const sel = isSelected(it.path);
          return (
            <button
              key={it.path}
              type="button"
              onClick={() => onClickThumb(it.path, it.format)}
              draggable
              onDragStart={(e) => onDragStart(e, it.path, it.format)}
              title={`${it.revised}\n\nDrag onto the node editor to spawn an Image Source.`}
              style={{
                display: "flex",
                gap: 8,
                padding: 4,
                background: sel ? "#1e3a8a" : "transparent",
                border: `1px solid ${sel ? "#fafafa" : "#27272a"}`,
                borderRadius: 3,
                cursor: "pointer",
                alignItems: "center",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  background: "#0f0f12",
                  borderRadius: 2,
                  flexShrink: 0,
                  overflow: "hidden",
                }}
              >
                {url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  flex: 1,
                  color: "#a1a1aa",
                  fontSize: 10,
                  lineHeight: 1.4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {it.revised || "(generated image)"}
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: 6,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
        gap: 6,
      }}
    >
      {items.map((it) => {
        const url = signed.get(it.path);
        const sel = isSelected(it.path);
        return (
          <button
            key={it.path}
            type="button"
            onClick={() => onClickThumb(it.path, it.format)}
            draggable
            onDragStart={(e) => onDragStart(e, it.path, it.format)}
            title={`${it.revised}\n\nDrag onto the node editor to spawn an Image Source.`}
            style={{
              aspectRatio: "1 / 1",
              padding: 0,
              background: "#0f0f12",
              border: `1px solid ${sel ? "#fafafa" : "#27272a"}`,
              borderRadius: 3,
              cursor: "pointer",
              overflow: "hidden",
              boxShadow: sel ? "0 0 0 1px rgba(250,250,250,0.3)" : "none",
            }}
          >
            {url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------
// Tiny helpers
// ----------------------------------------------------------------------

// Tiny inline spinner. SVG circle with a partial dasharray so a
// pending request shows visible motion. Driven by the keyframe
// declared in globals.css under `.toolbox-spinner`.
function InlineSpinner() {
  return (
    <svg
      className="toolbox-spinner"
      width="9"
      height="9"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="#71717a"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="40"
        strokeDashoffset="20"
      />
    </svg>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("blob read failed"));
    r.readAsDataURL(blob);
  });
}

function statusBadge(s: "pending" | "done" | "error"): string {
  if (s === "pending") return "…";
  if (s === "done") return "✓";
  return "✗";
}

function relativeTime(ts: number): string {
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return `${Math.max(1, Math.floor(dt))}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: 80,
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "3px 6px",
        background: "#0f0f12",
        border: "1px solid #27272a",
        color: "#e5e7eb",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 3,
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function iconBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "1px 8px",
    background: active ? "#0a0a0a" : "transparent",
    border: `1px solid ${active ? "#52525b" : "#3f3f46"}`,
    color: active ? "#fafafa" : "#a1a1aa",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: 1,
    borderRadius: 3,
    cursor: "pointer",
  };
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "3px 10px",
    background: "transparent",
    border: "1px solid #3f3f46",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
