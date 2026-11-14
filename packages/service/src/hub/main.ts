// `tasks serve`: the script entry of the service. It takes no arguments (A2 3.3). The CLI (M1.10)
// routes its `serve` verb to runServe() from `@tasks/service/hub`, and the build (M1.13) bundles
// that route; until then `node packages/service/src/hub/main.ts` is the service.
import { runServe } from "./serve.ts";

process.exit(await runServe());
