import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .split("?", 1)[0]
          ?.replaceAll("\\", "/")
          .endsWith("/katex/dist/katex.min.css")
      ) {
        return null
      }
      return source.replace(
        /,url\(([^)]*\.woff)\) format\("woff"\),url\(([^)]*\.ttf)\) format\("truetype"\)/g,
        ""
      )
    },
  }
}

function developmentRendererWebSocket(): Plugin {
  let development = false
  return {
    name: "development-renderer-websocket",
    configResolved(config) {
      development = config.command === "serve"
    },
    transformIndexHtml(html) {
      return development
        ? html.replace(
            "connect-src 'self'",
            "connect-src 'self' ws://127.0.0.1:*"
          )
        : html
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [
    katexWoff2Only(),
    developmentRendererWebSocket(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    license: { fileName: "licenses/third-party.json" },
    modulePreload: { polyfill: false },
    target: "chrome150",
    minify: "oxc",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        recovery: path.resolve(__dirname, "recovery.html"),
      },
    },
  },
})
