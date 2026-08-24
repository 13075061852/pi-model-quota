import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuthMode, QuotaObservation } from "./quota-core.ts";
import {
	authModeLabel,
	formatCompact,
	formatDetails,
	lowestRemainingPercent,
	mergeObservations,
	parseQuotaHeaders,
} from "./quota-core.ts";
import { probeAccountQuota, supportsAccountProbe } from "./probes.ts";

const STATUS_ID = "model-quota";
const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 60;
const MAX_REFRESH_SECONDS = 3600;

interface QuotaState {
	authMode: AuthMode;
	account?: QuotaObservation;
	headers?: QuotaObservation;
	responseSeen: boolean;
	probeError?: string;
	lastProbeAt?: number;
}

function refreshIntervalMs(): number {
	const configured = Number(process.env.PI_MODEL_QUOTA_REFRESH_SECONDS ?? DEFAULT_REFRESH_SECONDS);
	const seconds = Number.isFinite(configured)
		? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, configured))
		: DEFAULT_REFRESH_SECONDS;
	return seconds * 1000;
}

function modelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function detectAuthMode(ctx: ExtensionContext): AuthMode {
	const model = ctx.model;
	if (!model) return "unknown";
	if (ctx.modelRegistry.isUsingOAuth(model)) {
		return ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true
			? "subscription"
			: "oauth";
	}
	return ctx.modelRegistry.hasConfiguredAuth(model) ? "api_key" : "unknown";
}

function quotaPrefix(ctx: ExtensionContext, mode: string): string {
	return `${ctx.ui.theme.fg("accent", "◆")} ${ctx.ui.theme.fg("accent", `额度[${mode}]`)}`;
}

function colorRemainingValue(ctx: ExtensionContext, value: string): string {
	if (value.endsWith("%")) {
		const percent = Number(value.slice(0, -1));
		if (percent <= 10) return ctx.ui.theme.fg("error", value);
		if (percent <= 25) return ctx.ui.theme.fg("warning", value);
		if (percent <= 50) return ctx.ui.theme.fg("accent", value);
		return ctx.ui.theme.fg("success", value);
	}
	return ctx.ui.theme.fg("accent", value);
}

function coloredQuotaStatus(ctx: ExtensionContext, observation: QuotaObservation): string {
	const mode = authModeLabel(observation.authMode);
	const plain = formatCompact(observation);
	const body = plain.replace(`额度[${mode}]`, "").trim();
	const coloredBody = body.replace(
		/((?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}|[$¥€]\d+(?:\.\d+)?(?:\/[$¥€]?\d+(?:\.\d+)?)?|\d+(?:\.\d+)?%)/g,
		(value) => colorRemainingValue(ctx, value),
	);
	return `${quotaPrefix(ctx, mode)} ${coloredBody}`;
}

function stateStatus(ctx: ExtensionContext, mode: string, message: string, kind: "normal" | "loading" | "error"): string {
	const color = kind === "error" ? "error" : kind === "loading" ? "accent" : "dim";
	return `${quotaPrefix(ctx, mode)} ${ctx.ui.theme.fg(color, message)}`;
}

export default function modelQuotaExtension(pi: ExtensionAPI) {
	const states = new Map<string, QuotaState>();
	let activeContext: ExtensionContext | undefined;
	let activeKey: string | undefined;
	let generation = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let probeController: AbortController | undefined;
	let probePromise: Promise<void> | undefined;
	let probeSerial = 0;

	const stateFor = (key: string, ctx: ExtensionContext): QuotaState => {
		const authMode = detectAuthMode(ctx);
		let state = states.get(key);
		if (!state) {
			state = { authMode, responseSeen: false };
			states.set(key, state);
		} else if (state.authMode !== authMode) {
			// A /login or /logout can change auth without changing provider/model.
			// Never display quota observed under the previous credential.
			state = { authMode, responseSeen: false };
			states.set(key, state);
		}
		return state;
	};

	const effectiveObservation = (state: QuotaState): QuotaObservation | undefined =>
		mergeObservations(state.account, state.headers);

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const key = modelKey(ctx);
		if (!key) {
			ctx.ui.setStatus(STATUS_ID, stateStatus(ctx, "—", "无模型", "normal"));
			return;
		}
		const state = stateFor(key, ctx);
		const observation = effectiveObservation(state);
		if (observation) {
			ctx.ui.setStatus(STATUS_ID, coloredQuotaStatus(ctx, observation));
			return;
		}

		const mode = authModeLabel(state.authMode);
		const supported = supportsAccountProbe(ctx.model!.provider, state.authMode);
		const loading = supported && probePromise !== undefined && key === activeKey;
		const message = loading
			? "查询中…"
			: state.probeError
				? "查询失败"
				: state.responseSeen
					? "上游未公开"
					: supported
						? "等待查询"
						: "等待首次请求";
		ctx.ui.setStatus(STATUS_ID, stateStatus(ctx, mode, message, state.probeError ? "error" : loading ? "loading" : "normal"));
	};

	const refreshAccount = async (ctx: ExtensionContext, force = false): Promise<void> => {
		const key = modelKey(ctx);
		const model = ctx.model;
		if (!key || !model) return;
		const state = stateFor(key, ctx);
		if (!supportsAccountProbe(model.provider, state.authMode)) {
			renderStatus(ctx);
			return;
		}
		const interval = refreshIntervalMs();
		if (!force && state.lastProbeAt && Date.now() - state.lastProbeAt < interval) return;
		if (probePromise) {
			if (!force) return probePromise;
			probeController?.abort();
			try {
				await probePromise;
			} catch {
				// The new forced probe below replaces any cancelled one.
			}
		}

		const runGeneration = generation;
		const runKey = key;
		const runSerial = ++probeSerial;
		probeController = new AbortController();
		const runController = probeController;
		state.lastProbeAt = Date.now();
		state.probeError = undefined;
		renderStatus(ctx);

		probePromise = (async () => {
			const result = await probeAccountQuota(ctx, model.provider, model.id, state.authMode, runController.signal);
			if (generation !== runGeneration || probeSerial !== runSerial) return;
			const current = states.get(runKey);
			if (!current) return;
			if (result.observation) {
				current.account = result.observation;
				current.probeError = undefined;
			} else if (result.error && result.error !== "查询已取消") {
				// Keep the last valid observation on transient failures.
				current.probeError = result.error;
			}
		})().finally(() => {
			if (generation === runGeneration && probeSerial === runSerial) {
				probePromise = undefined;
				probeController = undefined;
				if (activeContext && activeKey === runKey) renderStatus(activeContext);
			}
		});
		return probePromise;
	};

	const activate = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		activeKey = modelKey(ctx);
		probeSerial++;
		probeController?.abort();
		probePromise = undefined;
		if (activeKey) stateFor(activeKey, ctx);
		renderStatus(ctx);
		if (ctx.hasUI) {
			queueMicrotask(() => {
				if (activeContext === ctx) void refreshAccount(ctx);
			});
		}
	};

	pi.on("session_start", (_event, ctx) => {
		generation++;
		activate(ctx);
		if (timer) clearInterval(timer);
		if (!ctx.hasUI) return;
		timer = setInterval(() => {
			const ctx = activeContext;
			if (!ctx) return;
			renderStatus(ctx);
			void refreshAccount(ctx);
		}, Math.min(refreshIntervalMs(), 60_000));
		timer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		activate(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const key = modelKey(ctx);
		const model = ctx.model;
		if (!key || !model) return;
		const state = stateFor(key, ctx);
		state.responseSeen = true;
		const windows = parseQuotaHeaders(event.headers, event.status);
		if (windows.length > 0) {
			state.headers = {
				provider: model.provider,
				modelId: model.id,
				authMode: state.authMode,
				source: "response_headers",
				checkedAt: Date.now(),
				windows,
			};
		} else if (event.status >= 200 && event.status < 400 && state.headers?.windows.some((window) => window.id === "http-429")) {
			// A later successful request proves a synthetic bare-429 observation is stale.
			const retained = state.headers.windows.filter((window) => window.id !== "http-429");
			state.headers = retained.length > 0
				? { ...state.headers, checkedAt: Date.now(), windows: retained }
				: undefined;
		}
		if (activeKey === key) renderStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (modelKey(ctx) === activeKey) {
			renderStatus(ctx);
			void refreshAccount(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		probeSerial++;
		probeController?.abort();
		probeController = undefined;
		probePromise = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
		activeContext = undefined;
		activeKey = undefined;
	});

	pi.registerCommand("quota", {
		description: "显示或刷新当前模型的剩余额度（/quota [refresh|debug]）",
		handler: async (args, ctx) => {
			activeContext = ctx;
			activeKey = modelKey(ctx);
			const key = modelKey(ctx);
			if (!key || !ctx.model) {
				ctx.ui.notify("当前没有已选择的模型", "warning");
				return;
			}
			const state = stateFor(key, ctx);
			const action = args.trim().toLowerCase();
			if (action === "refresh" || action === "r") {
				if (supportsAccountProbe(ctx.model.provider, state.authMode)) {
					await refreshAccount(ctx, true);
				} else {
					ctx.ui.notify("该提供商没有可安全查询的公开额度接口；会从下一次模型响应头更新。", "info");
				}
			}

			const observation = effectiveObservation(state);
			if (action === "debug") {
				ctx.ui.notify([
					`模型：${key}`,
					`认证：${authModeLabel(state.authMode)}`,
					`账户接口：${state.account ? "有数据" : supportsAccountProbe(ctx.model.provider, state.authMode) ? "支持但暂无数据" : "不支持"}`,
					`响应头：${state.headers ? "有数据" : state.responseSeen ? "未发现额度字段" : "尚未收到响应"}`,
					`最近错误：${state.probeError ?? "无"}`,
				].join("\n"), state.probeError ? "warning" : "info");
				return;
			}
			if (observation) {
				ctx.ui.notify(formatDetails(observation), lowestRemainingPercent(observation) !== undefined && lowestRemainingPercent(observation)! <= 10 ? "warning" : "info");
			} else {
				const hint = supportsAccountProbe(ctx.model.provider, state.authMode)
					? "运行 /quota refresh 重试。"
					: "该提供商需先完成一次模型请求，并且上游必须返回额度响应头。";
				ctx.ui.notify(`暂无可显示的额度。${state.probeError ? `\n原因：${state.probeError}` : ""}\n${hint}`, state.probeError ? "warning" : "info");
			}
			renderStatus(ctx);
		},
	});
}
