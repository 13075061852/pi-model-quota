export type AuthMode = "subscription" | "oauth" | "api_key" | "unknown";
export type QuotaSource = "account_api" | "response_headers";
export type QuotaUnit = "percent" | "requests" | "tokens" | "currency" | "credits";

export interface QuotaWindow {
	id: string;
	label: string;
	unit: QuotaUnit;
	currency?: string;
	remaining?: number;
	limit?: number;
	usedPercent?: number;
	resetAt?: number;
	limited?: boolean;
}

export interface QuotaObservation {
	provider: string;
	modelId: string;
	authMode: AuthMode;
	source: QuotaSource;
	checkedAt: number;
	windows: QuotaWindow[];
	plan?: string;
	/** Display-only metadata; never persisted by this extension. */
	email?: string;
	note?: string;
	resetCredits?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function accountEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const email = value.trim();
	return email.length <= 254 && /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(email)
		? email : undefined;
}

export function accountPlan(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const plan = value.trim();
	return /^[a-zA-Z][a-zA-Z0-9 _-]{0,39}$/.test(plan) ? plan : undefined;
}

export function formatAccountLabel(observation: QuotaObservation): string {
	if (observation.provider !== "openai-codex" || !["subscription", "oauth"].includes(observation.authMode)) return "";
	return [accountEmail(observation.email), accountPlan(observation.plan)?.toUpperCase()].filter(Boolean).join(" ");
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function finite(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function epochSeconds(value: unknown, now = Date.now()): number | undefined {
	if (typeof value === "string" && value.trim()) {
		const numeric = finite(value);
		if (numeric !== undefined) return epochSeconds(numeric, now);
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
	}
	const numeric = finite(value);
	if (numeric === undefined || numeric <= 0) return undefined;
	if (numeric > 10 ** 12) return Math.round(numeric / 1000);
	if (numeric > 10 ** 9) return Math.round(numeric);
	return Math.round(now / 1000 + numeric);
}

function durationSeconds(value: unknown): number | undefined {
	if (typeof value !== "string") return finite(value);
	const input = value.trim().toLowerCase();
	if (!input) return undefined;
	const direct = finite(input);
	if (direct !== undefined) return direct;

	let total = 0;
	let matched = "";
	const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
	for (const match of input.matchAll(pattern)) {
		const amount = Number(match[1]);
		const unit = match[2];
		matched += match[0].replace(/\s+/g, "");
		total += amount * (unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400);
	}
	return matched === input.replace(/\s+/g, "") && total >= 0 ? total : undefined;
}

function resetFromHeader(value: string | undefined, now: number): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const duration = durationSeconds(trimmed);
	if (duration !== undefined && !/^\d{10,}$/.test(trimmed)) {
		return Math.round(now / 1000 + duration);
	}
	return epochSeconds(trimmed, now);
}

export function windowLabel(seconds: number | undefined, fallback: string): string {
	if (!seconds || seconds <= 0) return fallback;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${Math.round(seconds)}s`;
}

function usedPercent(remaining: number | undefined, limit: number | undefined): number | undefined {
	if (remaining === undefined || limit === undefined || limit <= 0) return undefined;
	return clamp(100 - (remaining / limit) * 100, 0, 100);
}

function remainingPercent(window: QuotaWindow): number | undefined {
	if (window.usedPercent !== undefined) return clamp(100 - window.usedPercent, 0, 100);
	if (window.remaining !== undefined && window.limit !== undefined && window.limit > 0) {
		return clamp((window.remaining / window.limit) * 100, 0, 100);
	}
	return undefined;
}

function makePercentWindow(
	id: string,
	label: string,
	used: unknown,
	resetAt: unknown,
	now: number,
): QuotaWindow | undefined {
	const percentage = finite(used);
	if (percentage === undefined) return undefined;
	return {
		id,
		label,
		unit: "percent",
		usedPercent: clamp(percentage, 0, 100),
		resetAt: epochSeconds(resetAt, now),
		limited: percentage >= 100,
	};
}

function parseCodexPayload(data: unknown, now: number): Pick<QuotaObservation, "windows" | "plan" | "note" | "resetCredits"> {
	const root = record(data) ?? {};
	const rateLimit = record(root.rate_limit) ?? record(root.rate_limits) ?? {};
	const windows: QuotaWindow[] = [];

	const addCodexLimit = (value: unknown, idPrefix: string, labelPrefix = "") => {
		const limit = record(value);
		if (!limit) return;
		const candidates: Array<[string, unknown, number]> = [
			["primary", limit.primary_window ?? limit.primary ?? limit.five_hour_limit ?? limit.five_hour, 5 * 3600],
			["secondary", limit.secondary_window ?? limit.secondary ?? limit.weekly_limit ?? limit.weekly, 7 * 86400],
		];
		for (const [slot, rawWindow, fallbackSeconds] of candidates) {
			const source = record(rawWindow);
			if (!source) continue;
			const used = finite(source.used_percent)
				?? (finite(source.percent_left) !== undefined ? 100 - finite(source.percent_left)! : undefined)
				?? (finite(source.remaining_percent) !== undefined ? 100 - finite(source.remaining_percent)! : undefined);
			if (used === undefined) continue;
			const seconds = finite(source.limit_window_seconds) ?? fallbackSeconds;
			const reset = epochSeconds(source.reset_at ?? source.reset_time_ms, now)
				?? (finite(source.reset_after_seconds) !== undefined
					? Math.round(now / 1000 + finite(source.reset_after_seconds)!)
					: undefined);
			windows.push({
				id: `${idPrefix}-${slot}`,
				label: `${labelPrefix}${windowLabel(seconds, slot)}`,
				unit: "percent",
				usedPercent: clamp(used, 0, 100),
				resetAt: reset,
				limited: used >= 100 || Boolean(limit.limit_reached),
			});
		}
	};

	addCodexLimit(rateLimit, "codex");
	for (const rawAdditional of array(root.additional_rate_limits)) {
		const additional = record(rawAdditional);
		if (!additional) continue;
		const name = String(additional.limit_name ?? additional.metered_feature ?? "模型");
		addCodexLimit(additional.rate_limit ?? additional, `codex-${name}`, `${name} `);
	}

	const credits = record(root.credits);
	if (credits?.has_credits) {
		const balance = finite(credits.balance);
		if (balance !== undefined) {
			windows.push({ id: "codex-credits", label: "Credits", unit: "credits", remaining: balance });
		}
	}
	const spend = record(root.spend_control);
	const spendReached = spend?.reached === true;
	const plan = accountPlan(root.plan_type);
	const availableCount = finite(record(root.rate_limit_reset_credits)?.available_count);
	const resetCredits = availableCount !== undefined && Number.isInteger(availableCount) && availableCount >= 0
		? availableCount : undefined;
	const notes = [
		spendReached ? "消费上限已触发" : undefined,
		resetCredits !== undefined && resetCredits > 0 ? `${resetCredits} 次重置券` : undefined,
	].filter(Boolean);
	return { windows, plan, note: notes.length ? notes.join(" · ") : undefined, resetCredits };
}

function parseAnthropicPayload(data: unknown, now: number): { windows: QuotaWindow[]; note?: string } {
	const root = record(data) ?? {};
	const windows: QuotaWindow[] = [];
	const mappings: Array<[string, string]> = [
		["five_hour", "5h"],
		["seven_day", "7d"],
		["seven_day_sonnet", "7d Sonnet"],
		["seven_day_omelette", "7d Opus"],
		["seven_day_opus", "7d Opus"],
	];
	for (const [field, label] of mappings) {
		const entry = record(root[field]);
		if (!entry) continue;
		const window = makePercentWindow(`anthropic-${field}`, label, entry.utilization, entry.resets_at, now);
		if (window && !windows.some((existing) => existing.label === window.label)) windows.push(window);
	}

	const extra = record(root.extra_usage);
	if (extra?.is_enabled === true) {
		const limitCents = finite(extra.monthly_limit);
		const usedCents = finite(extra.used_credits);
		if (limitCents !== undefined && usedCents !== undefined && limitCents > 0) {
			const limit = limitCents / 100;
			const remaining = Math.max(0, (limitCents - usedCents) / 100);
			windows.push({
				id: "anthropic-extra",
				label: `Extra ${String(extra.currency ?? "USD")}`,
				unit: "currency",
				currency: String(extra.currency ?? "USD"),
				remaining,
				limit,
				usedPercent: usedPercent(remaining, limit),
			});
		}
	}
	return { windows };
}

function parseOpenRouterPayload(data: unknown): { windows: QuotaWindow[]; plan?: string } {
	const root = record(record(data)?.data) ?? {};
	const windows: QuotaWindow[] = [];
	const limit = finite(root.limit);
	const remaining = finite(root.limit_remaining);
	if (limit !== undefined && limit > 0) {
		const actualRemaining = remaining ?? Math.max(0, limit - (finite(root.usage) ?? 0));
		windows.push({
			id: "openrouter-budget",
			label: `预算/${String(root.limit_reset ?? "周期")}`,
			unit: "currency",
			currency: "USD",
			remaining: actualRemaining,
			limit,
			usedPercent: usedPercent(actualRemaining, limit),
			limited: actualRemaining <= 0,
		});
	} else if (remaining !== undefined) {
		windows.push({ id: "openrouter-credits", label: "余额", unit: "currency", currency: "USD", remaining });
	}
	return { windows, plan: root.is_free_tier === true ? "free" : undefined };
}

function parseKimiPayload(data: unknown, now: number): { windows: QuotaWindow[] } {
	const root = record(data) ?? {};
	const windows: QuotaWindow[] = [];
	const weekly = record(root.usage);
	if (weekly) {
		const limit = finite(weekly.limit);
		const used = finite(weekly.used);
		if (limit !== undefined && used !== undefined && limit > 0) {
			windows.push({
				id: "kimi-weekly",
				label: "7d",
				unit: "requests",
				remaining: Math.max(0, limit - used),
				limit,
				usedPercent: clamp((used / limit) * 100, 0, 100),
				resetAt: epochSeconds(weekly.resetTime, now),
				limited: used >= limit,
			});
		}
	}
	for (const rawLimit of array(root.limits)) {
		const item = record(rawLimit);
		const detail = record(item?.detail);
		const period = record(item?.window);
		if (!detail || !period) continue;
		const limit = finite(detail.limit);
		const used = finite(detail.used);
		const duration = finite(period.duration);
		if (limit === undefined || used === undefined || duration === undefined || limit <= 0 || duration <= 0) continue;
		const unit = String(period.timeUnit ?? "");
		const seconds = unit === "TIME_UNIT_SECOND" ? duration
			: unit === "TIME_UNIT_MINUTE" ? duration * 60
				: unit === "TIME_UNIT_HOUR" ? duration * 3600
					: unit === "TIME_UNIT_DAY" ? duration * 86400
						: undefined;
		if (!seconds) continue;
		windows.push({
			id: `kimi-${unit}-${duration}`,
			label: windowLabel(seconds, "滚动"),
			unit: "requests",
			remaining: Math.max(0, limit - used),
			limit,
			usedPercent: clamp((used / limit) * 100, 0, 100),
			resetAt: epochSeconds(detail.resetTime, now),
			limited: used >= limit,
		});
	}
	windows.sort((a, b) => (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER));
	return { windows };
}

function parseDeepseekPayload(data: unknown): { windows: QuotaWindow[]; note?: string } {
	const root = record(data) ?? {};
	const windows: QuotaWindow[] = [];
	const notes: string[] = [];
	for (const rawInfo of array(root.balance_infos)) {
		const info = record(rawInfo);
		if (!info) continue;
		const currency = String(info.currency ?? "CNY");
		const total = finite(info.total_balance);
		if (total === undefined) continue;
		const granted = finite(info.granted_balance);
		const toppedUp = finite(info.topped_up_balance);
		windows.push({
			id: `deepseek-${currency}`,
			label: `余额(${currency})`,
			unit: "currency",
			currency,
			remaining: total,
			limited: root.is_available === false,
		});
		if (granted !== undefined && granted > 0) notes.push(`赠送 ${granted.toFixed(2)}${currency}`);
		if (toppedUp !== undefined && toppedUp > 0) notes.push(`充值 ${toppedUp.toFixed(2)}${currency}`);
	}
	if (root.is_available === false && windows.length === 0) {
		windows.push({ id: "deepseek-unavailable", label: "账户", unit: "currency", remaining: 0, limited: true });
		notes.push("账户不可用，余额可能不足");
	}
	return { windows, note: notes.length ? notes.join(" · ") : undefined };
}

function parseZaiPayload(data: unknown, now: number): { windows: QuotaWindow[]; plan?: string } {
	const root = record(data) ?? {};
	const body = record(root.data) ?? root;
	const windows: QuotaWindow[] = [];
	for (const rawLimit of array(body.limits)) {
		const item = record(rawLimit);
		if (!item) continue;
		const type = String(item.type ?? "");
		const count = finite(item.number) ?? 1;
		let seconds: number | undefined;
		if (item.unit === 3) seconds = count * 3600;
		else if (item.unit === 4) seconds = count * 86400;
		else if (item.unit === 5) seconds = count * 30 * 86400;
		else if (item.unit === 6) seconds = count * 7 * 86400;
		if (type === "TOKENS_LIMIT") {
			const used = finite(item.percentage);
			if (used === undefined) continue;
			windows.push({
				id: `zai-token-${String(item.unit)}-${count}`,
				label: windowLabel(seconds, "Token"),
				unit: "percent",
				usedPercent: clamp(used, 0, 100),
				resetAt: epochSeconds(item.nextResetTime, now),
				limited: used >= 100,
			});
		} else if (type === "TIME_LIMIT") {
			const limit = finite(item.usage);
			const used = finite(item.currentValue);
			if (limit === undefined || used === undefined || limit <= 0) continue;
			windows.push({
				id: `zai-time-${String(item.unit)}-${count}`,
				label: windowLabel(seconds, "次数"),
				unit: "requests",
				remaining: Math.max(0, limit - used),
				limit,
				usedPercent: clamp((used / limit) * 100, 0, 100),
				resetAt: epochSeconds(item.nextResetTime, now),
				limited: used >= limit,
			});
		}
	}
	windows.sort((a, b) => (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER));
	return { windows, plan: typeof body.level === "string" ? body.level : undefined };
}

export function parseAccountPayload(provider: string, data: unknown, now = Date.now()): Pick<QuotaObservation, "windows" | "plan" | "note" | "resetCredits"> {
	if (provider === "openai-codex") return parseCodexPayload(data, now);
	if (provider === "anthropic") return parseAnthropicPayload(data, now);
	if (provider === "openrouter") return parseOpenRouterPayload(data);
	if (provider === "deepseek") return parseDeepseekPayload(data);
	if (provider === "kimi-coding") return parseKimiPayload(data, now);
	if (provider === "zai" || provider === "zai-coding-cn") return parseZaiPayload(data, now);
	return { windows: [] };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function parseCodexHeaders(headers: Record<string, string>, now: number): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	const families = new Set<string>();
	for (const key of Object.keys(headers)) {
		const match = key.match(/^x-(.+)-(?:primary|secondary)-used-percent$/);
		if (match) families.add(match[1]!);
	}
	for (const family of families) {
		const prefix = `x-${family}`;
		const name = headers[`${prefix}-limit-name`];
		for (const slot of ["primary", "secondary"] as const) {
			const used = finite(headers[`${prefix}-${slot}-used-percent`]);
			if (used === undefined) continue;
			const minutes = finite(headers[`${prefix}-${slot}-window-minutes`]);
			const resetAt = epochSeconds(headers[`${prefix}-${slot}-reset-at`], now)
				?? (finite(headers[`${prefix}-${slot}-reset-after-seconds`]) !== undefined
					? Math.round(now / 1000 + finite(headers[`${prefix}-${slot}-reset-after-seconds`]!)!)
					: undefined);
			const baseLabel = windowLabel(minutes !== undefined ? minutes * 60 : undefined, slot);
			windows.push({
				id: `${family}-${slot}`,
				label: family === "codex" ? baseLabel : `${name ?? family.replaceAll("-", " ")} ${baseLabel}`,
				unit: "percent",
				usedPercent: clamp(used, 0, 100),
				resetAt,
				limited: used >= 100,
			});
		}
	}
	return windows;
}

function parseAnthropicUnifiedHeaders(headers: Record<string, string>, now: number): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	for (const [id, label] of [["5h", "5h"], ["7d", "7d"]] as const) {
		const raw = finite(headers[`anthropic-ratelimit-unified-${id}-utilization`]);
		if (raw === undefined) continue;
		const used = raw <= 1 ? raw * 100 : raw;
		windows.push({
			id: `anthropic-unified-${id}`,
			label,
			unit: "percent",
			usedPercent: clamp(used, 0, 100),
			resetAt: resetFromHeader(headers[`anthropic-ratelimit-unified-${id}-reset`], now),
			limited: headers[`anthropic-ratelimit-unified-${id}-status`] === "rejected" || used >= 100,
		});
	}
	return windows;
}

function addLimitWindow(
	windows: QuotaWindow[],
	id: string,
	label: string,
	unit: QuotaUnit,
	limitRaw: string | undefined,
	remainingRaw: string | undefined,
	resetRaw: string | undefined,
	now: number,
): void {
	const limit = finite(limitRaw);
	const remaining = finite(remainingRaw);
	if (limit === undefined && remaining === undefined) return;
	windows.push({
		id,
		label,
		unit,
		limit,
		remaining,
		usedPercent: usedPercent(remaining, limit),
		resetAt: resetFromHeader(resetRaw, now),
		limited: remaining !== undefined && remaining <= 0,
	});
}

export function parseQuotaHeaders(headersInput: Record<string, string>, status = 200, now = Date.now()): QuotaWindow[] {
	const headers = normalizeHeaders(headersInput);
	const windows: QuotaWindow[] = [
		...parseCodexHeaders(headers, now),
		...parseAnthropicUnifiedHeaders(headers, now),
	];

	for (const [dimension, label, unit] of [
		["requests", "请求", "requests"],
		["tokens", "Token", "tokens"],
		["input-tokens", "输入", "tokens"],
		["output-tokens", "输出", "tokens"],
	] as const) {
		addLimitWindow(
			windows,
			`x-ratelimit-${dimension}`,
			label,
			unit,
			headers[`x-ratelimit-limit-${dimension}`],
			headers[`x-ratelimit-remaining-${dimension}`],
			headers[`x-ratelimit-reset-${dimension}`],
			now,
		);
		addLimitWindow(
			windows,
			`anthropic-${dimension}`,
			label,
			unit,
			headers[`anthropic-ratelimit-${dimension}-limit`],
			headers[`anthropic-ratelimit-${dimension}-remaining`],
			headers[`anthropic-ratelimit-${dimension}-reset`],
			now,
		);
	}

	addLimitWindow(windows, "ratelimit-generic", "请求", "requests", headers["ratelimit-limit"], headers["ratelimit-remaining"], headers["ratelimit-reset"], now);
	addLimitWindow(windows, "x-ratelimit-generic", "请求", "requests", headers["x-ratelimit-limit"], headers["x-ratelimit-remaining"], headers["x-ratelimit-reset"], now);

	if (status === 429 && windows.length === 0) {
		windows.push({
			id: "http-429",
			label: "请求",
			unit: "requests",
			remaining: 0,
			usedPercent: 100,
			resetAt: resetFromHeader(headers["retry-after"], now),
			limited: true,
		});
	}

	const deduped = new Map<string, QuotaWindow>();
	for (const window of windows) {
		const key = `${window.label}|${window.unit}`;
		const previous = deduped.get(key);
		if (!previous || (previous.limit === undefined && window.limit !== undefined)) deduped.set(key, window);
	}
	return [...deduped.values()];
}

export function mergeObservations(account: QuotaObservation | undefined, headers: QuotaObservation | undefined): QuotaObservation | undefined {
	if (!account) return headers;
	if (!headers) return account;
	const newer = headers.checkedAt >= account.checkedAt ? headers : account;
	const older = newer === headers ? account : headers;
	const merged = new Map<string, QuotaWindow>();
	for (const window of older.windows) merged.set(`${window.label}|${window.unit}`, window);
	for (const window of newer.windows) merged.set(`${window.label}|${window.unit}`, window);
	return {
		...newer,
		// Account APIs carry plan metadata even when response headers are newer.
		plan: account.plan ?? newer.plan,
		email: account.email,
		resetCredits: account.resetCredits,
		checkedAt: newer.checkedAt,
		windows: [...merged.values()],
		note: [account.note, headers.note].filter(Boolean).join(" · ") || undefined,
	};
}

function currencySymbol(currency: string | undefined): string {
	return currency === "CNY" ? "¥" : currency === "EUR" ? "€" : "$";
}

function compactNumber(value: number): string {
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	if (absolute >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function authModeLabel(mode: AuthMode): string {
	return mode === "subscription" ? "订阅" : mode === "oauth" ? "OAuth" : mode === "api_key" ? "Key" : "认证";
}

function compactResetDate(resetAt: number): string {
	const date = new Date(resetAt * 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextResetAt(observation: QuotaObservation, now = Date.now()): number | undefined {
	const future = observation.windows
		.map((window) => window.resetAt)
		.filter((value): value is number => value !== undefined && value * 1000 > now);
	return future.length ? Math.min(...future) : undefined;
}

export function formatCompact(observation: QuotaObservation, now = Date.now(), showAccount = true): string {
	const mode = authModeLabel(observation.authMode);
	const account = showAccount ? formatAccountLabel(observation) : "";
	const prefix = `额度[${mode}]${account ? ` ${account} ·` : ""}`;
	const creditsSuffix = observation.provider === "openai-codex" && observation.resetCredits !== undefined
		? ` · 重置卡 ${observation.resetCredits}次` : "";
	const resetAt = observation.authMode === "subscription" ? nextResetAt(observation, now) : undefined;
	const resetSuffix = resetAt === undefined ? "" : ` · ↻ ${compactResetDate(resetAt)}`;
	const percentWindows = observation.windows.filter((window) => remainingPercent(window) !== undefined).slice(0, 2);
	if (percentWindows.length > 0) {
		return `${prefix} ${percentWindows.map((window) => {
			const reset = observation.authMode === "subscription" && window.resetAt !== undefined && window.resetAt * 1000 > now
				? ` ↻ ${compactResetDate(window.resetAt)}`
				: "";
			return `${window.label} ${Math.round(remainingPercent(window)!)}%${reset}`;
		}).join(" · ")}${creditsSuffix}`;
	}
	const balances = observation.windows.filter((window) => window.remaining !== undefined).slice(0, 2);
	if (balances.length > 0) {
		return `${prefix} ${balances.map((window) => {
			const prefix = window.unit === "currency" ? currencySymbol(window.currency) : "";
			const label = window.unit === "currency" ? "" : `${window.label} `;
			return `${label}${prefix}${compactNumber(window.remaining!)}${window.limit !== undefined ? `/${prefix}${compactNumber(window.limit)}` : ""}`;
		}).join(" · ")}${resetSuffix}${creditsSuffix}`;
	}
	return `${prefix} 上游未公开${creditsSuffix}`;
}

export function lowestRemainingPercent(observation: QuotaObservation): number | undefined {
	const values = observation.windows.map(remainingPercent).filter((value): value is number => value !== undefined);
	return values.length ? Math.min(...values) : undefined;
}

function formatReset(resetAt: number | undefined, now = Date.now()): string {
	if (!resetAt) return "—";
	const delta = resetAt * 1000 - now;
	if (delta <= 0) return "即将重置";
	const minutes = Math.ceil(delta / 60000);
	const relative = minutes < 60 ? `${minutes} 分钟后`
		: minutes < 1440 ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分` : ""}后`
			: `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60)}小时后`;
	return `${relative} (${new Date(resetAt * 1000).toLocaleString()})`;
}

export function formatDetails(observation: QuotaObservation, now = Date.now()): string {
	const lines = [
		`模型：${observation.provider}/${observation.modelId}`,
		`认证：${authModeLabel(observation.authMode)}${observation.plan ? ` · ${observation.plan}` : ""}`,
		`来源：${observation.source === "account_api" ? "账户额度接口" : "模型响应头"}`,
	];
	const account = formatAccountLabel(observation);
	if (account) lines.splice(1, 0, `账户：${account}`);
	for (const window of observation.windows) {
		const remainingPct = remainingPercent(window);
		const prefix = window.unit === "currency" ? currencySymbol(window.currency) : "";
		const amount = window.remaining !== undefined
			? `${prefix}${compactNumber(window.remaining)}${window.limit !== undefined ? ` / ${prefix}${compactNumber(window.limit)}` : ""}`
			: remainingPct !== undefined ? `${Math.round(remainingPct)}%` : "未知";
		lines.push(`${window.label}：剩余 ${amount} · 重置 ${formatReset(window.resetAt, now)}${window.limited ? " · 已限流" : ""}`);
	}
	if (observation.note) lines.push(`备注：${observation.note}`);
	lines.push(`更新：${new Date(observation.checkedAt).toLocaleString()}`);
	return lines.join("\n");
}
