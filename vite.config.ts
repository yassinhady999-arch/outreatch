// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// A fixed Workers compatibility date (a nitro option the Lovable config's type doesn't list):
// left out, it is the build machine's local date, which Cloudflare (on UTC) rejects as "in the
// future" after midnight in Egypt.
const nitro = { preset: "cloudflare-pages", compatibilityDate: "2026-11-20" };

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Hosted on Cloudflare Pages (https://mersal-887.pages.dev); `npm run deploy` builds and uploads.
  // Inside Lovable's own build this is overridden with its Cloudflare target.
  nitro,
});
