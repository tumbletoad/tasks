// The generated client and routes (A3 3.2.2): every UI entry is POST /api/v1/op/<name>, and every
// error envelope becomes a AppError.
import { describe, expect, test } from "vitest";
import { createClient, type ClientTransport } from "../generated/client.ts";
import { httpRoutes } from "../generated/http-routes.ts";
import { taskUpdate } from "./entries/task-update.ts";
import { AppError } from "./errors.ts";
import { routePath } from "./http.ts";
import { registry } from "./registry.ts";

function fake(status: number, body: string) {
  const calls: { path: string; body: string }[] = [];
  const transport: ClientTransport = {
    post: (path, sent) => {
      calls.push({ path, body: sent });
      return Promise.resolve({ status, body });
    },
  };
  return { calls, api: createClient(transport) };
}

describe("[A3.3.2.2.client] the generated client and HTTP routes", () => {
  test("http-routes.ts lists exactly the entries with a UI face", () => {
    const ui = registry
      .filter((e) => e.faces.ui === true)
      .map((e) => e.name)
      .sort();
    expect(httpRoutes.map((r) => r.entry)).toEqual(ui);
    for (const route of httpRoutes) {
      expect(route.method).toBe("POST");
      expect(route.path).toBe(routePath(route.entry));
    }
  });

  test("a method posts its input to its route and returns the result", async () => {
    const [example] = taskUpdate.examples;
    if (example === undefined) throw new Error("task.update has an example");
    const { calls, api } = fake(200, JSON.stringify({ result: example.output }));
    await expect(api.task.update(example.input)).resolves.toEqual(example.output);
    expect(calls).toEqual([
      { path: "/api/v1/op/task.update", body: JSON.stringify(example.input) },
    ]);
  });

  test("an error envelope throws AppError with its code, hint and data", async () => {
    const error = {
      code: "conflict",
      message: "summary changed after your read.",
      hint: "Read the task again and decide.",
      data: { fields: ["summary"] },
    };
    const { api } = fake(409, JSON.stringify({ error }));
    const thrown = await api.task.get({ task: "M-14" }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).toBody()).toEqual(error);
  });

  test("an unknown code or a body that is no envelope becomes internal", async () => {
    const unknown = fake(500, JSON.stringify({ error: { code: "teapot", message: "No." } }));
    const first = (await unknown.api.space.status({}).catch((e: unknown) => e)) as AppError;
    expect(first.code).toBe("internal");
    expect(first.data).toEqual({ cause: "teapot" });
    const garbage = fake(502, "<html>bad gateway</html>");
    const second = (await garbage.api.space.status({}).catch((e: unknown) => e)) as AppError;
    expect(second.code).toBe("internal");
    expect(second.data).toEqual({ status: 502 });
  });
});
