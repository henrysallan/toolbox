// Hand-drawn inline icons for the pie menu, house convention:
// fill:none stroke:currentColor (color flows from the chip's state), round
// caps/joins, 24×24 viewBox, rendered at 20px. Spec: 071326_pie-menu.md.

const S = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const SaveIcon = (
  <svg {...S}>
    <path d="M5 3h11l3 3v15H5z" />
    <path d="M8 3v5h7V3" />
    <path d="M8 14h8v7H8z" />
  </svg>
);

export const ProjectsIcon = (
  <svg {...S}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const AssetsIcon = (
  <svg {...S}>
    <rect x="7" y="7" width="13" height="13" rx="2" />
    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    <path d="M11 14l2.5-2.5L20 18" />
    <circle cx="11.5" cy="11" r="1.2" />
  </svg>
);

export const NewProjectIcon = (
  <svg {...S}>
    <path d="M6 3h7l5 5v13H6z" />
    <path d="M13 3v5h5" />
    <path d="M12 12v5M9.5 14.5h5" />
  </svg>
);

export const FullCanvasIcon = (
  <svg {...S}>
    <path d="M4 9V4h5" />
    <path d="M20 9V4h-5" />
    <path d="M4 15v5h5" />
    <path d="M20 15v5h-5" />
  </svg>
);

export const SplitViewportIcon = (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);

export const AddNodeIcon = (
  <svg {...S}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
