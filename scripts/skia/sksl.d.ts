// esbuild's text loader for the parity page (scripts/skia/parity-page.ts).
declare module "*.sksl" {
  const text: string;
  export default text;
}
