import { processQueue } from "@/adapters/queue";
import type { WorkerEnv } from "@/alchemy.run";
import { healthResponse, authorized } from "@/application/admin";
import { adminResponse, poll } from "@/composition";

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return healthResponse(env);
    }
    if (!url.pathname.startsWith("/admin/")) {
      return new Response("Not Found", { status: 404 });
    }
    if (!(await authorized(request, env.ADMIN_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }
    return adminResponse(request.method, url.pathname, env);
  },

  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    await processQueue(batch, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv
  ): Promise<void> {
    const result = await poll(env);
    if (!result.ok) {
      console.error(
        JSON.stringify({ error: result.error, event: "cron.failed" })
      );
    }
  },
};

export default worker;
