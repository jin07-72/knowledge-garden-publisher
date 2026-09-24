import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { defineConfig } from "electron-vite"

const runtimeExternals = [
  "electron",
  /^electron\/.+/,
  ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
]

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        external: runtimeExternals,
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        external: runtimeExternals,
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
})
