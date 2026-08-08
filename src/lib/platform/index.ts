// The single platform accessor. Import `platform` (and `isNative`) anywhere in
// the app; never branch on the target by hand. Detection is by the presence of
// the Electron-injected bridge, so the SAME bundle works on both web and
// desktop — `nativePlatform` is simply inert when no bridge exists.
//
// Spec: specdocs/archive/062626_electron-native-export.md

import { nativePlatform } from "./native";
import type { Platform } from "./types";
import { webPlatform } from "./web";

export * from "./types";

export const isNative: boolean = typeof window !== "undefined" && !!window.toolboxNative;

export const platform: Platform = isNative ? nativePlatform : webPlatform;
