import { handleJobApplication } from "../_shared/public/application.ts";
import { createDeps } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps } = createDeps();
Deno.serve((request) => handleJobApplication(request, deps));
