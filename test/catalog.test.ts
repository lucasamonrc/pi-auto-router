import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CatalogModel, defaultPool, discover, familyOf, pick, tierFromCost, versionOf } from "../src/catalog.ts";

const catalog: CatalogModel[] = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));

test("versionOf", () => {
	assert.equal(versionOf("claude-opus-5-5"), 5.05);
	assert.equal(versionOf("claude-opus-5"), 5);
	assert.equal(versionOf("gpt-6.1-sol"), 6.01);
	assert.equal(versionOf("gpt-6-sol"), 6);
	assert.equal(versionOf("gemini-3.1-pro-preview"), 3.01);
	assert.equal(versionOf("@cf/zai-org/glm-5.3"), 5.03);
});

test("familyOf", () => {
	assert.equal(familyOf("gemini-3.5-flash-lite")?.key, "gemini-flash-lite");
	assert.equal(familyOf("gemini-3.8-flash")?.key, "gemini-flash");
	assert.equal(familyOf("@cf/moonshotai/kimi-k3")?.key, "kimi");
	assert.equal(familyOf("gpt-5-mini")?.key, "gpt-mini");
	assert.equal(familyOf("something-new"), undefined);
});

test("tierFromCost", () => {
	assert.equal(tierFromCost(0), "standard");
	assert.equal(tierFromCost(0.2), "light");
	assert.equal(tierFromCost(20), "frontier");
});

test("discover keeps the newest model per family", () => {
	const d = discover(catalog);
	const byFamily = Object.fromEntries(d.filter((c) => c.family).map((c) => [c.family, c.id]));
	assert.equal(byFamily.opus, "claude-opus-5-5");
	assert.equal(byFamily.sonnet, "claude-sonnet-5-5");
	assert.equal(byFamily.sol, "gpt-6.1-sol");
	assert.equal(byFamily.luna, "gpt-6-luna");
	assert.equal(byFamily.fable, "claude-fable-5-1");
	assert.ok(!d.some((c) => /customtools|-0731|latest/.test(c.id)), "excludes snapshots and aliases");
	assert.ok(!d.some((c) => c.provider === "auto"), "excludes virtual models");
});

test("default pool is the well-known families only", () => {
	const pool = defaultPool(discover(catalog));
	const families = pool.map((c) => c.family).sort();
	assert.deepEqual(families, ["fable", "gemini-flash", "gemini-pro", "haiku", "luna", "opus", "sol", "sonnet", "terra"]);
});

// The author's pool: Sol 6, Fable 5.1, Opus 5.5, Sonnet 5.5, Luna 6.
const mine = discover(catalog).filter((c) => ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna"].includes(c.id));
const sol6 = catalog.find((m) => m.id === "gpt-6-sol")!;
import { toCandidate } from "../src/catalog.ts";
mine.push(toCandidate(sol6));

test("pick: task fit, then cost", () => {
	const id = (n: Parameters<typeof pick>[1]) => pick(mine, n)?.id;
	assert.equal(id({ tier: "light" }), "gpt-6-luna");
	assert.equal(id({ tier: "standard", prefer: ["feature"] }), "claude-sonnet-5-5");
	assert.equal(id({ tier: "strong", prefer: ["frontend"] }), "claude-opus-5-5");
	assert.equal(id({ tier: "strong", prefer: ["debugging"] }), "gpt-6-sol");
	assert.equal(id({ tier: "strong", prefer: ["architecture"] }), "claude-opus-5-5");
	assert.equal(id({ tier: "frontier", prefer: ["architecture"] }), "claude-fable-5-1");
	assert.equal(id({ tier: "strong", prefer: ["long_context"], minContext: 600_000 }), "claude-fable-5-1");
});

test("pick: goes up a tier before going down", () => {
	const noStandard = mine.filter((c) => c.tier !== "standard");
	assert.equal(pick(noStandard, { tier: "standard" })?.tier, "strong");
});

import { modelForKind } from "../src/router.ts";
import { DEFAULT_KINDS } from "../src/config.ts";

test("kind mapping for the author's pool (normal / hard)", () => {
	const pool = { candidates: mine, discovered: mine, missing: [] };
	const map = Object.fromEntries(
		Object.entries(DEFAULT_KINDS).map(([k, kind]) => [k, [modelForKind(kind, false, pool, false)?.id, modelForKind(kind, true, pool, false)?.id]]),
	);
	assert.deepEqual(map, {
		question: ["gpt-6-luna", "claude-sonnet-5-5"],
		small_change: ["gpt-6-luna", "claude-sonnet-5-5"],
		feature: ["claude-sonnet-5-5", "claude-opus-5-5"],
		frontend: ["claude-opus-5-5", "claude-opus-5-5"],
		debugging: ["gpt-6-sol", "gpt-6-sol"],
		architecture: ["claude-opus-5-5", "claude-fable-5-1"],
		large_context: ["claude-fable-5-1", "claude-fable-5-1"],
		writing: ["claude-sonnet-5-5", "claude-opus-5-5"],
	});
});
