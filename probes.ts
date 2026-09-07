import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AuthMode, QuotaObservation } from "./quota-core.ts";
import { accountEmail, accountPlan, parseAccountPayload } from "./quota-core.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

interface ModelLike {
	provider: string;
	id: string;
	baseUrl?: string;
}

interface ProviderLike {
	baseUrl?: string;
}

interface AuthResultLike {
	auth?: {
		apiKey?: string;
		headers?: Record<string, string | null>;
		baseUrl?: string;
	};
	source?: string;
}

export interface ProbeContext {
	model?: ModelLike;
	modelRegistry: {
		getProviderAuth(provider: string): Promise<AuthResultLike | undefined>;
		getProvider(provider: string): ProviderLike | undefined;
	};
}

interface ProbeDefinition {
	url: string;
	allowedOrigin: string;
	makeHeaders(token: string): Record<string, string>;
}

export interface ProbeResult {
	observation?: QuotaObservation;
	error?: string;
}

export function supportsAccountProbe(provider: string, authMode: AuthMode): boolean {
	if (provider === "openai-codex" || provider === "anthropic") {
		return authMode === "subscription" || authMode === "oauth";
	}
	return provider === "openrouter"
		|| provider === "kimi-coding"
		|| provider === "zai"
		|| provider === "zai-coding-cn"
		|| provider === "deepseek";
}

function bearerFromAuth(result: AuthResultLike | undefined): string | undefined {
	if (result?.auth?.apiKey) return result.auth.apiKey;
	for (const [key, value] of Object.entries(result?.auth?.headers ?? {})) {
		if (key.toLowerCase() === "authorization" && typeof value === "string") {
			return value.replace(/^Bearer\s+/i, "");
		}
	}
	return undefined;
}

export function decodeCodexAccount(token: string): { accountId?: string; email?: string; plan?: string } {
	// Decode only for display/routing, not as proof of identity or authorization.
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1] || parts[1].length > 64 * 1024) return {};
		const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const auth = json?.["https://api.openai.com/auth"];
		const profile = json?.["https://api.openai.com/profile"];
		return {
			accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
			email: accountEmail(profile?.email) ?? accountEmail(json?.email),
			plan: accountPlan(auth?.chatgpt_plan_type),
		};
	} catch {
		return {};
	}
}

function definitionFor(provider: string, token: string): ProbeDefinition | undefined {
	if (provider === "openai-codex") {
		const { accountId } = decodeCodexAccount(token);
		if (!accountId) return undefined;
		return {
			url: "https://chatgpt.com/backend-api/wham/usage",
			allowedOrigin: "https://chatgpt.com",
			makeHeaders: (accessToken) => ({
				Authorization: `Bearer ${accessToken}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
				"User-Agent": "pi-model-quota/1.0",
			}),
		};
	}
	if (provider === "anthropic") {
		return {
			url: "https://api.anthropic.com/api/oauth/usage",
			allowedOrigin: "https://api.anthropic.com",
			makeHeaders: (accessToken) => ({
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
				Accept: "application/json",
				"User-Agent": "pi-model-quota/1.0",
			}),
		};
	}
	if (provider === "openrouter") {
		return {
			url: "https://openrouter.ai/api/v1/key",
			allowedOrigin: "https://openrouter.ai",
			makeHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
		};
	}
	if (provider === "kimi-coding") {
		return {
			url: "https://api.kimi.com/coding/v1/usages",
			allowedOrigin: "https://api.kimi.com",
			makeHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
		};
	}
	if (provider === "deepseek") {
		return {
			url: "https://api.deepseek.com/user/balance",
			allowedOrigin: "https://api.deepseek.com",
			makeHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
		};
	}
	if (provider === "zai") {
		return {
			url: "https://api.z.ai/api/monitor/usage/quota/limit",
			allowedOrigin: "https://api.z.ai",
			makeHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
		};
	}
	if (provider === "zai-coding-cn") {
		return {
			url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
			allowedOrigin: "https://open.bigmodel.cn",
			makeHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" }),
		};
	}
	return undefined;
}

function effectiveOrigin(ctx: ProbeContext, result: AuthResultLike | undefined): string | undefined {
	const raw = result?.auth?.baseUrl
		?? ctx.model?.baseUrl
		?? ctx.modelRegistry.getProvider(ctx.model?.provider ?? "")?.baseUrl;
	if (!raw) return undefined;
	try {
		return new URL(raw).origin;
	} catch {
		return undefined;
	}
}

function shortError(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return text.replace(/\s+/g, " ").slice(0, 180);
}

async function readTextLimited(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let output = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) throw new Error("额度接口响应过大");
			output += decoder.decode(value, { stream: true });
		}
		return output + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function fetchJson(definition: ProbeDefinition, token: string, signal?: AbortSignal, body?: string): Promise<unknown> {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
	const setter = (http as typeof http & {
		setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => () => void;
	}).setGlobalProxyFromEnv;
	const restoreProxy = hasProxy && setter ? setter(process.env) : () => {};
	try {
		const response = await fetch(definition.url, {
			method: body === undefined ? "GET" : "POST",
			headers: { ...definition.makeHeaders(token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body,
			redirect: "error",
			signal: combined,
		});
		const text = await readTextLimited(response);
		if (!response.ok) {
			let detail = response.statusText;
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const nested = parsed.error as Record<string, unknown> | string | undefined;
				detail = typeof nested === "string" ? nested
					: typeof nested?.message === "string" ? nested.message
						: typeof parsed.message === "string" ? parsed.message
							: detail;
			} catch {
				// Never surface a raw body: it can contain account data.
			}
			throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		}
		return JSON.parse(text);
	} finally {
		restoreProxy();
	}
}

// Preparation is read-only. The returned action is invoked ONLY after user confirmation.
export async function prepareCodexReset(ctx: ProbeContext, authMode: AuthMode) {
	if (ctx.model?.provider !== "openai-codex" || !["subscription", "oauth"].includes(authMode)) {
		throw new Error("仅支持 OpenAI Codex OAuth/订阅重置卡");
	}
	const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = bearerFromAuth(auth);
	const definition = token ? definitionFor("openai-codex", token) : undefined;
	if (!token || !definition || effectiveOrigin(ctx, auth) !== definition.allowedOrigin) {
		throw new Error("无法确认官方认证来源，已禁止使用重置卡");
	}
	let invoked = false;
	return async (signal: AbortSignal, onDispatch: () => void): Promise<boolean> => {
		if (invoked) throw new Error("同一重置操作不能重复提交");
		invoked = true;
		const current = await ctx.modelRegistry.getProviderAuth("openai-codex");
		signal.throwIfAborted();
		if (ctx.model?.provider !== "openai-codex" || bearerFromAuth(current) !== token || effectiveOrigin(ctx, current) !== definition.allowedOrigin) {
			throw new Error("认证或模型已变化，请重新确认");
		}
		onDispatch();
		// Never retry this mutation, even on timeout. No raw server errors are surfaced.
		try {
			const data = await fetchJson({ ...definition, url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume" }, token, signal,
				JSON.stringify({ redeem_request_id: randomUUID() }));
			const result = data as { code?: unknown; windows_reset?: unknown } | null;
			return result?.code === "reset" && typeof result.windows_reset === "number" && Number.isInteger(result.windows_reset) && result.windows_reset > 0;
		} catch {
			return false;
		}
	};
}

export async function probeAccountQuota(
	ctx: ProbeContext,
	provider: string,
	modelId: string,
	authMode: AuthMode,
	signal?: AbortSignal,
	onCredential?: (fingerprint: string) => void,
): Promise<ProbeResult> {
	if (!supportsAccountProbe(provider, authMode)) return {};
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(provider);
		const fingerprint = createHash("sha256").update(JSON.stringify(auth ?? null)).digest("hex");
		onCredential?.(fingerprint);
		const token = bearerFromAuth(auth);
		if (!token) return { error: "未解析到当前认证凭据" };
		const definition = definitionFor(provider, token);
		if (!definition) return { error: provider === "openai-codex" ? "OAuth 令牌中没有账户 ID" : "没有可用额度接口" };

		const origin = effectiveOrigin(ctx, auth);
		if (origin && origin !== definition.allowedOrigin) {
			return { error: `已阻止向非认证源发送凭据 (${origin})` };
		}

		const data = await fetchJson(definition, token, signal);
		const currentAuth = await ctx.modelRegistry.getProviderAuth(provider);
		const currentFingerprint = createHash("sha256").update(JSON.stringify(currentAuth ?? null)).digest("hex");
		if (currentFingerprint !== fingerprint) {
			onCredential?.(currentFingerprint);
			return { error: "认证已变化，请刷新额度" };
		}
		const identity = provider === "openai-codex" ? decodeCodexAccount(token) : {};
		const parsed = parseAccountPayload(provider, data);
		if (parsed.windows.length === 0) return { error: "额度接口未返回可识别的额度窗口" };
		return {
			observation: {
				provider,
				modelId,
				authMode,
				source: "account_api",
				checkedAt: Date.now(),
				windows: parsed.windows,
				plan: parsed.plan ?? identity.plan,
				email: identity.email,
				note: parsed.note,
				resetCredits: parsed.resetCredits,
			},
		};
	} catch (error) {
		if (signal?.aborted) return { error: "查询已取消" };
		return { error: shortError(error) };
	}
}
