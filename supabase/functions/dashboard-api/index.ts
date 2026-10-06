import { handleDashboard } from "../_shared/dashboard/router.ts";
import { createDeps } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps } = createDeps();
Deno.serve((request) => handleDashboard(request, deps));
