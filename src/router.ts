/**
 * Routing decisions: build the model pool, classify prompts, and choose model + thinking level.
 */

import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	bumpTier,
	type Candidate,
	type CatalogModel,
	defaultPool,
	discover,
	keyOf,
	ladder,
	pick,
	TIERS,
	toCandidate,
} from "./catalog.ts";
import { type Answer, classify, type Question } from "./classifier.ts";
import type { KindConfig, LoadedConfig } from "./config.ts";

export const LEVELS: ModelThinkingLevel[] = ["low", "medium", "high", "xhigh"];

export interface RouterState {
	v: 2;
	/** provider/id */
	model: string;
	thinkingLevel: ModelThinkingLevel;
	kind?: string;
	/** Excerpt of the prompt that started the current task, for work-shift detection. */
	taskPrompt?: string;
	/** The user chose this model; work shifts do not override it. */
	pinned?: boolean;
	reason: string;
}

export const isState = (s: unknown): s is RouterState => (s as RouterState | undefined)?.v === 2;

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

export interface Pool {
	candidates: Candidate[];
	/** Everything discovered, for the setup wizard. */
	discovered: Candidate[];
	/** Configured pool entries that are not available. */
	missing: string[];
}

export function buildPool(models: readonly CatalogModel[], loaded: LoadedConfig): Pool {
	const { config } = loaded;
	const discovered = discover(models, { providers: config.providers, overrides: config.models });
	if (!config.pool?.length) return { candidates: defaultPool(discovered), discovered, missing: [] };
	const byKey = new Map(models.map((m) => [keyOf(m), m]));
	const candidates: Candidate[] = [];
	const missing: string[] = [];
	for (const key of config.pool) {
		const m = byKey.get(key);
		if (m) candidates.push(toCandidate(m, config.models[key]));
		else missing.push(key);
	}
	return { candidates, discovered, missing };
}

/** Resolve "provider/id" or an alias ("opus") against the pool, then the discovered list. */
export function resolveRef(ref: string | undefined, pool: Pool): Candidate | undefined {
	if (!ref) return undefined;
	const r = ref.toLowerCase();
	const find = (list: Candidate[]) => list.find((c) => c.key.toLowerCase() === r) ?? list.find((c) => c.alias === r);
	return find(pool.candidates) ?? find(pool.discovered);
}

// ---------------------------------------------------------------------------------------------
// Kind -> model
// ---------------------------------------------------------------------------------------------

export function modelForKind(
	kind: KindConfig,
	hard: boolean,
	pool: Pool,
	images: boolean,
): Candidate | undefined {
	const pinned = resolveRef(hard ? (kind.hardModel ?? kind.model) : kind.model, pool);
	if (pinned) return pinned;
	const tier = kind.tier ?? "standard";
	const need = { tier, prefer: kind.prefer, minContext: kind.minContext, images };
	const normal = pick(pool.candidates, need);
	if (!hard) return normal;
	// Hard work goes one tier up, unless that loses the specialist: then stay and think harder.
	const up = pick(pool.candidates, { ...need, tier: bumpTier(tier, 1) });
	const fits = (c: Candidate | undefined) => !!c && (kind.prefer ?? []).some((s) => c.strengths.includes(s));
	return fits(normal) && !fits(up) ? normal : up;
}

/** The full kind -> (normal, hard) mapping, for display and setup. */
export function mapping(loaded: LoadedConfig, pool: Pool) {
	return Object.entries(loaded.kinds).map(([name, kind]) => ({
		name,
		kind,
		normal: modelForKind(kind, false, pool, false),
		hard: modelForKind(kind, true, pool, false),
	}));
}

// ---------------------------------------------------------------------------------------------
// Thinking level
// ---------------------------------------------------------------------------------------------

export function levelFor(base: ModelThinkingLevel, complexity: number, adjust: boolean): ModelThinkingLevel {
	if (!adjust) return base;
	const i = Math.max(0, LEVELS.indexOf(base));
	const delta = complexity < 0.75 ? -1 : complexity >= 2.5 ? 1 : 0;
	return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + delta))];
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

const COMPLEXITY = [
	"Trivial: a one-step task with an obvious answer",
	"Standard: routine work for an experienced engineer",
	"Involved: several interacting parts or non-obvious reasoning",
	"Very hard: subtle, high-stakes, or requires deep investigation",
];

export interface Classification {
	kind: string;
	kindProb: number;
	complexity: number;
	/** Probability the prompt starts a different kind of work (1 when there is no current task). */
	shift: number;
	requested: string;
	requestedProb: number;
	latencyMs: number;
}

export async function classifyPrompt(
	prompt: string,
	current: RouterState | undefined,
	loaded: LoadedConfig,
	pool: Pool,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Classification> {
	const { config, kinds } = loaded;
	const aliases = new Map<string, string>();
	for (const c of pool.candidates) if (!aliases.has(c.alias)) aliases.set(c.alias, c.label.replace(/ \d.*$/, ""));
	const questions: Record<string, Question> = {
		kind: {
			type: "choice",
			instructions: "What kind of software engineering work does `new_prompt` ask for?",
			criteria: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.desc])),
		},
		complexity: {
			type: "score",
			instructions: "How demanding is the work requested in `new_prompt`?",
			criteria: COMPLEXITY,
		},
		requested: {
			type: "choice",
			instructions:
				"Does `new_prompt` explicitly ask which AI model should handle the work, or ask to switch models? Only explicit requests about the model count, not the task itself.",
			criteria: {
				none: "No explicit request about which model to use",
				reroute: "Asks to re-route or pick a model again, without naming one",
				stronger: "Asks for a stronger, smarter, or more capable model",
				cheaper: "Asks for a cheaper, faster, or lighter model",
				...Object.fromEntries([...aliases].map(([alias, label]) => [alias, `Names ${label}`])),
			},
		},
	};
	const state: Record<string, unknown> = { new_prompt: prompt.slice(0, 12_000) };
	if (current?.kind && kinds[current.kind]) {
		state.current_task = { kind: current.kind, description: kinds[current.kind].desc, prompt: current.taskPrompt ?? "" };
		questions.shift = {
			type: "bool",
			instructions:
				"Does `new_prompt` start a different kind of work than `current_task`, rather than continuing, refining, or following up on it?",
			criteria: { true: "A different kind of work", false: "Continues or follows up on the current task" },
		};
	}
	const started = Date.now();
	const a = await classify(
		{ classifier: config.classifier, accountId: config.accountId, timeoutMs: config.classifierTimeoutMs },
		state,
		questions,
		ctx,
		signal,
	);
	const choice = (x: Answer | undefined) => (x?.type === "choice" ? x : { choice: "none", probabilities: {} as Record<string, number> });
	const kindA = choice(a.kind);
	const reqA = choice(a.requested);
	const kind = kindA.choice in kinds ? kindA.choice : Object.keys(kinds)[0];
	return {
		kind,
		kindProb: kindA.probabilities[kindA.choice] ?? 0,
		complexity: a.complexity?.type === "score" ? a.complexity.score : 1,
		shift: a.shift?.type === "bool" ? a.shift.probability : 1,
		requested: reqA.choice,
		requestedProb: reqA.probabilities[reqA.choice] ?? 0,
		latencyMs: Date.now() - started,
	};
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function stateFromClassification(
	c: Classification,
	loaded: LoadedConfig,
	pool: Pool,
	baseLevel: ModelThinkingLevel,
	prompt: string,
	images: boolean,
): RouterState | undefined {
	const kind = loaded.kinds[c.kind];
	const hard = c.complexity >= 2.25;
	const model = modelForKind(kind, hard, pool, images);
	if (!model) return undefined;
	return {
		v: 2,
		model: model.key,
		thinkingLevel: levelFor(baseLevel, c.complexity, loaded.config.adjustThinking),
		kind: c.kind,
		taskPrompt: prompt.slice(0, 2_000),
		reason: `${c.kind} (${pct(c.kindProb)}), complexity ${c.complexity.toFixed(1)}/3${hard ? " → hard" : ""}`,
	};
}

/** Model for an explicit "stronger"/"cheaper"/alias request, or undefined when it does not apply. */
export function requestedModel(
	c: Classification,
	loaded: LoadedConfig,
	pool: Pool,
	currentKey: string | undefined,
	images: boolean,
): Candidate | undefined {
	if (c.requested === "stronger" || c.requested === "cheaper") {
		const order = ladder(pool.candidates);
		const kind = loaded.kinds[c.kind];
		const fit = modelForKind(kind, c.requested === "stronger", pool, images);
		let i = order.findIndex((x) => x.key === currentKey);
		if (i === -1) i = order.findIndex((x) => x.key === fit?.key);
		const fitIdx = order.findIndex((x) => x.key === fit?.key);
		const idx =
			c.requested === "stronger"
				? Math.max(Math.min(order.length - 1, i + 1), fitIdx)
				: Math.min(Math.max(0, i - 1), fitIdx === -1 ? Infinity : fitIdx);
		return order[idx];
	}
	return resolveRef(c.requested, pool);
}

export function lastUserText(messages: readonly Message[]): { text: string; images: boolean } {
	const m = messages.filter((x) => x.role === "user").at(-1);
	const content = m?.content ?? "";
	if (typeof content === "string") return { text: content, images: false };
	const blocks = content as { type: string; text?: string }[];
	return {
		text: blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n"),
		images: blocks.some((b) => b.type === "image"),
	};
}

export function estimateTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const m of messages) chars += JSON.stringify(m.content ?? "").length;
	return Math.ceil(chars / 4);
}

/** If the conversation would overflow `candidate`, the cheapest pool model with enough room. */
export function ensureFits(candidate: Candidate, pool: Pool, tokens: number): Candidate {
	const fits = (c: Candidate) => !c.contextWindow || tokens < c.contextWindow * 0.85;
	if (fits(candidate)) return candidate;
	const rank = (c: Candidate) => TIERS.indexOf(c.tier);
	const order = ladder(pool.candidates);
	return order.find((c) => fits(c) && rank(c) >= rank(candidate)) ?? order.find(fits) ?? candidate;
}
