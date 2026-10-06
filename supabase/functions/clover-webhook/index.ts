import { handleCloverWebhook } from "../_shared/public/webhook.ts";
import { createDeps } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps } = createDeps();
Deno.serve((request) => handleCloverWebhook(request, deps));
