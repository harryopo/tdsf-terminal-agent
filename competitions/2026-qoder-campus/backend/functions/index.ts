import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from "./_qoder/backend.mjs";
import { application } from "./app.mjs";
import { createStore } from "./store.mjs";
import tasks from "./tasks.json" with { type: "json" };

const handle = application({ store: createStore(createDatabaseClient(), BackendError), tasks, BackendError });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
