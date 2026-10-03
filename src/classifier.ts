/**
 * One classifier interface over two backends:
 *  - Clef / Clef-flash on Cloudflare Workers AI (default)
 *  - any classifier model pi knows, e.g. "typesafe/jev-latest" or "openrouter/typesafe/jev-1.13"
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAccountId, runWorkersAI } from "./cloudflare.ts";

export type Question =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type Answer =
	| { type: "choice"; choice: string; probabilities: Record<string, number> }
	| { type: "score"; score: number }
	| { type: "bool"; probability: number };

export interface ClassifierSpec {
	classifier: string;
	accountId?: string;
	timeoutMs: number;
}

const CLEF_MODELS: Record<string, string> = {
	clef: "@cf/cloudflare/clef",
	"clef-flash": "@cf/cloudflare/clef-flash",
};

export const isClef = (classifier: string) => classifier in CLEF_MODELS;

export function classifierLabel(classifier: string): string {
	return classifier === "clef" ? "Clef" : classifier === "clef-flash" ? "Clef-flash" : classifier;
}

export async function classify(
	spec: ClassifierSpec,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Record<string, Answer>> {
	const timeout = AbortSignal.timeout(spec.timeoutMs);
	const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return isClef(spec.classifier) ? clef(spec, state, questions, sig) : viaPi(spec, state, questions, ctx, sig);
}

async function clef(
	spec: ClassifierSpec,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
	signal: AbortSignal,
): Promise<Record<string, Answer>> {
	const accountId = await resolveAccountId(spec.accountId);
	const qs = Object.fromEntries(
		Object.entries(questions).map(([id, q]) => [
			id,
			// Clef calls yes/no questions "noul" and takes no criteria for them.
			q.type === "bool" ? { type: "noul", instructions: `${q.instructions} (yes: ${q.criteria.true})` } : q,
		]),
	);
	const result = (await runWorkersAI(accountId, CLEF_MODELS[spec.classifier], { model: spec.classifier, state, questions: qs }, signal)) as {
		answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number>; score?: number; noul?: number }>;
	};
	const out: Record<string, Answer> = {};
	for (const [id, a] of Object.entries(result.answers)) {
		if (a.type === "choice") out[id] = { type: "choice", choice: a.choice!, probabilities: a.probabilities ?? {} };
		else if (a.type === "score") out[id] = { type: "score", score: a.score ?? 0 };
		else if (a.type === "noul") out[id] = { type: "bool", probability: a.noul ?? 0 };
	}
	return out;
}

async function viaPi(
	spec: ClassifierSpec,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<Record<string, Answer>> {
	const slash = spec.classifier.indexOf("/");
	const provider = spec.classifier.slice(0, slash);
	const id = spec.classifier.slice(slash + 1);
	const model = ctx.modelRegistry.findOfType("classifier", provider, id);
	if (!model) throw new Error(`Classifier ${spec.classifier} is not in pi's catalog`);
	const result = await ctx.modelRegistry.classify(
		model,
		{ state, questions } as Parameters<typeof ctx.modelRegistry.classify>[1],
		{ signal },
	);
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Classifier ${result.stopReason}`);
	const out: Record<string, Answer> = {};
	for (const [qid, a] of Object.entries(result.answers)) {
		if (a.type === "choice") out[qid] = { type: "choice", choice: a.choice, probabilities: a.probabilities };
		else if (a.type === "score") out[qid] = { type: "score", score: a.score };
		else if (a.type === "bool") out[qid] = { type: "bool", probability: a.probability };
	}
	return out;
}
