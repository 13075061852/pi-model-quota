import test from "node:test";
import assert from "node:assert/strict";
import { decodeCodexAccount, probeAccountQuota } from "../probes.ts";
import { formatCompact, formatDetails, mergeObservations, type QuotaObservation } from "../quota-core.ts";
import extension from "../index.ts";

const jwt = (data: unknown) => `test.${Buffer.from(JSON.stringify(data)).toString("base64url")}.test`;
const token = (email = "demo@example.com", plan = "plus") => jwt({
 "https://api.openai.com/profile": { email },
 "https://api.openai.com/auth": { chatgpt_account_id: email, chatgpt_plan_type: plan },
});
const usage = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 20 } } };
function harness() {
 let access = token();
 const statuses: Array<string | undefined> = [];
 const notices: string[] = [];
 const events: Record<string, Function> = {};
 let command: Function;
 const ctx: any = {
  hasUI: true,
  model: { provider: "openai-codex", id: "test", baseUrl: "https://chatgpt.com/backend-api" },
  modelRegistry: {
   isUsingOAuth: () => true, hasConfiguredAuth: () => true,
   getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
   getProviderAuth: async () => ({ auth: { apiKey: access } }),
  },
  ui: { theme: { fg: (_: string, value: string) => value },
   setStatus: (_: string, value: string) => statuses.push(value), notify: (s: string) => notices.push(s) },
 };
 extension({ on: (name: string, fn: Function) => { events[name] = fn; }, registerCommand: (_: string, def: any) => { command = def.handler; } } as any);
 return { ctx, statuses, notices, events, changeToken: (value: string) => { access = value; }, run: (arg: string) => command!(arg, ctx) };
}

test("decodes namespaced and top-level emails without exposing tokens", () => {
 assert.deepEqual(decodeCodexAccount(token()), { accountId: "demo@example.com", email: "demo@example.com", plan: "plus" });
 assert.equal(decodeCodexAccount(jwt({ email: "fallback@example.com" })).email, "fallback@example.com");
 for (const value of ["", "opaque", "a.bad.c", jwt(null), jwt([])]) {
  assert.ok(Object.values(decodeCodexAccount(value)).every(field => field === undefined));
 }
 for (const email of ["bad", "x\n@example.com", "x\x1b[31m@example.com", "x\u202e@example.com", "a".repeat(255) + "@example.com"]) {
  assert.equal(decodeCodexAccount(token(email)).email, undefined);
 }
 assert.equal(decodeCodexAccount(token("demo@example.com", "plus\x1b[31m")).plan, undefined);
});

test("formats identity, tolerates missing fields and preserves it with newer headers", () => {
 const account: QuotaObservation = { provider: "openai-codex", modelId: "test", authMode: "subscription", source: "account_api", checkedAt: 1,
  email: "demo@example.com", plan: "plus", windows: [{ id: "short", label: "5h", unit: "percent", usedPercent: 20 }] };
 const headers: QuotaObservation = { ...account, email: undefined, plan: undefined, source: "response_headers", checkedAt: 2 };
 const merged = mergeObservations(account, headers)!;
 assert.equal(formatCompact(merged), "额度[订阅] demo@example.com PLUS · 5h 80%");
 assert.match(formatDetails(merged), /账户：demo@example.com PLUS/);
 assert.equal(formatCompact({ ...account, email: undefined }), "额度[订阅] PLUS · 5h 80%");
 assert.equal(formatCompact({ ...account, plan: undefined }), "额度[订阅] demo@example.com · 5h 80%");
 assert.equal(formatCompact({ ...account, authMode: "api_key" }), "额度[Key] 5h 80%");
 assert.equal(formatCompact({ ...account, provider: "anthropic" }), "额度[订阅] 5h 80%");
});

test("probe prefers API plan, falls back to token plan and only calls usage endpoint", async (t) => {
 const h = harness(); let payload: unknown = usage;
 t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
  assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(options.method, "GET");
  return Response.json(payload);
 });
 let result = await probeAccountQuota(h.ctx, "openai-codex", "test", "subscription");
 assert.equal(result.observation?.email, "demo@example.com");
 assert.equal(result.observation?.plan, "pro");
 assert.ok(!JSON.stringify(result).includes("apiKey"));
 payload = { rate_limit: usage.rate_limit };
 result = await probeAccountQuota(h.ctx, "openai-codex", "test", "subscription");
 assert.equal(result.observation?.plan, "plus");
});

test("footer and details show current account; changed credentials clear stale quota even on failure", async (t) => {
 const h = harness(); let offline = false;
 t.mock.method(globalThis, "fetch", async () => {
  if (offline) throw new Error("offline");
  return Response.json(usage);
 });
 await h.run("refresh");
 assert.match(h.statuses.at(-1)!, /demo@example.com PRO · 5h 80%/);
 assert.match(h.notices.at(-1)!, /账户：demo@example.com PRO/);
 h.events.after_provider_response({ status: 200, headers: { "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "300" } }, h.ctx);
 assert.match(h.statuses.at(-1)!, /demo@example.com PRO · 5h 70%/);
 offline = true;
 await h.run("refresh"); // Same credential: transient errors keep the last valid data.
 assert.match(h.statuses.at(-1)!, /demo@example.com PRO/);
 h.changeToken(token("other@example.com"));
 await h.run("refresh");
 assert.doesNotMatch(h.statuses.at(-1)!, /demo@example.com|80%|70%/);
 offline = false;
 await h.run("refresh");
 assert.match(h.statuses.at(-1)!, /other@example.com PRO/);
 h.ctx.model = { provider: "other", id: "test" };
 h.ctx.modelRegistry.isUsingOAuth = () => false;
 h.events.model_select({}, h.ctx);
 assert.doesNotMatch(h.statuses.at(-1)!, /example.com|PRO/);
 h.events.session_shutdown({}, h.ctx);
 assert.equal(h.statuses.at(-1), undefined);
});

test("in-flight account change cannot publish the previous identity", async (t) => {
 const h = harness();
 t.mock.method(globalThis, "fetch", async () => {
  h.changeToken(token("new@example.com"));
  return Response.json(usage);
 });
 await h.run("refresh");
 assert.doesNotMatch(h.statuses.at(-1)!, /demo@example.com|80%/);
 assert.match(h.notices.at(-1)!, /认证已变化/);
});
