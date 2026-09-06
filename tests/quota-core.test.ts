import assert from "node:assert/strict";
import test from "node:test";
import {
	formatCompact,
	formatDetails,
	lowestRemainingPercent,
	mergeObservations,
	nextResetAt,
	parseAccountPayload,
	parseQuotaHeaders,
	type QuotaObservation,
} from "../quota-core.ts";

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

test("parses Codex subscription windows and credits", () => {
	const parsed = parseAccountPayload("openai-codex", {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 25,
				limit_window_seconds: 18_000,
				reset_after_seconds: 600,
			},
			secondary_window: {
				used_percent: 60,
				limit_window_seconds: 604_800,
				reset_at: NOW / 1000 + 3600,
			},
		},
		credits: { has_credits: true, balance: "12.50" },
	}, NOW);

	assert.equal(parsed.plan, "plus");
	assert.deepEqual(parsed.windows.slice(0, 2).map((window) => [window.label, window.usedPercent]), [
		["5h", 25],
		["7d", 60],
	]);
	assert.equal(parsed.windows[0]?.resetAt, NOW / 1000 + 600);
	assert.equal(parsed.windows[2]?.remaining, 12.5);
});

test("shows separate five-hour and weekly reset dates for subscription quota", () => {
	const earliest = NOW / 1000 + 600;
	const observation: QuotaObservation = {
		provider: "openai-codex",
		modelId: "gpt-test",
		authMode: "subscription",
		source: "account_api",
		checkedAt: NOW,
		windows: [
			{ id: "short", label: "5h", unit: "percent", usedPercent: 20, resetAt: earliest },
			{ id: "long", label: "7d", unit: "percent", usedPercent: 40, resetAt: NOW / 1000 + 3600 },
		],
	};
	const date = new Date(earliest * 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	const expected = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	assert.equal(nextResetAt(observation, NOW), earliest);
	const weeklyDate = new Date((NOW / 1000 + 3600) * 1000);
	const weeklyExpected = `${pad(weeklyDate.getMonth() + 1)}-${pad(weeklyDate.getDate())} ${pad(weeklyDate.getHours())}:${pad(weeklyDate.getMinutes())}`;
	assert.equal(formatCompact(observation, NOW), `额度[订阅] 5h 80% ↻ ${expected} · 7d 60% ↻ ${weeklyExpected}`);

	// A missing or expired reset must not inherit another window's timestamp.
	observation.windows[0]!.resetAt = undefined;
	assert.equal(formatCompact(observation, NOW), `额度[订阅] 5h 80% · 7d 60% ↻ ${weeklyExpected}`);
	observation.windows[0]!.resetAt = NOW / 1000;
	assert.equal(formatCompact(observation, NOW), `额度[订阅] 5h 80% · 7d 60% ↻ ${weeklyExpected}`);
	observation.windows[1]!.resetAt = NOW / 1000 - 1;
	assert.equal(formatCompact(observation, NOW), "额度[订阅] 5h 80% · 7d 60%");

	// Non-subscription footer formatting remains unchanged.
	observation.windows[0]!.resetAt = earliest;
	observation.authMode = "api_key";
	assert.equal(formatCompact(observation, NOW), "额度[Key] 5h 80% · 7d 60%");
});

test("parses OpenAI-compatible request and token headers", () => {
	const windows = parseQuotaHeaders({
		"x-ratelimit-limit-requests": "500",
		"x-ratelimit-remaining-requests": "450",
		"x-ratelimit-reset-requests": "10s",
		"x-ratelimit-limit-tokens": "30000",
		"x-ratelimit-remaining-tokens": "12000",
		"x-ratelimit-reset-tokens": "1m30s",
	}, 200, NOW);

	assert.equal(windows.length, 2);
	assert.deepEqual(windows.map((window) => [window.label, window.remaining, window.limit]), [
		["请求", 450, 500],
		["Token", 12000, 30000],
	]);
	assert.equal(windows[0]?.resetAt, NOW / 1000 + 10);
	assert.equal(windows[1]?.resetAt, NOW / 1000 + 90);
});

test("parses Anthropic unified subscription headers", () => {
	const windows = parseQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "0.21",
		"anthropic-ratelimit-unified-5h-reset": new Date(NOW + 3600_000).toISOString(),
		"anthropic-ratelimit-unified-7d-utilization": "0.65",
	}, 200, NOW);
	assert.deepEqual(windows.map((window) => [window.label, window.usedPercent]), [["5h", 21], ["7d", 65]]);
});

test("parses all Codex header families", () => {
	const windows = parseQuotaHeaders({
		"x-codex-primary-used-percent": "10",
		"x-codex-primary-window-minutes": "300",
		"x-codex-secondary-used-percent": "55",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-spark-primary-used-percent": "80",
		"x-codex-spark-primary-window-minutes": "300",
		"x-codex-spark-limit-name": "Spark",
	}, 200, NOW);
	assert.deepEqual(windows.map((window) => window.label), ["5h", "7d", "Spark 5h"]);
});

test("parses OpenRouter key budget", () => {
	const parsed = parseAccountPayload("openrouter", {
		data: { limit: 100, limit_remaining: 74.5, limit_reset: "monthly", is_free_tier: false },
	}, NOW);
	assert.equal(parsed.windows[0]?.unit, "currency");
	assert.equal(parsed.windows[0]?.remaining, 74.5);
	assert.equal(parsed.windows[0]?.limit, 100);
});

test("parses DeepSeek account balance", () => {
	const parsed = parseAccountPayload("deepseek", {
		is_available: true,
		balance_infos: [
			{ currency: "CNY", total_balance: "18.31", granted_balance: "0.00", topped_up_balance: "18.31" },
		],
	}, NOW);
	assert.equal(parsed.windows.length, 1);
	assert.equal(parsed.windows[0]?.label, "余额(CNY)");
	assert.equal(parsed.windows[0]?.remaining, 18.31);
	assert.equal(parsed.windows[0]?.limited, false);
	assert.equal(parsed.note, "充值 18.31CNY");
});

test("omits redundant currency labels only in the compact balance display", () => {
	const observation: QuotaObservation = {
		provider: "deepseek",
		modelId: "deepseek-chat",
		authMode: "api_key",
		source: "account_api",
		checkedAt: NOW,
		...parseAccountPayload("deepseek", {
			is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "108.42" }],
		}, NOW),
	};
	assert.equal(formatCompact(observation, NOW), "额度[Key] ¥108.42");
	assert.match(formatDetails(observation, NOW), /余额\(CNY\)：剩余 ¥108\.42/);

	observation.windows.push({ id: "usd", label: "余额(USD)", unit: "currency", currency: "USD", remaining: 12.5 });
	assert.equal(formatCompact(observation, NOW), "额度[Key] ¥108.42 · $12.5");
	observation.windows = [{ id: "requests", label: "请求", unit: "requests", remaining: 10 }];
	assert.equal(formatCompact(observation, NOW), "额度[Key] 请求 10");
});

test("formats the lowest remaining quota in compact status", () => {
	const observation: QuotaObservation = {
		provider: "openai-codex",
		modelId: "gpt-test",
		authMode: "subscription",
		source: "account_api",
		checkedAt: NOW,
		windows: [
			{ id: "5h", label: "5h", unit: "percent", usedPercent: 20 },
			{ id: "7d", label: "7d", unit: "percent", usedPercent: 70 },
		],
	};
	assert.equal(formatCompact(observation), "额度[订阅] 5h 80% · 7d 30%");
	assert.equal(lowestRemainingPercent(observation), 30);
});

test("keeps the newest duplicate window when observations are merged", () => {
	const account: QuotaObservation = {
		provider: "openai-codex",
		modelId: "gpt-test",
		authMode: "subscription",
		source: "account_api",
		checkedAt: NOW,
		windows: [{ id: "5h", label: "5h", unit: "percent", usedPercent: 20 }],
	};
	const headers: QuotaObservation = {
		...account,
		source: "response_headers",
		checkedAt: NOW + 1000,
		windows: [
			{ id: "duplicate", label: "5h", unit: "percent", usedPercent: 99 },
			{ id: "requests", label: "请求", unit: "requests", remaining: 9, limit: 10 },
		],
	};
	const merged = mergeObservations(account, headers)!;
	assert.equal(merged.windows.length, 2);
	assert.equal(merged.windows[0]?.usedPercent, 99);
	assert.equal(merged.source, "response_headers");
	assert.equal(merged.checkedAt, NOW + 1000);
});

test("parses a Codex secondary-only header family", () => {
	const windows = parseQuotaHeaders({
		"x-codex-secondary-used-percent": "35",
		"x-codex-secondary-window-minutes": "10080",
	}, 200, NOW);
	assert.equal(windows.length, 1);
	assert.equal(windows[0]?.label, "7d");
	assert.equal(windows[0]?.usedPercent, 35);
});

test("shows Codex reset cards and preserves them when newer headers arrive", () => {
	const payload = {
		rate_limit: { primary_window: { used_percent: 20 } },
		rate_limit_reset_credits: { available_count: 2 },
	};
	const account: QuotaObservation = {
		provider: "openai-codex", modelId: "gpt-test", authMode: "subscription",
		source: "account_api", checkedAt: NOW,
		...parseAccountPayload("openai-codex", payload, NOW),
	};
	assert.equal(account.resetCredits, 2);
	assert.equal(formatCompact(account, NOW), "额度[订阅] 5h 80% · 重置卡 2次");
	const headers: QuotaObservation = {
		provider: account.provider, modelId: account.modelId, authMode: account.authMode,
		source: "response_headers", checkedAt: NOW + 1000,
		windows: [{ id: "5h", label: "5h", unit: "percent", usedPercent: 30 }],
	};
	assert.equal(formatCompact(mergeObservations(account, headers)!, NOW), "额度[订阅] 5h 70% · 重置卡 2次");
	payload.rate_limit_reset_credits.available_count = 0;
	const empty = { ...account, ...parseAccountPayload("openai-codex", payload, NOW) };
	assert.equal(formatCompact(mergeObservations(empty, headers)!, NOW), "额度[订阅] 5h 70% · 重置卡 0次");
	for (const count of [undefined, null, -1, 1.5, "invalid"]) {
		const parsed = parseAccountPayload("openai-codex", {
			...payload, rate_limit_reset_credits: { available_count: count },
		}, NOW);
		assert.equal(parsed.resetCredits, undefined);
		assert.equal(formatCompact({ ...account, ...parsed }, NOW), "额度[订阅] 5h 80%");
	}
});

test("turns bare HTTP 429 into a limited window", () => {
	const windows = parseQuotaHeaders({ "retry-after": "30" }, 429, NOW);
	assert.equal(windows[0]?.limited, true);
	assert.equal(windows[0]?.remaining, 0);
	assert.equal(windows[0]?.resetAt, NOW / 1000 + 30);
});
