// POST /api/edit-recipe — thin Claude proxy for Edit-with-AI (spec
// 062926_edit-group-with-ai.md). Takes the client-built catalog + the current
// group spec + an instruction, asks Claude for a patch (edit_recipe), and
// returns it. Like the generate route, it does NOT import the engine: build,
// apply, and validation all happen client-side.

import Anthropic from "@anthropic-ai/sdk";
import {
  EDIT_RECIPE_TOOL,
  buildEditSystem,
  buildEditUserContent,
} from "@/lib/ai/recipe-prompt";
import { resolveAnthropicKey } from "@/lib/ai/anthropic-key";

export const runtime = "nodejs";

interface Body {
  catalog?: string;
  groupSpec?: unknown;
  instruction?: string;
  history?: { instruction: string; summary: string }[];
  repair?: { edit: unknown; errors: string[] };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { catalog, groupSpec, instruction, history, repair } = body;
  if (!catalog || typeof catalog !== "string")
    return Response.json({ error: "Missing `catalog`." }, { status: 400 });
  if (!groupSpec || typeof groupSpec !== "object")
    return Response.json({ error: "Missing `groupSpec`." }, { status: 400 });
  if (!instruction || typeof instruction !== "string")
    return Response.json({ error: "Missing `instruction`." }, { status: 400 });

  const apiKey = await resolveAnthropicKey();
  if (!apiKey)
    return Response.json(
      {
        error:
          "No Anthropic API key. Add one in User Preferences (sign in first), or set ANTHROPIC_API_KEY on the server.",
      },
      { status: 500 }
    );

  const client = new Anthropic({ apiKey });
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 12000,
      // See the generate route: adaptive thinking requires `tool_choice: auto`.
      thinking: { type: "adaptive", display: "summarized" },
      system: buildEditSystem(catalog),
      tools: [EDIT_RECIPE_TOOL],
      tool_choice: { type: "auto" },
      messages: [
        {
          role: "user",
          content: buildEditUserContent(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            groupSpec as any,
            instruction,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { history, repair: repair as any }
          ),
        },
      ],
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
    return Response.json({ error: "Model did not emit an edit." }, { status: 502 });

  const thinking = message.content
    .map((b) => (b.type === "thinking" ? b.thinking : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return Response.json({ edit: toolUse.input, thinking: thinking || undefined });
}
