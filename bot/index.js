// For hosts that can only start `node index.js` (e.g. bot-hosting.net): reads the settings
// from .env next to this file (when there is one), then starts the bot (index.mjs).
// The file wins over the host's own variables: such hosts set TZ=UTC themselves, and the
// greeting hours must follow TZ from .env (assigning process.env.TZ also applies it now).
import fs from "node:fs";
import { parseEnv } from "node:util";

const file = new URL(".env", import.meta.url);
if (fs.existsSync(file)) Object.assign(process.env, parseEnv(fs.readFileSync(file, "utf8")));
await import("./index.mjs");
