"use client";

// Arc spinner: a partial ring (an arc, not a full circle) that spins with a
// smooth, continuous linear rotation. Used for save/load status and per-node
// media loading. Rotation uses the shared `toolbox-spin` keyframes in
// globals.css.

interface SpinnerProps {
  // Outer box in px.
  size?: number;
  // Stroke width in px.
  stroke?: number;
  // Arc colour (defaults to the current text colour so it inherits tone).
  color?: string;
  // Fraction of the circle the arc covers, 0..1 (0.28 ≈ a 100° comet).
  arc?: number;
  // One full revolution, ms.
  durationMs?: number;
  // Optional track ring behind the arc.
  trackColor?: string;
}

export function Spinner({
  size = 14,
  stroke = 2,
  color = "currentColor",
  arc = 0.28,
  durationMs = 900,
  trackColor,
}: SpinnerProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * arc;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        display: "block",
        animation: `toolbox-spin ${durationMs}ms linear infinite`,
      }}
      aria-hidden
    >
      {trackColor && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={stroke}
        />
      )}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
      />
    </svg>
  );
}
