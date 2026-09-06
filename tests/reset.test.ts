import test from "node:test";
import assert from "node:assert/strict";
import extension from "../index.ts";
import { prepareCodexReset } from "../probes.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.test`;
function harness() {
 const events: Record<string, Function> = {};
 let command: Function;
 const statuses: string[] = [], notices: string[] = [];
 const ctx: any = {
  hasUI: true, isIdle: () => true,
  model: { provider: "openai-codex", id: "test", baseUrl: "https://chatgpt.com/backend-api" },
  modelRegistry: {
   isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
   getProviderAuth: async () => ({ auth: { apiKey: token } }),
  },
  ui: { theme: { fg: (_: string, s: string) => s }, confirm: async () => true,
   notify: (s: string) => notices.push(s), setStatus: (_: string, s: string) => statuses.push(s) },
 };
 extension({ on: (name: string, fn: Function) => { events[name] = fn; }, registerCommand: (_: string, def: any) => { command = def.handler; } } as any);
 return { ctx, statuses, notices, events, run: (arg: string) => command!(arg, ctx) };
}
const usage = (used: number) => ({ rate_limit: { primary_window: { used_percent: used }, secondary_window: { used_percent: used } }, rate_limit_reset_credits: { available_count: used ? 2 : 1 } });

test("reset success uses one mocked POST, fresh quota and display-only transition", async (t) => {
 const h = harness(); let posts = 0;
 t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
  if (options.method === "POST") {
   posts++;
   assert.equal(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
   assert.equal(options.redirect, "error");
   assert.ok(JSON.parse(options.body).redeem_request_id);
   return Response.json({ code: "reset", windows_reset: 2 });
  }
  return Response.json(usage(posts ? 0 : 90));
 });
 await h.run("refresh");
 await h.run("reset");
 assert.equal(posts, 1);
 assert.ok(h.statuses.some(s => /5h (?:[2-9]\d)%/.test(s)));
 assert.match(h.statuses.at(-1)!, /5h 100%.*7d 100%.*重置卡 1次/);
});

test("cancel, non-UI and concurrent confirmations never consume", async (t) => {
 t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
 const h = harness(); let resolve: (b: boolean) => void;
 h.ctx.ui.confirm = () => new Promise<boolean>(r => { resolve = r; });
 const pending = h.run("reset");
 await new Promise(r => setImmediate(r));
 await h.run("reset");
 assert.match(h.notices.at(-1)!, /正在进行/);
 resolve!(false); await pending;
 h.ctx.hasUI = false; await h.run("reset");
});

test("uncertain response blocks repeated consume and never fabricates 100%", async (t) => {
 let posts = 0;
 t.mock.method(globalThis, "fetch", async () => { posts++; return Response.json({ code: "unknown" }); });
 const h = harness();
 await h.run("reset"); await h.run("reset");
 assert.equal(posts, 1);
 assert.ok(h.notices.some(s => s.includes("不确定")));
 assert.ok(!h.statuses.some(s => s?.includes("100%")));
});

test("strict origin and changed credentials block POST", async (t) => {
 t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
 for (const baseUrl of [undefined, "bad", "https://proxy.example"]) {
  const h = harness(); h.ctx.model.baseUrl = baseUrl;
  await assert.rejects(prepareCodexReset(h.ctx, "subscription"));
 }
 const h = harness();
 const consume = await prepareCodexReset(h.ctx, "subscription");
 h.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: "other" } });
 await assert.rejects(consume(new AbortController().signal, () => assert.fail("must not dispatch")));
});

test("successful consume with failed refresh warns without inventing quota", async (t) => {
 const h = harness();
 t.mock.method(globalThis, "fetch", async (_: string, options: any) => {
  if (options.method === "POST") return Response.json({ code: "reset", windows_reset: 2 });
  throw new Error("mock offline");
 });
 await h.run("reset");
 assert.ok(h.notices.some(s => s.includes("重置已成功，但额度刷新失败")));
 assert.ok(!h.statuses.some(s => s?.includes("100%")));
});

test("shutdown during animation stops all subsequent status updates", async (t) => {
 const h = harness(); let posts = 0;
 t.mock.method(globalThis, "fetch", async (_: string, options: any) => {
  if (options.method === "POST") { posts++; return Response.json({ code: "reset", windows_reset: 2 }); }
  return Response.json(usage(posts ? 0 : 90));
 });
 await h.run("refresh");
 const original = h.ctx.ui.setStatus;
 let stopped = false;
 h.ctx.ui.setStatus = (id: string, value: string) => {
  original(id, value);
  if (posts && !stopped && value?.includes("10%")) {
   stopped = true;
   h.events.session_shutdown({}, h.ctx);
  }
 };
 await h.run("reset");
 assert.equal(stopped, true);
 assert.equal(h.statuses.at(-1), undefined);
});

test("model switch during confirmation cancels consumption", async (t) => {
 t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
 const h = harness();
 h.ctx.ui.confirm = async () => {
  h.ctx.model = { provider: "other", id: "test" };
  h.events.model_select({}, h.ctx);
  return true;
 };
 await h.run("reset");
 h.events.session_shutdown({}, h.ctx);
});
