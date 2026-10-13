import { createDeps } from "../_shared/runtime.ts";
import { handleScheduled } from "../_shared/scheduled/tasks.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps } = createDeps();
Deno.serve((request) => handleScheduled(request, deps));
