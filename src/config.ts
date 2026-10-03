/**
 * Configuration: defaults, loading (global + project), and saving.
 *
 * Global:  ~/.pi/agent/auto-router.json
 * Project: <cwd>/.pi/auto-router.json  (merged over global)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelOverride, Tier } from "./catalog.ts";

export interface KindConfig {
	/** What this kind of work is. Sent to the classifier as the choice criterion. */
	desc: string;
	/** Capability tier for ordinary instances. Hard instances go one tier up. */
	tier?: Tier;
	/** Strengths to prefer within a tier. */
	prefer?: string[];
	/** Minimum context window. */
	minContext?: number;
	/** Always use this model (provider/id or alias). */
	model?: string;
	/** Model for hard instances (provider/id or alias). */
	hardModel?: string;
	/** Set false to remove a built-in kind. */
	enabled?: boolean;
}

export interface RouterConfig {
	/** "clef" | "clef-flash" (Cloudflare Workers AI) or any pi classifier as "provider/id", e.g. "typesafe/jev-latest". */
	classifier: string;
	/** Cloudflare account for Clef. Detected from your login when unset. */
	accountId?: string;
	classifierTimeoutMs: number;
	/** Models the router may use (provider/id). Unset: newest model of each well-known family. */
	pool?: string[];
	/** Restrict/prefer providers when discovering models. */
	providers?: string[];
	/** Per-model tier/strength/alias overrides, keyed by provider/id. */
	models: Record<string, ModelOverride>;
	/** Task kinds, merged over the built-ins by name. */
	kinds: Record<string, KindConfig>;
	/** Used when the classifier is unavailable at the start of a session (provider/id or alias). */
	fallback?: string;
	/** Used for compaction summaries and other out-of-loop requests (provider/id or alias). */
	direct?: string;
	/** Probability that a prompt starts a different kind of work before re-routing. */
	shiftThreshold: number;
	/** Probability that the user explicitly asks for a model before honoring it. */
	requestThreshold: number;
	/** Complexity shifts the thinking level one step down/up from the selected level. */
	adjustThinking: boolean;
}

export const DEFAULT_KINDS: Record<string, KindConfig> = {
	question: {
		desc: "Answer a question, explain code or a concept, or look something up; no meaningful code changes",
		tier: "light",
	},
	small_change: {
		desc: "Trivial or mechanical edits: typos, renames, config tweaks, version bumps, small scripts",
		tier: "light",
	},
	feature: {
		desc: "Implement or extend a feature, write tests, or refactor within a bounded area",
		tier: "standard",
		prefer: ["feature"],
	},
	frontend: {
		desc: "UI work: components, styling, layout, visual design, UX polish",
		tier: "strong",
		prefer: ["frontend"],
	},
	debugging: {
		desc: "Diagnose failures, investigate bugs, flaky tests, performance or correctness problems",
		tier: "strong",
		prefer: ["debugging"],
	},
	architecture: {
		desc: "System design, planning, cross-cutting refactors, migrations, or in-depth code review",
		tier: "strong",
		prefer: ["architecture"],
	},
	large_context: {
		desc: "Requires reading a very large amount of material at once: whole codebases, huge logs or documents",
		tier: "strong",
		prefer: ["long_context"],
		minContext: 600_000,
	},
	writing: {
		desc: "Prose: documentation, RFCs, emails, release notes, summaries",
		tier: "standard",
		prefer: ["writing"],
	},
};

export const DEFAULTS: RouterConfig = {
	classifier: "clef",
	classifierTimeoutMs: 8_000,
	models: {},
	kinds: {},
	shiftThreshold: 0.7,
	requestThreshold: 0.6,
	adjustThinking: true,
};

export type PartialConfig = Partial<RouterConfig>;

export const globalConfigPath = (agentDir: string) => join(agentDir, "auto-router.json");
export const projectConfigPath = (cwd: string) => join(cwd, ".pi", "auto-router.json");

async function readJson(path: string): Promise<{ data?: PartialConfig; error?: string }> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	try {
		return { data: JSON.parse(text) as PartialConfig };
	} catch (e) {
		return { error: `${path}: ${(e as Error).message}` };
	}
}

/** Merge kinds per kind name; `undefined` fields in `over` remove the field. */
export function mergeKinds(
	base: Record<string, KindConfig> | undefined,
	over: Record<string, Partial<KindConfig>> | undefined,
): Record<string, KindConfig> {
	const out: Record<string, KindConfig> = { ...base };
	for (const [name, k] of Object.entries(over ?? {})) {
		const merged: Record<string, unknown> = { ...out[name], ...k };
		for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
		if (Object.keys(merged).length) out[name] = merged as unknown as KindConfig;
		else delete out[name];
	}
	return out;
}

export function merge(base: RouterConfig, over: PartialConfig | undefined): RouterConfig {
	if (!over) return base;
	const kinds = mergeKinds(base.kinds, over.kinds);
	return {
		...base,
		...over,
		models: { ...base.models, ...over.models },
		kinds,
	};
}

export interface LoadedConfig {
	config: RouterConfig;
	/** Effective kinds: built-ins merged with config, disabled ones removed. */
	kinds: Record<string, KindConfig & { desc: string }>;
	sources: string[];
	errors: string[];
}

export async function loadConfig(agentDir: string, cwd: string): Promise<LoadedConfig> {
	const sources: string[] = [];
	const errors: string[] = [];
	let config = { ...DEFAULTS };
	for (const path of [globalConfigPath(agentDir), projectConfigPath(cwd)]) {
		const { data, error } = await readJson(path);
		if (error) errors.push(error);
		if (data) {
			config = merge(config, data);
			sources.push(path);
		}
	}
	return { config, kinds: effectiveKinds(config), sources, errors };
}

export function effectiveKinds(config: RouterConfig): Record<string, KindConfig & { desc: string }> {
	const out: Record<string, KindConfig & { desc: string }> = {};
	const names = new Set([...Object.keys(DEFAULT_KINDS), ...Object.keys(config.kinds)]);
	for (const name of names) {
		const k = { ...DEFAULT_KINDS[name], ...config.kinds[name] } as KindConfig;
		if (k.enabled === false || !k.desc) continue;
		out[name] = k as KindConfig & { desc: string };
	}
	return out;
}

/** Write a partial config, merging into whatever the file already has. */
export async function saveConfig(path: string, patch: PartialConfig): Promise<void> {
	const { data } = await readJson(path);
	const next: PartialConfig = { ...data, ...patch };
	if (patch.kinds) next.kinds = mergeKinds(data?.kinds, patch.kinds);
	if (patch.models) next.models = { ...data?.models, ...patch.models };
	const out: Record<string, unknown> = { $schema: SCHEMA_URL };
	for (const [k, v] of Object.entries(next)) if (v !== undefined && k !== "$schema") out[k] = v;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(out, null, "\t")}\n`);
}

export const SCHEMA_URL = "https://raw.githubusercontent.com/lucasamonrc/pi-auto-router/main/schema.json";
