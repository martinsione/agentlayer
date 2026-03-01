import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    agent: "src/agent.ts",
    session: "src/session.ts",
    loop: "src/loop.ts",
    types: "src/types.ts",
    "define-tool": "src/define-tool.ts",
    "runtime/node": "src/runtime/node.ts",
    "runtime/sandbox": "src/runtime/vercel-sandbox.ts",
    "runtime/just-bash": "src/runtime/just-bash.ts",
    "store/memory": "src/store/memory.ts",
    "store/jsonl": "src/store/jsonl.ts",
    "tools/bash": "src/tools/bash.ts",
    "tools/web-fetch": "src/tools/web-fetch.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
});
