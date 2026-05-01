"use client";

// Eye-icon toggle that controls whether an animated parameter shows up
// as a track in the Track Editor (spec §3.1). Always rendered for layout
// consistency; when the parameter is not animated the icon is dim and
// non-interactive.

interface Props {
  visible: boolean;
  enabled: boolean;
  onClick(): void;
  title?: string;
}

const SIZE = 14;

export default function TrackVisibilityEye({
  visible,
  enabled,
  onClick,
  title,
}: Props) {
  const color = !enabled ? "#52525b" : visible ? "#d4d4d8" : "#52525b";
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        if (!enabled) return;
        e.stopPropagation();
        onClick();
      }}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        width: SIZE + 4,
        height: SIZE + 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: enabled ? "pointer" : "default",
        opacity: enabled ? 1 : 0.35,
        pointerEvents: enabled ? "auto" : "none",
        lineHeight: 0,
        color,
      }}
    >
      {visible || !enabled ? (
        <svg width={SIZE} height={SIZE} viewBox="0 0 14 14" fill="none">
          <path
            d="M1 7 C 2.5 4, 4.5 2.5, 7 2.5 C 9.5 2.5, 11.5 4, 13 7 C 11.5 10, 9.5 11.5, 7 11.5 C 4.5 11.5, 2.5 10, 1 7 Z"
            stroke="currentColor"
            strokeWidth="1.1"
            fill="none"
          />
          <circle cx="7" cy="7" r="1.7" fill="currentColor" />
        </svg>
      ) : (
        <svg width={SIZE} height={SIZE} viewBox="0 0 14 14" fill="none">
          <path
            d="M1 8.5 C 2.5 6, 4.5 4.7, 7 4.7 C 9.5 4.7, 11.5 6, 13 8.5"
            stroke="currentColor"
            strokeWidth="1.1"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M2.2 11 L 11.8 4"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
