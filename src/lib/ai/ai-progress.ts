// Live progress events emitted by the generate/edit orchestrators so the UI can
// show the validation loop's back-and-forth and Claude's summarized thinking.
export type AiProgress =
  | { kind: "request"; attempt: number } // asking the model
  | { kind: "thinking"; attempt: number; text: string } // summarized reasoning
  | { kind: "invalid"; attempt: number; errors: string[] } // will repair
  | { kind: "applied"; attempt: number; summary?: string }; // success
