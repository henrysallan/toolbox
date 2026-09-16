# ProRes 4444 alpha: why exports looked opaque, and the ffmpeg bump

**Status:** shipped (2026-09-15). Desktop export path only.

## Symptom

ProRes 4444 exports with `videoAlpha` on had no transparency in Premiere, but
*did* in DaVinci Resolve. The files looked correct by every normal check, which
is what made this expensive to diagnose.

## What was actually wrong

`ffmpeg-static` (npm 5.3.0, the latest published) ships **ffmpeg 6.0**, whose
`prores_ks` encoder writes an alpha plane Apple's ProRes decoder will not read.
Two separate defects, one masking the other:

1. **Frame header `bitstream_version` = 0.** Apple's decoder ignores the alpha
   plane entirely on version-0 frames and returns solid 255. ffmpeg ≥ 8 writes
   version 1, as Apple's own encoder does.
2. **The encoded alpha data itself.** Patching only the version byte to 1 makes
   VideoToolbox *parse* the alpha and then fail (`-12911`) on every frame with
   partial alpha — it decodes hard-edged test patterns but not real soft-edged
   footage. Both `-alpha_bits 8` and `16` fail the same way.

So ffmpeg 6.0 cannot produce Apple-readable ProRes alpha at all; no flag
combination or post-hoc container patch fixes it.

## Why it was hard to see

- ffprobe reports everything correct: `yuva444p12le`, `depth 32`,
  `alpha_info 2`. Alpha is declared in three places and only the third — the
  encoded data — was wrong.
- ffmpeg decodes its own broken output perfectly (encoder and decoder share the
  same assumptions), so a round-trip check passes.
- Apple's decoder fails *silently*, returning opaque pixels rather than an
  error, so it reads as "toolbox didn't export alpha."
- Resolve has its own lenient decoder and shows the alpha, which points
  suspicion at app settings instead of the file.
- It is content-dependent: a synthetic hard-edged clip can pass while real
  footage fails.

**The only reliable test is decoding with Apple's decoder** (AVFoundation /
VideoToolbox). `npm run check:prores-alpha` does exactly that.

## The fix

Dropped `ffmpeg-static` as a runtime dependency (it is dev-only now, for
`scripts/bench-video-seek.cjs`) in favor of a vendored **ffmpeg 9.0**:

- `scripts/fetch-ffmpeg.mjs` downloads the per-platform binary into
  `vendor/ffmpeg/<platform>-<arch>/` (gitignored), pinned by SHA256 on both the
  archive and the extracted binary. Runs from `postinstall`, like
  `ffmpeg-static`'s own installer did.
- macOS arm64 comes from osxexperts.net — **the same upstream `ffmpeg-static`
  already used** for Apple Silicon, just current. Windows x64 comes from a
  pinned (dated, immutable) BtbN autobuild tag.
- electron-builder ships it via `extraResources` into `Contents/Resources`,
  with `mac.binaries` so it gets signed under the hardened runtime.
- Both builds are `--enable-gpl` with **no** `--enable-nonfree`, unlike the old
  `ffmpeg-static` binary (which was built `--enable-gpl --enable-nonfree`, i.e.
  not redistributable as read strictly).

### Verified 2026-09-15

- All 100 frames of a real 4444 alpha export decode in VideoToolbox with correct
  alpha; alpha is bit-exact vs the source (PSNR `inf`).
- Every codec the UI offers still encodes: h264, h264-lossless, h265, vp9+opus,
  av1, qtrle, prores 422/4444, aac audio.
- End-to-end through the real export path (`buildEncoderArgs` + rawvideo RGBA8
  on stdin, as `electron/ffmpeg.js` spawns it).

## Gotchas for next time

- **`process.arch` lies on the studio Mac** (node/electron run x64 under
  Rosetta on arm64 hardware). `fetch-ffmpeg.mjs` asks
  `sysctl hw.optional.arm64`; `electron/ffmpeg.js` falls back across arches in
  dev. Same trap the devguide flags for `ffmpeg-static`.
- **The macOS URL is mutable** — osxexperts republishes at the same path, so a
  SHA256 mismatch means a new upstream build, not corruption. Re-verify with
  `npm run check:prores-alpha` before repinning.
- **`qtrle` is not the universal fallback** the export UI comment claims.
  macOS has no QuickTime Animation decoder any more (AVFoundation: "decoder
  required for this media cannot be found"), so those files do not open in FCP
  or QuickTime at all. Premiere/AE ship their own RLE decoder, so it works
  there. The same comment's claim that Resolve ignores ffmpeg's ProRes alpha is
  also wrong — Resolve reads it fine.

## Still open

- **Web export path is unfixed.** `@ffmpeg/core` 0.12.10 (latest published) is
  ffmpeg 5.1 (`Lavc59.37`), so browser-tier ProRes alpha has the same bug. There
  is no newer published core; options are a custom wasm build, gating
  ProRes+alpha to desktop, or steering to PNG sequence. Decided out of scope.
- **A blank frame 1** in the sample export (`WhatmorePuma01.mov`): both RGB and
  alpha are empty on that one frame while 0 and 2 are fine. Unrelated to the
  codec — a toolbox render glitch, not investigated.
