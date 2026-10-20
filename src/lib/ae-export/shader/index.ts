// Fused GLSL → Toolbox Shader bundle (spec 091926_after-effects-handoff.md
// §7.4, contract ABI.md). Pure modules only; the macOS compiler / probe
// (native.ts) is node-only and imported directly by the tools that need it.

export { glslToMsl, listGlslUniforms } from "./translate";
export type { GlslToMslOptions, GlslToMslResult, MslUniform, GlslError, MslBinding, ImageSlot } from "./translate";
export { bundleFromGlslExpression, TBX_SHADER_HOST_MIN } from "./bundle";
export type { BundleOptions, BundleResult } from "./bundle";
export { writeTbxfx, bundleId, canonicalJson } from "./tbxfx";
export { validateAeShader } from "./validate";
export type { AeShaderValidation, AeShaderIssue, ShaderCompiler, ShaderCompileResult, ShaderValidator, ValidateOptions } from "./validate";
export { MSL_ABI_VERSION } from "./emit-msl";
export { TBX_MSL_PRELUDE, TBX_MSL_EPILOGUE, fullMslSource } from "./prelude";
