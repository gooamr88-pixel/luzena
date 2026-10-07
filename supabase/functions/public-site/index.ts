import { handlePublicSite } from "../_shared/public/site.ts";
import { createDeps } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps, storagePublicBase } = createDeps();
Deno.serve((request) => handlePublicSite(request, deps, storagePublicBase));
