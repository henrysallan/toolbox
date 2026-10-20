// Identifiers a GLSL ES 3.00 shader may use that MSL can't (ABI.md, "Names":
// "A GLSL identifier that is an MSL/C++ keyword … is renamed `<name>_`").
// GLSL already reserves most C++ keywords (class, template, namespace, half,
// long, …), so this list is what is legal in GLSL but breaks in MSL:
// C++ keywords GLSL doesn't reserve, MSL address-space / function qualifiers,
// MSL type names, metal_stdlib macros, and the names the emitted code itself
// relies on (TbxProgram, shade, array<>, select, atan2, …).

const CPP_KEYWORDS = [
  "alignas", "alignof", "and", "and_eq", "asm", "auto", "bitand", "bitor", "catch", "char", "char8_t", "char16_t",
  "char32_t", "compl", "concept", "consteval", "constexpr", "constinit", "const_cast", "co_await", "co_return",
  "co_yield", "decltype", "delete", "double", "dynamic_cast", "enum", "explicit", "export", "extern", "friend", "goto",
  "inline", "long", "mutable", "namespace", "new", "noexcept", "not", "not_eq", "nullptr", "operator", "or", "or_eq",
  "private", "protected", "public", "register", "reinterpret_cast", "requires", "short", "signed", "sizeof", "static",
  "static_assert", "static_cast", "template", "this", "thread_local", "throw", "try", "typedef", "typeid",
  "typename", "union", "unsigned", "using", "virtual", "volatile", "wchar_t", "xor", "xor_eq", "class", "default",
];

const MSL_KEYWORDS = [
  "kernel", "vertex", "fragment", "device", "constant", "thread", "threadgroup", "threadgroup_imageblock",
  "ray_data", "object_data", "visible", "stage_in", "patch", "mesh", "object", "intersection",
];

const MSL_TYPES = [
  "half", "bfloat", "char", "uchar", "short", "ushort", "long", "ulong", "size_t", "ptrdiff_t",
  "int8_t", "uint8_t", "int16_t", "uint16_t", "int32_t", "uint32_t", "int64_t", "uint64_t",
  "packed_float2", "packed_float3", "packed_float4", "atomic_int", "atomic_uint", "atomic_bool",
  "texture1d", "texture2d", "texture3d", "texturecube", "texture2d_array", "depth2d", "sampler", "access",
  "filter", "address", "coord", "array", "vec", "matrix", "metal", "simd", "std", "uint2", "uint3", "uint4",
];

// Names the emitter prints and must not be shadowed inside TbxProgram —
// including GLSL built-ins it introduces where the GLSL had none (abs for a
// scalar length(), sign for normalize(), all / any for vector ==).
const EMITTER_NAMES = [
  "TbxProgram", "TbxImage", "TbxUniforms", "shade", "select", "atan2", "rsqrt", "rint", "as_type",
  "abs", "sign", "all", "any",
];

const RESERVED = new Set<string>([...CPP_KEYWORDS, ...MSL_KEYWORDS, ...MSL_TYPES, ...EMITTER_NAMES]);

// metal_stdlib defines these as macros, so even a struct field named
// FLT_MAX breaks.
const MACRO_NAMES = new Set([
  "MAXFLOAT", "HUGE_VALF", "HUGE_VALH", "HUGE_VAL", "INFINITY", "NAN", "MAXHALF", "NULL",
]);
const MACRO_PREFIX = /^(?:M_|FLT_|HALF_|DBL_|INT_|UINT_|LONG_|ULONG_|SHRT_|USHRT_|CHAR_|SCHAR_|UCHAR_|FP_|BFLT_)/;

// Vector / matrix type spellings (float2, int3x… etc.) are legal GLSL names.
const MSL_VECTOR_TYPE = /^(?:float|half|int|uint|bool|short|ushort|char|uchar|long|ulong|bfloat)[234](?:x[234])?$/;

export function isMslReserved(name: string): boolean {
  return (
    RESERVED.has(name) ||
    MACRO_NAMES.has(name) ||
    // No metal_stdlib macro ends in `_`, so the renamed FLT_MAX_ is free.
    (MACRO_PREFIX.test(name) && !name.endsWith("_")) ||
    MSL_VECTOR_TYPE.test(name) ||
    name.startsWith("tbx_") ||
    name.startsWith("Tbx")
  );
}
