// Minimal ambient types for gifsicle-wasm-browser (ships no .d.ts).
// Only the `run` surface we use is declared. See:
// https://github.com/renzhezhilu/gifsicle-wasm-browser
declare module "gifsicle-wasm-browser" {
  export interface GifsicleInput {
    // A web URL, File, Blob, or ArrayBuffer of the source GIF.
    file: Blob | ArrayBuffer | string;
    // Name referenced inside the `command` strings (e.g. "in.gif").
    name: string;
  }

  export interface GifsicleRunOptions {
    input: GifsicleInput[];
    // Each entry is a full gifsicle command line; the last must write to
    // `/out/<name>.gif`. Commands run sequentially.
    command: string[];
  }

  // `run` resolves to the File objects written under /out.
  const gifsicle: {
    run(options: GifsicleRunOptions): Promise<File[]>;
  };
  export default gifsicle;
}
