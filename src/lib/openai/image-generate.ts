// Thin client for OpenAI's gpt-image-2 via the Responses API.
// Direct browser → OpenAI calls using the active user's BYO key.
// See specdocs/archive/image-generate-node.md §6 for the full request /
// response shape we're matching.
//
// IMPORTANT: the top-level `model` is a CHAT model (gpt-4.1-mini /
// gpt-5+), NOT gpt-image-2. gpt-image-2 is invoked through the
// `image_generation` tool — the chat model orchestrates the call
// and the tool produces the actual image. Sending gpt-image-2 at
// the top level always returns model_not_found regardless of
// account tier; the OpenAI docs example uses gpt-4.1-mini as the
// orchestrator. Multi-turn iteration still works via
// `previous_response_id` because that's a property of the
// Responses-API chain, not of the underlying image model.

export interface GenerateImageParams {
  apiKey: string;
  prompt: string;
  size?: string;       // "auto" | "1024x1024" | "1536x1024" | … (default auto)
  quality?: string;    // "auto" | "low" | "medium" | "high"
  outputFormat?: string; // "png" | "jpeg" | "webp"
  // Multi-turn chaining: pass the prior call's response.id and
  // OpenAI carries the prior context (prompts + images) forward.
  previousResponseId?: string | null;
  // Optional reference images attached as input_image content parts
  // on this turn. Each entry can be either a public URL (e.g. a
  // signed Supabase URL) OR an inline data: URL the model will
  // decode in-process. Empty array = no refs.
  referenceImageUrls?: string[];
  // Aborted via the caller's AbortController if the user cancels.
  signal?: AbortSignal;
}

export interface GeneratedImage {
  // Raw base64 image bytes — caller decodes + uploads to storage.
  b64: string;
  // Model's rewritten prompt (often more verbose than the input).
  // Useful as a tooltip on each generated thumbnail.
  revisedPrompt: string;
}

export interface GenerateImageResult {
  responseId: string;
  images: GeneratedImage[];
  // Token usage lifted off the response so callers can persist /
  // surface spend per session if they want to.
  usage?: unknown;
}

export interface OpenAIError {
  status: number;
  type?: string;
  code?: string;
  message: string;
}

export async function generateImage(
  args: GenerateImageParams
): Promise<GenerateImageResult> {
  const {
    apiKey,
    prompt,
    size,
    quality,
    outputFormat,
    previousResponseId,
    referenceImageUrls,
    signal,
  } = args;

  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string }
  > = [{ type: "input_text", text: prompt }];

  if (referenceImageUrls && referenceImageUrls.length > 0) {
    for (const url of referenceImageUrls) {
      content.push({ type: "input_image", image_url: url });
    }
  }

  // Tool config — only include keys we actually want to set so we
  // inherit OpenAI's defaults for the rest. gpt-image-2 ignores
  // input_fidelity, so we never send it.
  //
  // When ref images are present we FORCE `action: "edit"` so the
  // orchestrator can't drop the input on the floor and call
  // generate-from-text. With `auto`, weaker orchestrators routinely
  // ignore the attached image; "edit" makes gpt-image-2 receive the
  // input and treat it as the conditioning bitmap.
  const hasRefs = !!(referenceImageUrls && referenceImageUrls.length > 0);
  const tool: Record<string, unknown> = { type: "image_generation" };
  if (size && size !== "auto") tool.size = size;
  if (quality && quality !== "auto") tool.quality = quality;
  if (outputFormat) tool.output_format = outputFormat;
  if (hasRefs) tool.action = "edit";

  const body: Record<string, unknown> = {
    // Top-level model = chat model orchestrator. gpt-5 is the
    // smartest widely-available model that supports the
    // image_generation tool and reliably routes ref images through
    // to gpt-image-2 when the user asks for "use this as a
    // reference"-style prompts. Image generation itself still
    // happens inside the tool call on gpt-image-2.
    model: "gpt-5",
    input: [{ role: "user", content }],
    tools: [tool],
    stream: false,
  };
  if (previousResponseId) body.previous_response_id = previousResponseId;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let parsed: { error?: { type?: string; code?: string; message?: string } } = {};
    try {
      parsed = await res.json();
    } catch {
      // Non-JSON error body (rare). Fall through to generic message.
    }
    const e = parsed.error ?? {};
    const err: OpenAIError = {
      status: res.status,
      type: e.type,
      code: e.code,
      message: e.message ?? `OpenAI request failed (${res.status}).`,
    };
    throw err;
  }

  const json = (await res.json()) as {
    id: string;
    output: Array<{
      type: string;
      result?: string;
      revised_prompt?: string;
    }>;
    usage?: unknown;
  };

  const images: GeneratedImage[] = [];
  for (const part of json.output ?? []) {
    if (part.type === "image_generation_call" && part.result) {
      images.push({
        b64: part.result,
        revisedPrompt: part.revised_prompt ?? "",
      });
    }
  }

  if (images.length === 0) {
    throw {
      status: res.status,
      message:
        "OpenAI returned no images. The model may have refused the prompt.",
    } satisfies OpenAIError;
  }

  return {
    responseId: json.id,
    images,
    usage: json.usage,
  };
}

// Decode a base64 string into a Blob the caller can upload directly
// to Supabase storage.
export function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// Map our `format` param value → MIME type.
export function formatToMime(format: string | undefined): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}

// Map our `format` param value → file extension.
export function formatToExt(format: string | undefined): string {
  switch (format) {
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
    case "png":
    default:
      return "png";
  }
}
