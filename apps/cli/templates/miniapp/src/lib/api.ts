import { hc } from "hono/client";
import type { AppType } from "../worker";

// Type-safe API client powered by Hono RPC
type ApiClient = ReturnType<typeof hc<AppType>>;
export const api: ApiClient = hc<AppType>("/");
