/**
 * `/route setup`: an interactive wizard that writes auto-router.json.
 *
 * 1. Classifier (Clef, Clef-flash, or any classifier pi knows) + Cloudflare login/account
 * 2. Model pool (toggle discovered models, or add any model by id)
 * 3. Task kinds -> models (auto by tier, pin a model, disable, or add a custom kind)
 * 4. Save globally or for this project, then optionally switch to Auto
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Candidate,
	type CatalogModel,
	formatContext,
	formatCost,
	TIERS,
	type Tier,
	toCandidate,
	keyOf,
} from "./catalog.ts";
import { classifierLabel, isClef } from "./classifier.ts";
import { hasWranglerLogin, listAccounts, wranglerLogin } from "./cloudflare.ts";
import {
	effectiveKinds,
	globalConfigPath,
	type KindConfig,
	mergeKinds,
	type LoadedConfig,
	type PartialConfig,
	projectConfigPath,
	saveConfig,
} from "./config.ts";
import { buildPool, classifyPrompt, mapping, type Pool } from "./router.ts";

export interface SetupDeps {
	loaded: LoadedConfig;
	models: readonly CatalogModel[];
	agentDir: string;
	reload: () => Promise<void>;
	autoSelected: boolean;
	switchToAuto: () => Promise<boolean>;
}

const DONE = "✓ Done";
const BACK = "← Cancel";

export async function runSetup(ctx: ExtensionCommandContext, deps: SetupDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/route setup needs an interactive session", "error");
		return;
	}
	const ui = ctx.ui;
	const patch: PartialConfig = {};
	const config = { ...deps.loaded.config };

	// ---- 1. Classifier --------------------------------------------------------------------------
	const piClassifiers = (await ctx.modelRegistry.getAvailableOfType("classifier").catch(() => [])).map((m) => keyOf(m));
	const classifierOptions = new Map<string, string>([
		["Clef — Cloudflare Workers AI (recommended)", "clef"],
		["Clef-flash — fastest, slightly less accurate", "clef-flash"],
		...piClassifiers.map((k) => [`${k} — via pi`, k] as [string, string]),
	]);
	const pickedClassifier = await ui.select(
		`Step 1/4 · Classifier (current: ${classifierLabel(config.classifier)})`,
		[...classifierOptions.keys(), BACK],
	);
	if (!pickedClassifier || pickedClassifier === BACK) return;
	config.classifier = patch.classifier = classifierOptions.get(pickedClassifier)!;

	if (isClef(config.classifier)) {
		if (!process.env.CLOUDFLARE_API_TOKEN && !(await hasWranglerLogin())) {
			const ok = await ui.confirm(
				"Log in to Cloudflare?",
				"Clef runs on Workers AI. This runs `wrangler login`, which opens your browser. No API token needed.",
			);
			if (!ok) return;
			ui.notify("Waiting for the browser login…", "info");
			if (!(await wranglerLogin())) {
				ui.notify("wrangler login did not complete. Try `npx wrangler login` in a terminal.", "error");
				return;
			}
		}
		if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
			let accounts: Awaited<ReturnType<typeof listAccounts>>;
			try {
				accounts = await listAccounts();
			} catch (e) {
				ui.notify(`Could not list Cloudflare accounts: ${(e as Error).message}`, "error");
				return;
			}
			if (accounts.length === 0) {
				ui.notify("This login has no Cloudflare accounts.", "error");
				return;
			}
			if (accounts.length === 1) {
				config.accountId = patch.accountId = accounts[0].id;
			} else {
				const labels = accounts.map((a) => `${a.name}  (${a.id})${a.id === config.accountId ? "  ← current" : ""}`);
				const picked = await ui.select("Cloudflare account for Clef (Workers AI usage is billed here)", labels);
				if (!picked) return;
				config.accountId = patch.accountId = accounts[labels.indexOf(picked)].id;
			}
		}
	}

	// Connection test
	const testLoaded: LoadedConfig = { ...deps.loaded, config, kinds: effectiveKinds(config) };
	try {
		const c = await classifyPrompt("Fix the typo in the README", undefined, testLoaded, buildPool(deps.models, testLoaded), ctx);
		ui.notify(`${classifierLabel(config.classifier)} works (${c.latencyMs} ms)`, "info");
	} catch (e) {
		const go = await ui.confirm("Classifier test failed", `${(e as Error).message}\n\nContinue anyway?`);
		if (!go) return;
	}

	// ---- 2. Pool --------------------------------------------------------------------------------
	const initialPool = buildPool(deps.models, testLoaded);
	const extra: Candidate[] = initialPool.candidates.filter((c) => !initialPool.discovered.some((d) => d.key === c.key));
	let listed = [...initialPool.discovered, ...extra];
	const selected = new Set(initialPool.candidates.map((c) => c.key));
	const ADD = "＋ Add a model by id (e.g. an older version)…";
	for (;;) {
		const rows = listed.map(
			(c) =>
				`${selected.has(c.key) ? "◉" : "○"} ${c.label.padEnd(24)} ${c.tier.padEnd(9)}${formatCost(c).padEnd(9)}${formatContext(c.contextWindow).padStart(5)}  ${c.key}`,
		);
		const picked = await ui.select(
			`Step 2/4 · Models the router may use (${selected.size} selected) — select to toggle`,
			[`${DONE} (${selected.size} selected)`, ...rows, ADD, BACK],
		);
		if (!picked || picked === BACK) return;
		if (picked.startsWith(DONE)) {
			if (selected.size === 0) {
				ui.notify("Select at least one model", "warning");
				continue;
			}
			break;
		}
		if (picked === ADD) {
			const ref = (await ui.input("Model as provider/id", "anthropic/claude-opus-4-5"))?.trim();
			if (!ref) continue;
			const model = deps.models.find((m) => keyOf(m) === ref);
			if (!model) {
				ui.notify(`${ref} is not an available model (see \`pi --list-models\`)`, "warning");
				continue;
			}
			if (!listed.some((c) => c.key === ref)) listed = [...listed, toCandidate(model, config.models[ref])];
			selected.add(ref);
			continue;
		}
		const c = listed[rows.indexOf(picked)];
		if (selected.has(c.key)) selected.delete(c.key);
		else selected.add(c.key);
	}
	config.pool = patch.pool = listed.filter((c) => selected.has(c.key)).map((c) => c.key);

	// ---- 3. Kinds -------------------------------------------------------------------------------
	const kindPatch: Record<string, KindConfig> = {};
	const ADD_KIND = "＋ Add a custom task kind…";
	for (;;) {
		config.kinds = mergeKinds(deps.loaded.config.kinds, kindPatch);
		const loaded: LoadedConfig = { ...deps.loaded, config, kinds: effectiveKinds(config) };
		const pool: Pool = buildPool(deps.models, loaded);
		const rows = mapping(loaded, pool).map(({ name, kind, normal, hard }) => {
			const pin = kind.model ? " 📌" : "";
			const h = hard && hard.key !== normal?.key ? `  ·  hard → ${hard.label}` : "";
			return `${name.padEnd(15)} → ${normal?.label ?? "—"}${pin}${h}`;
		});
		const names = Object.keys(loaded.kinds);
		const picked = await ui.select("Step 3/4 · Task kinds → models — select one to change", [DONE, ...rows, ADD_KIND, BACK]);
		if (!picked || picked === BACK) return;
		if (picked === DONE) break;

		if (picked === ADD_KIND) {
			const name = (await ui.input("Kind name (snake_case)", "data_science"))?.trim().replace(/\W+/g, "_");
			if (!name) continue;
			const desc = (await ui.input(`What counts as "${name}"? (the classifier reads this)`, "Notebooks, pandas, statistics, plotting"))?.trim();
			if (!desc) continue;
			const tier = (await ui.select("Capability tier", [...TIERS])) as Tier | undefined;
			if (!tier) continue;
			kindPatch[name] = { desc, tier };
			continue;
		}

		const name = names[rows.indexOf(picked)];
		const kind = loaded.kinds[name];
		const AUTO = `Auto — best ${kind.tier ?? "standard"}-tier model${kind.prefer?.length ? ` for ${kind.prefer.join(", ")}` : ""}`;
		const DISABLE = "Disable this kind";
		const TIER = "Change tier…";
		const options = [AUTO, ...pool.candidates.map((c) => `${c.label}  (${c.key})`), TIER, DISABLE];
		const choice = await ui.select(`${name}: ${kind.desc}`, options);
		if (!choice) continue;
		if (choice === AUTO) kindPatch[name] = { ...kindPatch[name], model: undefined, hardModel: undefined };
		else if (choice === DISABLE) kindPatch[name] = { ...kindPatch[name], enabled: false };
		else if (choice === TIER) {
			const tier = (await ui.select(`${name}: tier`, [...TIERS])) as Tier | undefined;
			if (tier) kindPatch[name] = { ...kindPatch[name], tier };
		} else {
			const c = pool.candidates[options.indexOf(choice) - 1];
			kindPatch[name] = { ...kindPatch[name], model: c.key, hardModel: c.key };
		}
	}
	if (Object.keys(kindPatch).length) patch.kinds = kindPatch;

	// ---- 4. Save --------------------------------------------------------------------------------
	const globalPath = globalConfigPath(deps.agentDir);
	const projectPath = projectConfigPath(ctx.cwd);
	const where = await ui.select("Step 4/4 · Save to", [`Everywhere  (${globalPath})`, `This project only  (${projectPath})`, BACK]);
	if (!where || where === BACK) return;
	const path = where.startsWith("Everywhere") ? globalPath : projectPath;
	await saveConfig(path, patch);
	await deps.reload();
	ui.notify(`Saved ${path}`, "info");

	if (!deps.autoSelected && (await ui.confirm("Switch to Auto now?", "Select the Auto model for this session."))) {
		if (!(await deps.switchToAuto())) ui.notify("Could not select auto/router", "warning");
	}
}
