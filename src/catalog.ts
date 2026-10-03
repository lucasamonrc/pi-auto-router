/**
 * Model discovery, tiering, and selection. Pure functions: no pi runtime imports, so this file is
 * unit-testable with plain `node --test`.
 */

export const TIERS = ["light", "standard", "strong", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/** The subset of a pi `Model` this module needs. */
export interface CatalogModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	input?: readonly string[];
	cost?: { input: number; output: number };
	type?: string;
}

export interface Family {
	/** Stable key, also the default alias users type: `/route opus`. */
	key: string;
	label: string;
	match: RegExp;
	tier: Tier;
	strengths: string[];
	/** Included in the zero-config pool. */
	defaultPool: boolean;
}

/**
 * Known model families. Tiers and strengths are opinions; users override them per model in config.
 * Order matters: the first matching family wins.
 */
export const FAMILIES: Family[] = [
	{ key: "fable", label: "Claude Fable", match: /claude-fable/, tier: "frontier", strengths: ["long_context", "architecture", "writing"], defaultPool: true },
	{ key: "opus", label: "Claude Opus", match: /claude-opus/, tier: "strong", strengths: ["feature", "frontend", "architecture", "writing"], defaultPool: true },
	{ key: "sonnet", label: "Claude Sonnet", match: /claude-sonnet/, tier: "standard", strengths: ["feature", "frontend", "writing"], defaultPool: true },
	{ key: "haiku", label: "Claude Haiku", match: /claude-haiku/, tier: "light", strengths: [], defaultPool: true },
	{ key: "sol", label: "GPT Sol", match: /gpt-[\d.]+-sol/, tier: "strong", strengths: ["debugging"], defaultPool: true },
	{ key: "terra", label: "GPT Terra", match: /gpt-[\d.]+-terra/, tier: "standard", strengths: ["feature", "debugging"], defaultPool: true },
	{ key: "luna", label: "GPT Luna", match: /gpt-[\d.]+-luna/, tier: "light", strengths: ["feature"], defaultPool: true },
	{ key: "gemini-pro", label: "Gemini Pro", match: /gemini-[\d.]+-pro/, tier: "strong", strengths: ["long_context", "frontend"], defaultPool: true },
	{ key: "gemini-flash-lite", label: "Gemini Flash-Lite", match: /gemini-[\d.]+-flash-lite/, tier: "light", strengths: [], defaultPool: false },
	{ key: "gemini-flash", label: "Gemini Flash", match: /gemini-[\d.]+-flash/, tier: "light", strengths: ["long_context"], defaultPool: true },
	{ key: "gpt-mini", label: "GPT mini", match: /^gpt-[\d.]+-(mini|nano)$/, tier: "light", strengths: [], defaultPool: false },
	{ key: "gpt", label: "GPT", match: /^gpt-[\d.]+$/, tier: "standard", strengths: ["feature"], defaultPool: false },
	{ key: "kimi", label: "Kimi", match: /kimi-k/, tier: "standard", strengths: ["feature", "frontend"], defaultPool: false },
	{ key: "glm-flash", label: "GLM Flash", match: /glm-[\d.]+-flash/, tier: "light", strengths: [], defaultPool: false },
	{ key: "glm", label: "GLM", match: /glm-[\d.]+/, tier: "standard", strengths: ["feature"], defaultPool: false },
	{ key: "deepseek-pro", label: "DeepSeek Pro", match: /deepseek-v[\d.]+-pro/, tier: "standard", strengths: ["feature", "debugging"], defaultPool: false },
	{ key: "deepseek-flash", label: "DeepSeek Flash", match: /deepseek-v[\d.]+-flash/, tier: "light", strengths: [], defaultPool: false },
	{ key: "qwen", label: "Qwen", match: /qwen/, tier: "light", strengths: [], defaultPool: false },
];

/** Snapshots, aliases, and special-purpose variants never offered. */
const EXCLUDE = /customtools|live|chat-latest|-latest$|-\d{4}$|embed|image|tts|audio|realtime/;
const PREVIEW = /preview|exp/;

export interface ModelOverride {
	tier?: Tier;
	strengths?: string[];
	alias?: string;
	label?: string;
}

export interface Candidate {
	key: string; // provider/id
	provider: string;
	id: string;
	label: string;
	alias: string;
	tier: Tier;
	strengths: string[];
	contextWindow: number;
	/** Blended $ per million tokens (input-heavy, as agent sessions are). 0 = unknown. */
	cost: number;
	images: boolean;
	family?: string;
	version: number;
	preview: boolean;
}

export const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** Bare model id without router prefixes such as `@cf/vendor/`. */
const bareId = (id: string) => id.toLowerCase().split("/").at(-1) ?? id.toLowerCase();

export function familyOf(id: string): Family | undefined {
	const bare = bareId(id);
	return FAMILIES.find((f) => f.match.test(bare));
}

/** `claude-opus-5-5` -> 5.05, `gpt-6.1-sol` -> 6.01, `gemini-3.1-pro` -> 3.01. */
export function versionOf(id: string): number {
	const m = bareId(id).match(/(\d+)(?:[.-](\d{1,2}))?(?!\d)/);
	if (!m) return 0;
	return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
}

export function blendedCost(m: CatalogModel): number {
	if (!m.cost) return 0;
	return (m.cost.input * 3 + m.cost.output) / 4;
}

/** Tier from price, for models no family knows. */
export function tierFromCost(cost: number): Tier {
	if (cost <= 0) return "standard";
	if (cost < 1) return "light";
	if (cost < 5) return "standard";
	if (cost < 15) return "strong";
	return "frontier";
}

function prettyLabel(m: CatalogModel, family?: Family): string {
	if (!family) return m.name ?? bareId(m.id);
	const v = versionOf(m.id);
	const ver = v ? ` ${Math.floor(v)}${v % 1 ? `.${Math.round((v % 1) * 100)}` : ""}` : "";
	return `${family.label}${ver}${PREVIEW.test(bareId(m.id)) ? " (preview)" : ""}`;
}

export function toCandidate(m: CatalogModel, override?: ModelOverride): Candidate {
	const family = familyOf(m.id);
	const cost = blendedCost(m);
	return {
		key: keyOf(m),
		provider: m.provider,
		id: m.id,
		label: override?.label ?? prettyLabel(m, family),
		alias: override?.alias ?? family?.key ?? bareId(m.id),
		tier: override?.tier ?? family?.tier ?? tierFromCost(cost),
		strengths: override?.strengths ?? family?.strengths ?? [],
		contextWindow: m.contextWindow ?? 0,
		cost,
		images: m.input?.includes("image") ?? false,
		family: family?.key,
		version: versionOf(m.id),
		preview: PREVIEW.test(bareId(m.id)),
	};
}

/** Chat models that can drive a coding agent. */
export function isEligible(m: CatalogModel): boolean {
	if (m.type && m.type !== "chat") return false;
	if (m.provider === "auto") return false; // virtual models, including this router
	if (!m.reasoning) return false;
	if ((m.contextWindow ?? 0) < 100_000) return false;
	return !EXCLUDE.test(bareId(m.id));
}

export interface DiscoverOptions {
	/** Provider preference when the same model is reachable through several providers. */
	providers?: string[];
	overrides?: Record<string, ModelOverride>;
}

/**
 * All eligible models, with only the newest version of each known family kept per provider
 * preference. Unknown models are all kept. Sorted: known families by tier, then unknown by cost.
 */
export function discover(models: readonly CatalogModel[], opts: DiscoverOptions = {}): Candidate[] {
	const providerRank = (p: string) => {
		const i = opts.providers?.indexOf(p) ?? -1;
		return i === -1 ? 999 : i;
	};
	const eligible = models.filter(isEligible);
	if (opts.providers?.length) {
		const allowed = eligible.filter((m) => opts.providers!.includes(m.provider));
		if (allowed.length) eligible.splice(0, eligible.length, ...allowed);
	}
	const all = eligible.map((m) => toCandidate(m, opts.overrides?.[keyOf(m)]));

	// Newest per family: highest version, then stable over preview, then preferred provider.
	const best = new Map<string, Candidate>();
	const unknown = new Map<string, Candidate>();
	for (const c of all) {
		if (!c.family) {
			const prev = unknown.get(bareId(c.id));
			if (!prev || providerRank(c.provider) < providerRank(prev.provider)) unknown.set(bareId(c.id), c);
			continue;
		}
		const prev = best.get(c.family);
		const better =
			!prev ||
			c.version > prev.version ||
			(c.version === prev.version && prev.preview && !c.preview) ||
			(c.version === prev.version && prev.preview === c.preview && providerRank(c.provider) < providerRank(prev.provider));
		if (better) best.set(c.family, c);
	}
	const price = (c: Candidate) => c.cost || Number.POSITIVE_INFINITY; // unknown price last
	const known = [...best.values()].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || price(a) - price(b));
	const rest = [...unknown.values()].sort((a, b) => price(a) - price(b));
	return [...known, ...rest];
}

/** Zero-config pool: newest model of each default family. */
export function defaultPool(discovered: Candidate[]): Candidate[] {
	return discovered.filter((c) => c.family && FAMILIES.find((f) => f.key === c.family)?.defaultPool);
}

export interface Need {
	tier: Tier;
	prefer?: string[];
	minContext?: number;
	images?: boolean;
}

export function bumpTier(tier: Tier, delta: number): Tier {
	return TIERS[Math.max(0, Math.min(TIERS.length - 1, TIERS.indexOf(tier) + delta))];
}

/**
 * Pick the best candidate for a need. Order: hard constraints (context, images), then closest tier
 * (prefer going up over going down), then matching strengths (task fit), then cheapest.
 */
export function pick(pool: readonly Candidate[], need: Need): Candidate | undefined {
	const target = TIERS.indexOf(need.tier);
	const fits = pool.filter(
		(c) => (!need.minContext || c.contextWindow >= need.minContext) && (!need.images || c.images),
	);
	const usable = fits.length ? fits : pool;
	const tierPenalty = (c: Candidate) => {
		const d = TIERS.indexOf(c.tier) - target;
		return d >= 0 ? d * 2 - (d > 0 ? 1 : 0) : -d * 2;
	};
	const match = (c: Candidate) => (need.prefer ?? []).filter((s) => c.strengths.includes(s)).length;
	return [...usable].sort(
		(a, b) => tierPenalty(a) - tierPenalty(b) || match(b) - match(a) || a.cost - b.cost,
	)[0];
}

/** Pool ordered by capability, for "stronger"/"cheaper" requests. */
export function ladder(pool: readonly Candidate[]): Candidate[] {
	return [...pool].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.cost - b.cost);
}

export function formatCost(c: Candidate): string {
	return c.cost ? `$${c.cost.toFixed(c.cost < 1 ? 2 : 1)}/M` : "$?";
}

export function formatContext(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
}
