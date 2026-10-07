import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/semantik/index.ts", "src/bud/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Enable splitting so the entry points share a single copy of the error
  // classes (and other shared modules) within each format. Without this,
  // `instanceof NoetiveError` is `false` for errors raised inside the
  // `@noetive/sdk/semantik` bundle but caught by code that imported the
  // class from `@noetive/sdk`. The ESM and CJS builds still each carry
  // their own copy, so an app that loads both formats sees two classes.
  splitting: true,
  treeshake: true,
  target: "es2022",
  platform: "neutral",
  outDir: "dist",
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
