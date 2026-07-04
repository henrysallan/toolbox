// Edit-with-AI chat transcripts, kept in a local cache (localStorage + an
// in-memory mirror) keyed by group id. Each successful edit appends one turn;
// the recent turns are re-sent to the model as history so follow-ups ("a bit
// less") have intent continuity. Text-only, so localStorage is safe; survives
// reloads but never leaves the browser (no server persistence).

export interface RecipeChatTurn {
  instruction: string;
  summary: string;
}

const keyFor = (groupId: string) => `toolbox.recipe-chat.${groupId}`;
const mem = new Map<string, RecipeChatTurn[]>();

export function getTranscript(groupId: string): RecipeChatTurn[] {
  const cached = mem.get(groupId);
  if (cached) return cached;
  let turns: RecipeChatTurn[] = [];
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(keyFor(groupId)) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) turns = parsed;
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  mem.set(groupId, turns);
  return turns;
}

export function appendTurn(groupId: string, turn: RecipeChatTurn): RecipeChatTurn[] {
  const next = [...getTranscript(groupId), turn];
  mem.set(groupId, next);
  try {
    localStorage?.setItem(keyFor(groupId), JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearTranscript(groupId: string): void {
  mem.set(groupId, []);
  try {
    localStorage?.removeItem(keyFor(groupId));
  } catch {
    // ignore
  }
}
