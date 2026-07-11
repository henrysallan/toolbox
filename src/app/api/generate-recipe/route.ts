// POST /api/generate-recipe — thin Claude proxy for AI Recipe Generation
// (spec §3). Takes the client-built node catalog + a user request, asks Claude
// to emit a RecipeGraph, and returns it. Deliberately does NOT import the
// engine/node tree: that code is browser-oriented and would crash in the Node
// server runtime. All build + validation happens client-side, where the engine
// already lives; the repair loop re-POSTs here with the prior errors.

import Anthropic from "@anthropic-ai/sdk";
import {
  RECIPE_TOOL,
  buildSystem,
  buildUserContent,
} from "@/lib/ai/recipe-prompt";
import { resolveRecipeAuth } from "@/lib/ai/anthropic-key";

export const runtime = "nodejs";
// Generation with adaptive thinking + the repair loop regularly runs past a
// minute — without this the platform default can kill the request mid-way.
export const maxDuration = 300;

interface Body {
  catalog?: string;
  request?: string;
  repair?: { recipe: unknown; errors: string[] };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { catalog, request: userRequest, repair } = body;
  if (!catalog || typeof catalog !== "string")
    return Response.json({ error: "Missing `catalog`." }, { status: 400 });
  if (!userRequest || typeof userRequest !== "string")
    return Response.json({ error: "Missing `request`." }, { status: 400 });
  const auth = await resolveRecipeAuth();
  if (!auth.ok)
    return Response.json({ error: auth.error }, { status: auth.status });

  const client = new Anthropic({ apiKey: auth.apiKey });
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 12000,
      // Adaptive thinking (summarized so we can show a little of the reasoning).
      // tool_choice must be `auto` with thinking on — forced tool use + thinking
      // is rejected by the API. Opus 4.8 reliably calls the tool given the
      // "respond by calling … exactly once" instruction in the system prompt.
      thinking: { type: "adaptive", display: "summarized" },
      system: buildSystem(catalog),
      tools: [RECIPE_TOOL],
      tool_choice: { type: "auto" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: "user", content: buildUserContent(userRequest, repair as any) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError)
      return Response.json(
        { error: `Claude API error: ${err.message}` },
        { status: err.status && err.status >= 500 ? 502 : 400 }
      );
    return Response.json({ error: "Unexpected error calling Claude." }, { status: 502 });
  }

  if (message.stop_reason === "refusal")
    return Response.json({ error: "The request was declined by the model." }, { status: 422 });

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use")
    return Response.json({ error: "Model did not emit a recipe." }, { status: 502 });

  const thinking = message.content
    .map((b) => (b.type === "thinking" ? b.thinking : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return Response.json({ recipe: toolUse.input, thinking: thinking || undefined });
}
