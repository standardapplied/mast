// Electrobun's `electrobun/bun` entry re-exports `three` (and babylon) for its
// WebGPU helpers. Mast never uses them; this shim satisfies the type program
// without pulling the full @types/three surface.
declare module "three";
