/**
 * Cloudflare credentials for Clef on Workers AI.
 *
 * Token, in order:
 *   1. CLOUDFLARE_API_TOKEN (needs Workers AI read/run)
 *   2. Wrangler OAuth login (read from wrangler's config; refreshed with `wrangler auth token`)
 * Account, in order: config `accountId`, CLOUDFLARE_ACCOUNT_ID, the only account the token can see.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";

const WRANGLER_CONFIGS = [
	process.env.WRANGLER_HOME ? join(process.env.WRANGLER_HOME, "config/default.toml") : "",
	join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
	join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".wrangler/config/default.toml"),
	join(homedir(), ".wrangler/config/default.toml"),
].filter(Boolean);

function wranglerCommand(): [string, string[]] {
	const [cmd, ...args] = (process.env.AUTO_ROUTER_WRANGLER ?? "npx --yes wrangler").split(/\s+/);
	return [cmd, args];
}

export type TokenSource = "env" | "wrangler";

let cached: { token: string; expires: number; source: TokenSource } | undefined;

async function readWranglerToken(): Promise<{ token: string; expires: number } | undefined> {
	for (const path of WRANGLER_CONFIGS) {
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (!text) continue;
		const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
		const exp = text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1];
		if (token) return { token, expires: exp ? Date.parse(exp) : 0 };
	}
	return undefined;
}

export async function hasWranglerLogin(): Promise<boolean> {
	return (await readWranglerToken()) !== undefined;
}

/** `wrangler auth token` refreshes the OAuth token in wrangler's config file. */
async function refreshWrangler(): Promise<void> {
	const [cmd, args] = wranglerCommand();
	try {
		await execFileAsync(cmd, [...args, "auth", "token", "--json"], { timeout: 60_000, cwd: homedir() });
	} catch (error) {
		const failure = error as Error & { stderr?: string };
		throw new Error(`Could not refresh Wrangler OAuth token: ${failure.stderr?.trim() || failure.message}`, { cause: error });
	}
}

export async function getToken(forceRefresh = false): Promise<{ token: string; source: TokenSource }> {
	const env = process.env.CLOUDFLARE_API_TOKEN;
	if (env) return { token: env, source: "env" };
	const now = Date.now();
	if (!forceRefresh && cached && cached.expires - now > 60_000) return cached;
	if (!forceRefresh) {
		const t = await readWranglerToken();
		if (t && t.expires - now > 60_000) return (cached = { ...t, source: "wrangler" });
	}
	await refreshWrangler();
	const t = await readWranglerToken();
	if (!t) throw new Error("Not logged in to Cloudflare. Run /route setup (or `npx wrangler login`).");
	return (cached = { ...t, source: "wrangler" });
}

/** Run `wrangler login` (opens the browser) and wait for it to finish. */
export function wranglerLogin(): Promise<boolean> {
	const [cmd, args] = wranglerCommand();
	return new Promise((resolve) => {
		const child = spawn(cmd, [...args, "login"], { stdio: "ignore", cwd: homedir() });
		const timer = setTimeout(() => child.kill(), 300_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			cached = undefined;
			resolve(code === 0);
		});
		child.on("error", () => resolve(false));
	});
}

export interface Account {
	id: string;
	name: string;
}

export async function listAccounts(): Promise<Account[]> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const { token } = await getToken(attempt > 0);
		const res = await fetch(`${API}/accounts?per_page=50`, { headers: { Authorization: `Bearer ${token}` } });
		if (res.status === 401 || res.status === 403) continue;
		const json = (await res.json()) as { result?: Account[] };
		return (json.result ?? []).map((a) => ({ id: a.id, name: a.name }));
	}
	throw new Error("Cloudflare rejected the token.");
}

let detectedAccount: Promise<string> | undefined;

export async function resolveAccountId(configured?: string): Promise<string> {
	if (configured) return configured;
	if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
	detectedAccount ??= listAccounts().then((accounts) => {
		if (accounts.length === 1) return accounts[0].id;
		detectedAccount = undefined;
		throw new Error(
			accounts.length
				? `Your login can see ${accounts.length} Cloudflare accounts. Pick one with /route setup.`
				: "No Cloudflare account found for this login.",
		);
	});
	return detectedAccount;
}

/** POST to Workers AI with automatic token refresh on 401/403. */
export async function runWorkersAI(
	accountId: string,
	model: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const url = `${API}/accounts/${accountId}/ai/run/${model}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		const { token, source } = await getToken(attempt > 0);
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if ((res.status === 401 || res.status === 403) && source === "wrangler" && attempt === 0) continue;
		const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { message: string }[] };
		if (!res.ok || !json.success) {
			const msg = json.errors?.map((e) => e.message).join("; ") || res.statusText;
			throw new Error(`Workers AI ${res.status}: ${msg}`);
		}
		return json.result;
	}
	throw new Error("Cloudflare rejected the token.");
}
