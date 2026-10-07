import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/semantik/index.ts", "src/bud/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Enable splitting so the two entry points share a single copy of the
  // error classes (and other shared modules) in the ESM output. Without
  // this, `instanceof NoetiveError` is `false` for errors raised inside
  // the `@noetive/sdk/semantik` bundle but caught by code that imported
  // the class from `@noetive/sdk`. tsup ignores splitting for CJS, so
  // CJS callers should pick one entry point and stick with it.
  splitting: true,
  treeshake: true,
  target: "es2022",
  platform: "neutral",
  outDir: "dist",
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
