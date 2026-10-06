import { handlePublicMenu } from "../_shared/public/menu.ts";
import { createDeps } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (request: Request) => Promise<Response>): void };

const { deps, storagePublicBase } = createDeps();
Deno.serve((request) => handlePublicMenu(request, deps, storagePublicBase));
