// msl-compile — runtime Metal compiler + shade() probe for the Toolbox Shader
// gates (src/lib/ae-export/shader/native.ts builds this into a temp dir with
// clang and runs it; nothing ships it).
//
// The Metal Toolchain component (the offline `metal` compiler) is not
// installed on every Mac, but the Metal framework compiles source at runtime
// — the same newLibraryWithSource call the Toolbox Shader host makes. The
// compile options mirror the host (../AE_Plugins/toolbox-shader
// src/gpu/metal.mm): IEEE math (MTLMathModeSafe + precise functions) and
// MSL 3.0, so a probe sees what the host sees.
//
//   msl-compile compile <file.metal>
//       stdout: {"ok":bool,"device":"…","log":"…"}   exit 0 ok · 1 compile error · 2 setup
//   msl-compile probe <job.json>
//       job: {"source": "<file.metal>", "kernel": "tbx_probe",
//             "uniforms": {"res":[w,h],"time":t,"frame":f,"aspect":a,
//                          "sliders":[32],"colors":[[r,g,b,a]…8],"points":[[x,y]…8],"checkboxes":[8]},
//             "textures": [12 × null | {"w":…,"h":…,"data":[w*h*4 floats],"format":"rgba16f"|"rgba32f"}],
//             "uvs": [u0,v0,u1,v1,…], "fastMath": false}
//       The kernel signature is the one prelude.ts's probe epilogue declares:
//         (constant TbxUniforms& [[buffer(0)]], device const float2* uvs [[buffer(1)]],
//          device float4* out [[buffer(2)]], constant uint& count [[buffer(3)]],
//          texture2d<float> a..d [[texture(0..3)]], l0..l7 [[texture(4..11)]],
//          uint gid [[thread_position_in_grid]])
//       Texture memory row 0 is uv.y = 0 (the GL convention), so a probe and a
//       WebGL render of the same data agree without a flip.
//       stdout: {"ok":true,"device":"…","out":[r,g,b,a,…]}   (floats printed %.9g)
//
// Build: clang -fobjc-arc -O2 msl-compile.m -framework Metal -framework Foundation -o msl-compile

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <simd/simd.h>
#include <stdio.h>

// TbxUniforms as MSL lays it out (ABI.md): simd types carry MSL's alignment,
// so float4 colors start at offset 160 after 12 bytes of padding.
typedef struct {
  simd_float2 res;
  float time;
  float frame;
  float aspect;
  float sliders[32];
  simd_float4 colors[8];
  simd_float2 points[8];
  int checkboxes[8];
} TbxUniforms;

static void emitJson(NSDictionary* obj) {
  NSData* d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  fwrite(d.bytes, 1, d.length, stdout);
  fputc('\n', stdout);
}

static int fail(int code, NSString* device, NSString* log) {
  emitJson(@{@"ok" : @NO, @"device" : device ?: @"", @"log" : log ?: @""});
  return code;
}

static NSString* describe(NSError* e) {
  if (!e) return @"";
  return e.localizedDescription ?: @"";
}

// fast = Metal's default fast math, for diagnosing a reference renderer that
// compiles that way (a probe job's "fastMath": true). The host never does.
static MTLCompileOptions* compileOptions(BOOL fast) {
  MTLCompileOptions* opts = [MTLCompileOptions new];
  if (@available(macOS 15.0, *)) {
    opts.mathMode = fast ? MTLMathModeFast : MTLMathModeSafe;
    opts.mathFloatingPointFunctions = fast ? MTLMathFloatingPointFunctionsFast : MTLMathFloatingPointFunctionsPrecise;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    opts.fastMathEnabled = fast;
#pragma clang diagnostic pop
  }
  if (@available(macOS 13.0, *)) opts.languageVersion = MTLLanguageVersion3_0;
  return opts;
}

static float num(id v, float fallback) {
  return [v isKindOfClass:[NSNumber class]] ? [(NSNumber*)v floatValue] : fallback;
}

static id<MTLTexture> makeTexture(id<MTLDevice> device, id spec) {
  int w = 1, h = 1;
  BOOL half = YES;
  NSArray* data = nil;
  if ([spec isKindOfClass:[NSDictionary class]]) {
    w = (int)num(spec[@"w"], 1);
    h = (int)num(spec[@"h"], 1);
    data = spec[@"data"];
    half = ![@"rgba32f" isEqualToString:spec[@"format"]];
  }
  MTLTextureDescriptor* td =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:(half ? MTLPixelFormatRGBA16Float : MTLPixelFormatRGBA32Float)
                                                        width:(NSUInteger)w
                                                       height:(NSUInteger)h
                                                    mipmapped:NO];
  td.usage = MTLTextureUsageShaderRead;
  td.storageMode = MTLStorageModeShared;
  id<MTLTexture> tex = [device newTextureWithDescriptor:td];
  size_t n = (size_t)w * h * 4;
  if (half) {
    __fp16* px = calloc(n, sizeof(__fp16));
    for (size_t i = 0; i < n && data && i < data.count; i++) px[i] = (__fp16)num(data[i], 0);
    [tex replaceRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0 withBytes:px bytesPerRow:(NSUInteger)w * 4 * sizeof(__fp16)];
    free(px);
  } else {
    float* px = calloc(n, sizeof(float));
    for (size_t i = 0; i < n && data && i < data.count; i++) px[i] = num(data[i], 0);
    [tex replaceRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0 withBytes:px bytesPerRow:(NSUInteger)w * 4 * sizeof(float)];
    free(px);
  }
  return tex;
}

static int runCompile(id<MTLDevice> device, NSString* path) {
  NSError* e = nil;
  NSString* src = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&e];
  if (!src) return fail(2, device.name, [@"cannot read source: " stringByAppendingString:describe(e)]);
  id<MTLLibrary> lib = [device newLibraryWithSource:src options:compileOptions(NO) error:&e];
  // Warnings also set e, so only a missing library is a failure (the dither host's rule).
  if (!lib) return fail(1, device.name, describe(e));
  emitJson(@{@"ok" : @YES, @"device" : device.name, @"log" : describe(e), @"functions" : lib.functionNames ?: @[]});
  return 0;
}

static int runProbe(id<MTLDevice> device, NSString* jobPath) {
  NSError* e = nil;
  NSData* jobData = [NSData dataWithContentsOfFile:jobPath options:0 error:&e];
  if (!jobData) return fail(2, device.name, [@"cannot read job: " stringByAppendingString:describe(e)]);
  NSDictionary* job = [NSJSONSerialization JSONObjectWithData:jobData options:0 error:&e];
  if (![job isKindOfClass:[NSDictionary class]]) return fail(2, device.name, @"job is not a JSON object");
  NSString* src = [NSString stringWithContentsOfFile:job[@"source"] encoding:NSUTF8StringEncoding error:&e];
  if (!src) return fail(2, device.name, [@"cannot read source: " stringByAppendingString:describe(e)]);
  id<MTLLibrary> lib = [device newLibraryWithSource:src options:compileOptions([job[@"fastMath"] boolValue]) error:&e];
  if (!lib) return fail(1, device.name, describe(e));
  NSString* kernelName = job[@"kernel"] ?: @"tbx_probe";
  id<MTLFunction> fn = [lib newFunctionWithName:kernelName];
  if (!fn) return fail(2, device.name, [@"no kernel named " stringByAppendingString:kernelName]);
  id<MTLComputePipelineState> pso = [device newComputePipelineStateWithFunction:fn error:&e];
  if (!pso) return fail(2, device.name, [@"pipeline: " stringByAppendingString:describe(e)]);

  TbxUniforms U;
  memset(&U, 0, sizeof U);
  NSDictionary* u = job[@"uniforms"];
  NSArray* res = u[@"res"];
  U.res = simd_make_float2(num(res[0], 1), num(res[1], 1));
  U.time = num(u[@"time"], 0);
  U.frame = num(u[@"frame"], 0);
  U.aspect = num(u[@"aspect"], 1);
  NSArray* sl = u[@"sliders"];
  for (NSUInteger i = 0; i < 32 && i < sl.count; i++) U.sliders[i] = num(sl[i], 0);
  NSArray* co = u[@"colors"];
  for (NSUInteger i = 0; i < 8 && i < co.count; i++) {
    NSArray* c = co[i];
    U.colors[i] = simd_make_float4(num(c[0], 0), num(c[1], 0), num(c[2], 0), num(c[3], 0));
  }
  NSArray* pt = u[@"points"];
  for (NSUInteger i = 0; i < 8 && i < pt.count; i++) {
    NSArray* p = pt[i];
    U.points[i] = simd_make_float2(num(p[0], 0), num(p[1], 0));
  }
  NSArray* cb = u[@"checkboxes"];
  for (NSUInteger i = 0; i < 8 && i < cb.count; i++) U.checkboxes[i] = (int)num(cb[i], 0);

  NSArray* uvList = job[@"uvs"];
  uint32_t count = (uint32_t)(uvList.count / 2);
  if (count == 0) return fail(2, device.name, @"no uvs");
  float* uvs = calloc(count * 2, sizeof(float));
  for (uint32_t i = 0; i < count * 2; i++) uvs[i] = num(uvList[i], 0);

  id<MTLBuffer> ub = [device newBufferWithBytes:&U length:sizeof U options:MTLResourceStorageModeShared];
  id<MTLBuffer> uvb = [device newBufferWithBytes:uvs length:count * 2 * sizeof(float) options:MTLResourceStorageModeShared];
  id<MTLBuffer> outb = [device newBufferWithLength:count * 4 * sizeof(float) options:MTLResourceStorageModeShared];
  id<MTLBuffer> cntb = [device newBufferWithBytes:&count length:sizeof count options:MTLResourceStorageModeShared];
  free(uvs);

  NSArray* texSpecs = job[@"textures"];
  id<MTLCommandQueue> q = [device newCommandQueue];
  id<MTLCommandBuffer> cmd = [q commandBuffer];
  id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];
  [enc setComputePipelineState:pso];
  [enc setBuffer:ub offset:0 atIndex:0];
  [enc setBuffer:uvb offset:0 atIndex:1];
  [enc setBuffer:outb offset:0 atIndex:2];
  [enc setBuffer:cntb offset:0 atIndex:3];
  for (NSUInteger i = 0; i < 12; i++) {
    id spec = i < texSpecs.count ? texSpecs[i] : [NSNull null];
    [enc setTexture:makeTexture(device, spec) atIndex:i];
  }
  NSUInteger tg = MIN((NSUInteger)64, pso.maxTotalThreadsPerThreadgroup);
  [enc dispatchThreads:MTLSizeMake(count, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
  [enc endEncoding];
  [cmd commit];
  [cmd waitUntilCompleted];
  if (cmd.error) return fail(2, device.name, [@"command buffer: " stringByAppendingString:describe(cmd.error)]);

  const float* out = (const float*)outb.contents;
  // Hand-rolled so every float prints round-trip exact (%.9g); NaN/Inf as null.
  printf("{\"ok\":true,\"device\":\"%s\",\"out\":[", device.name.UTF8String);
  for (uint32_t i = 0; i < count * 4; i++) {
    float v = out[i];
    if (isfinite(v)) printf(i ? ",%.9g" : "%.9g", v);
    else printf(i ? ",null" : "null");
  }
  printf("]}\n");
  return 0;
}

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "usage: msl-compile compile <file.metal> | probe <job.json>\n");
      return 2;
    }
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) return fail(2, nil, @"no Metal device");
    NSString* mode = @(argv[1]);
    NSString* path = @(argv[2]);
    if ([mode isEqualToString:@"compile"]) return runCompile(device, path);
    if ([mode isEqualToString:@"probe"]) return runProbe(device, path);
    return fail(2, device.name, [@"unknown mode " stringByAppendingString:mode]);
  }
}
