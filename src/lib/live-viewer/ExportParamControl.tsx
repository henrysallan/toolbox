"use client";

import type { ParamDef } from "@/engine/types";
import { ColorSwatchPicker } from "@/lib/color-picker-popover";

export function ExportParamControl({
  param,
  value,
  onChange,
  disabled,
}: {
  param: ParamDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  if (param.type === "scalar") {
    const num =
      typeof value === "number" ? value : (param.default as number) ?? 0;
    const min = param.min ?? 0;
    const max = param.max ?? 1;
    const softMax = param.softMax;
    const sliderMax = softMax ?? max;
    const sliderMin = min;
    const sliderValue = Math.max(sliderMin, Math.min(sliderMax, num));
    const step = param.step ?? 0.01;
    return (
      <div className="scalar-row">
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={step}
          value={sliderValue}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <input
          type="number"
          value={num}
          step={step}
          disabled={disabled}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      </div>
    );
  }

  if (param.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  if (param.type === "string") {
    const current =
      typeof value === "string" ? value : (param.default as string) ?? "";
    if (param.multiline) {
      return (
        <textarea
          className="textarea-input"
          value={current}
          placeholder={param.placeholder}
          disabled={disabled}
          spellCheck={false}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    return (
      <input
        className="text-input"
        type="text"
        value={current}
        placeholder={param.placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (param.type === "enum") {
    const options = param.options ?? [];
    const current =
      typeof value === "string" ? value : (param.default as string) ?? "";
    return (
      <select
        className="select-input"
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (param.type === "color") {
    const hex =
      typeof value === "string"
        ? value
        : (param.default as string) ?? "#000000";
    // The app's universal picker instead of the native browser dialog —
    // native <input type="color"> can never carry alpha, and alpha-enabled
    // params (ParamDef.alpha, carried through the manifest's def clone)
    // need the popover's alpha strip.
    return (
      <ColorSwatchPicker
        value={hex}
        onChange={(h) => onChange(h)}
        alpha={param.alpha}
        disabled={disabled}
        swatchStyle={{ width: "100%", height: 24 }}
      />
    );
  }

  if (
    param.type === "vec2" ||
    param.type === "vec3" ||
    param.type === "vec4"
  ) {
    const dim = param.type === "vec2" ? 2 : param.type === "vec3" ? 3 : 4;
    const fallback =
      (param.default as number[] | undefined) ?? new Array(dim).fill(0);
    const arr =
      Array.isArray(value) && value.length === dim
        ? (value as number[])
        : fallback;
    return (
      <div className="vec-row">
        {arr.map((v, i) => (
          <input
            key={i}
            type="number"
            value={v}
            step={param.step ?? 0.01}
            disabled={disabled}
            onChange={(e) => {
              const next = [...arr];
              const n = parseFloat(e.target.value);
              next[i] = Number.isNaN(n) ? 0 : n;
              onChange(next);
            }}
          />
        ))}
      </div>
    );
  }

  return <div className="unsupported-stub">(unsupported in export)</div>;
}
