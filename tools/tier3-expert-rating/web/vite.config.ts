import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The survey's browser app. In development, the API runs separately behind the proxy. */
export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The design system is shared with the results site.
      "@": resolve(import.meta.dirname, "../../../site/src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/r": "http://127.0.0.1:4180",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    license: { fileName: "third-party-licenses.txt" },
    rolldownOptions: {
      output: {
        // Libraries change less often than the app, so a browser keeps them cached across
        // deployments: React, and the Markdown stack every page renders with.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/]react(-dom)?[\\/]/ },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast|unist-|unified|vfile|parse5|property-information|decode-named-character-reference|character-entities)/,
            },
          ],
        },
      },
    },
  },
});
