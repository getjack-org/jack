import { hc } from "hono/client";
import type { AppType } from "../worker";

// Type-safe API client powered by Hono RPC
export const api = hc<AppType>("/");
