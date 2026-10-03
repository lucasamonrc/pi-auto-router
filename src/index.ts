/**
 * pi-auto-router: an "Auto" model for pi that classifies your prompts with a decision model
 * (Cloudflare Clef by default) and routes each task to the best-fitting model you have.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRoute,
	type ModelRouteRequest,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { type Candidate, type CatalogModel, formatContext, formatCost } from "./catalog.ts";
import { classifierLabel } from "./classifier.ts";
import { type LoadedConfig, loadConfig } from "./config.ts";
import {
	buildPool,
	type Classification,
	classifyPrompt,
	ensureFits,
	estimateTokens,
	isState,
	LEVELS,
	lastUserText,
	mapping,
	type Pool,
	type RouterState,
	requestedModel,
	resolveRef,
	stateFromClassification,
} from "./router.ts";
import { runSetup } from "./setup.ts";

const VPROVIDER = "auto";
const VID = "router";
const STATUS = "auto-router";

type Pending = { type: "reroute" } | { type: "pin"; ref: string } | { type: "unpin" };

export default function (pi: ExtensionAPI) {
	let loaded: LoadedConfig | undefined;
	let poolCache: { pool: Pool; size: number; loaded: LoadedConfig } | undefined;
	let pending: Pending | undefined;
	let last: { state: RouterState; classification?: Classification } | undefined;
	let warnedConfig = false;

	const agentDir = getAgentDir();

	async function reload(ctx: ExtensionContext) {
		loaded = await loadConfig(agentDir, ctx.cwd);
		poolCache = undefined;
		if (loaded.errors.length && ctx.hasUI && !warnedConfig) {
			warnedConfig = true;
			ctx.ui.notify(`auto-router config error: ${loaded.errors.join("; ")}`, "error");
		}
	}

	async function getLoaded(ctx: ExtensionContext): Promise<LoadedConfig> {
		if (!loaded) await reload(ctx);
		return loaded!;
	}

	function getPool(ctx: ExtensionContext, cfg: LoadedConfig): Pool {
		const models = ctx.modelRegistry.getAvailable() as readonly CatalogModel[];
		if (poolCache && poolCache.size === models.length && poolCache.loaded === cfg) return poolCache.pool;
		const pool = buildPool(models, cfg);
		poolCache = { pool, size: models.length, loaded: cfg };
		if (pool.missing.length && ctx.hasUI) ctx.ui.notify(`auto-router: unavailable models in pool: ${pool.missing.join(", ")}`, "warning");
		return pool;
	}

	// ---- Status line ----------------------------------------------------------------------------

	const isAuto = (m: { provider: string; id: string } | undefined) => m?.provider === VPROVIDER && m.id === VID;

	function labelOf(key: string, pool?: Pool): string {
		return (pool && resolveRef(key, pool)?.label) ?? key.split("/").at(-1) ?? key;
	}

	function showStatus(ctx: ExtensionContext, s: RouterState, pool?: Pool) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS, `auto: ${s.kind ?? "?"} → ${labelOf(s.model, pool)} · ${s.thinkingLevel}${s.pinned ? " 📌" : ""}`);
	}

	function branchState(ctx: ExtensionContext): RouterState | undefined {
		let state: RouterState | undefined;
		for (const e of ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]) {
			if (e.type !== "custom" || e.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
			const d = e.data as VirtualModelStateData<unknown>;
			if (d?.provider === VPROVIDER && d.modelId === VID && isState(d.state)) state = d.state;
		}
		return state;
	}

	async function syncStatus(ctx: ExtensionContext, selected = ctx.model) {
		if (!ctx.hasUI) return;
		if (!isAuto(selected)) return ctx.ui.setStatus(STATUS, undefined);
		const s = branchState(ctx);
		last = s ? { state: s } : undefined;
		if (s) showStatus(ctx, s, getPool(ctx, await getLoaded(ctx)));
		else ctx.ui.setStatus(STATUS, "auto: routes on first prompt");
	}

	pi.on("session_start", async (_e, ctx) => {
		await reload(ctx);
		await syncStatus(ctx);
	});
	pi.on("session_tree", (_e, ctx) => syncStatus(ctx));
	pi.on("model_select", (e, ctx) => syncStatus(ctx, e.model));

	// ---- Virtual model --------------------------------------------------------------------------

	pi.registerVirtualModel<RouterState>({
		provider: VPROVIDER,
		id: VID,
		name: "Auto",
		thinkingLevels: LEVELS,
		contextWindow: 272_000,
		maxTokens: 128_000,

		async route(req, ctx) {
			const cfg = await getLoaded(ctx);
			const pool = getPool(ctx, cfg);
			if (!pool.candidates.length) {
				throw new Error("auto-router: no usable models. Run /route setup or check `pi --list-models`.");
			}
			const tokens = estimateTokens(req.messages);

			const toRoute = (s: RouterState, store: boolean, c?: Classification): ModelRoute<RouterState> => {
				let cand = resolveRef(s.model, pool) ?? pool.candidates[0];
				const fitted = ensureFits(cand, pool, tokens);
				if (fitted.key !== cand.key) {
					s = { ...s, model: fitted.key, reason: `${s.reason}; context too large → ${fitted.label}` };
					store = true;
					cand = fitted;
				}
				const model = ctx.modelRegistry.find(cand.provider, cand.id);
				if (!model) throw new Error(`auto-router: ${cand.key} is not available`);
				last = { state: s, classification: c ?? last?.classification };
				showStatus(ctx, s, pool);
				return { model, thinkingLevel: s.thinkingLevel, state: store ? s : undefined };
			};

			// Out-of-loop requests (compaction summaries, extension calls).
			if (req.reason === "direct") {
				const cand =
					resolveRef(cfg.config.direct, pool) ??
					[...pool.candidates].sort((a, b) => b.contextWindow - a.contextWindow || a.cost - b.cost)[0];
				const model = ctx.modelRegistry.find(cand.provider, cand.id)!;
				return { model, thinkingLevel: "medium" };
			}

			const current = isState(req.state) ? req.state : undefined;

			// Tool follow-ups and retries stay on the model that handled the turn.
			if (req.reason !== "user" && current) {
				const err = req.failed?.message.errorMessage ?? "";
				if (req.reason === "retry" && /context|too long|too many tokens/i.test(err)) {
					const big = [...pool.candidates].sort((a, b) => b.contextWindow - a.contextWindow)[0];
					return toRoute({ ...current, model: big.key, reason: `context overflow → ${big.label}` }, true);
				}
				return toRoute(current, false);
			}

			const { text: prompt, images } = lastUserText(req.messages);
			const action = pending;
			pending = undefined;
			const base: ModelThinkingLevel = req.thinkingLevel;

			if (action?.type === "pin") {
				const cand = resolveRef(action.ref, pool);
				if (cand) {
					return toRoute(
						{ v: 2, kind: current?.kind, taskPrompt: current?.taskPrompt, model: cand.key, thinkingLevel: current?.thinkingLevel ?? base, pinned: true, reason: "pinned with /route" },
						true,
					);
				}
			}

			let c: Classification;
			try {
				c = await classifyPrompt(prompt, action?.type === "reroute" ? undefined : current, cfg, pool, ctx, req.signal);
			} catch (error) {
				if (req.signal?.aborted) throw error;
				if (ctx.hasUI) ctx.ui.notify(`auto-router: ${classifierLabel(cfg.config.classifier)} unavailable — ${(error as Error).message}`, "warning");
				if (current) return toRoute(current, false);
				const fb = resolveRef(cfg.config.fallback, pool) ?? [...pool.candidates].sort((a, b) => b.cost - a.cost)[0];
				return toRoute({ v: 2, model: fb.key, thinkingLevel: base, reason: "classifier unavailable → fallback" }, true);
			}

			const announce = (s: RouterState) => {
				if (ctx.hasUI && current && (current.model !== s.model || current.thinkingLevel !== s.thinkingLevel)) {
					ctx.ui.notify(`auto: ${labelOf(current.model, pool)} → ${labelOf(s.model, pool)} · ${s.thinkingLevel}  (${s.reason})`, "info");
				}
				return s;
			};
			const fresh = () => stateFromClassification(c, cfg, pool, base, prompt, images);

			// Explicit model request in the prompt.
			if (c.requested !== "none" && c.requestedProb >= cfg.config.requestThreshold) {
				if (c.requested === "reroute") {
					const s = fresh();
					if (s) return toRoute(announce({ ...s, reason: `re-route requested; ${s.reason}` }), true, c);
				}
				const cand = requestedModel(c, cfg, pool, current?.model, images);
				const s = fresh();
				if (cand && s) {
					return toRoute(announce({ ...s, model: cand.key, pinned: true, reason: `you asked for ${c.requested}` }), true, c);
				}
			}

			// First prompt, /route reroute, or /route auto.
			if (!current || action) {
				const s = fresh();
				if (s) return toRoute(announce(s), true, c);
			}

			// Work changed to a different kind of task. Pins hold until the user changes them.
			if (current && !current.pinned && c.shift >= cfg.config.shiftThreshold && c.kind !== current.kind) {
				const s = fresh();
				if (s) return toRoute(announce({ ...s, reason: `new task (${Math.round(c.shift * 100)}%): ${s.reason}` }), true, c);
			}

			return toRoute(current ?? { v: 2, model: pool.candidates[0].key, thinkingLevel: base, reason: "default" }, !current, c);
		},
	});

	// ---- Commands -------------------------------------------------------------------------------

	const SUBCOMMANDS = [
		{ value: "setup", description: "Interactive setup: classifier, models, task kinds" },
		{ value: "models", description: "Show which model each task kind routes to" },
		{ value: "test", description: "Classify a prompt without sending it: /route test <prompt>" },
		{ value: "reroute", description: "Re-classify on your next prompt" },
		{ value: "pin", description: "Pin a model: /route pin <alias|provider/id>" },
		{ value: "auto", description: "Unpin and route automatically again" },
		{ value: "config", description: "Show config file locations" },
	];

	function describeCandidate(c: Candidate | undefined) {
		return c ? `${c.label} (${c.tier}, ${formatCost(c)}, ${formatContext(c.contextWindow)})` : "—";
	}

	pi.registerCommand("route", {
		description: "Auto router: status, setup, models, test, reroute, pin, auto",
		getArgumentCompletions: (prefix) => {
			const [sub, ...rest] = prefix.split(" ");
			if (rest.length === 0) return SUBCOMMANDS.filter((s) => s.value.startsWith(sub)).map((s) => ({ ...s, label: s.value }));
			if (sub === "pin" && poolCache) {
				const q = rest.join(" ");
				return poolCache.pool.candidates
					.filter((c) => c.alias.startsWith(q) || c.key.startsWith(q))
					.map((c) => ({ value: `pin ${c.alias}`, label: c.alias, description: c.label }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const cfg = await getLoaded(ctx);
			const pool = getPool(ctx, cfg);

			switch (sub) {
				case "": {
					if (!isAuto(ctx.model)) {
						ctx.ui.notify("Auto is not selected. Pick “Auto” in /model, or run /route setup.", "info");
						return;
					}
					const s = last?.state ?? branchState(ctx);
					if (!s) return ctx.ui.notify("auto: no decision yet — it routes on your first prompt.", "info");
					const c = last?.classification;
					const lines = [
						`auto → ${describeCandidate(resolveRef(s.model, pool))} · thinking ${s.thinkingLevel}${s.pinned ? " · 📌 pinned" : ""}`,
						`why: ${s.reason}`,
					];
					if (c) lines.push(`${classifierLabel(cfg.config.classifier)}: ${c.kind} ${Math.round(c.kindProb * 100)}% · complexity ${c.complexity.toFixed(2)} · new-task ${Math.round(c.shift * 100)}% · ${c.latencyMs} ms`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "setup":
					await runSetup(ctx, {
						loaded: cfg,
						models: ctx.modelRegistry.getAvailable() as readonly CatalogModel[],
						agentDir,
						reload: () => reload(ctx),
						autoSelected: isAuto(ctx.model),
						switchToAuto: async () => {
							const m = ctx.modelRegistry.find(VPROVIDER, VID);
							return m ? pi.setModel(m) : false;
						},
					});
					return;
				case "models": {
					const rows = mapping(cfg, pool).map(({ name, normal, hard }) => {
						const h = hard && hard.key !== normal?.key ? `   hard → ${hard.label}` : "";
						return `  ${name.padEnd(15)} → ${normal?.label ?? "—"}${h}`;
					});
					const poolRows = pool.candidates.map((c) => `  ${c.alias.padEnd(18)} ${describeCandidate(c)}`);
					ctx.ui.notify(
						[
							`Classifier: ${classifierLabel(cfg.config.classifier)}`,
							"Task kinds:",
							...rows,
							`Pool (${cfg.config.pool ? "configured" : "auto-discovered"}):`,
							...poolRows,
						].join("\n"),
						"info",
					);
					return;
				}
				case "test": {
					const prompt = rest.join(" ");
					if (!prompt) return ctx.ui.notify("Usage: /route test <prompt>", "warning");
					try {
						const c = await classifyPrompt(prompt, undefined, cfg, pool, ctx);
						const s = stateFromClassification(c, cfg, pool, ctx.thinkingLevel ?? "medium", prompt, false);
						ctx.ui.notify(
							[
								`→ ${describeCandidate(s && resolveRef(s.model, pool))} · thinking ${s?.thinkingLevel}`,
								`kind ${c.kind} (${Math.round(c.kindProb * 100)}%) · complexity ${c.complexity.toFixed(2)}/3 · model request: ${c.requested} (${Math.round(c.requestedProb * 100)}%) · ${c.latencyMs} ms`,
							].join("\n"),
							"info",
						);
					} catch (e) {
						ctx.ui.notify(`Classifier error: ${(e as Error).message}`, "error");
					}
					return;
				}
				case "reroute":
					pending = { type: "reroute" };
					return ctx.ui.notify("auto: will re-classify your next prompt", "info");
				case "auto":
					pending = { type: "unpin" };
					return ctx.ui.notify("auto: unpinned — your next prompt is routed automatically", "info");
				case "config":
					return ctx.ui.notify(
						cfg.sources.length ? `Config files:\n${cfg.sources.map((s) => `  ${s}`).join("\n")}` : "No config file yet — using defaults. Run /route setup.",
						"info",
					);
				default: {
					// `/route pin opus` or the shorthand `/route opus`
					const ref = sub === "pin" ? rest.join(" ") : sub;
					const cand = resolveRef(ref, pool);
					if (!cand) {
						return ctx.ui.notify(`Unknown model "${ref}". Try: ${pool.candidates.map((c) => c.alias).join(", ")}`, "warning");
					}
					pending = { type: "pin", ref: cand.key };
					return ctx.ui.notify(`auto: will use ${cand.label} from your next prompt (📌 pinned)`, "info");
				}
			}
		},
	});
}
