import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cloudflareModule = new URL("../src/cloudflare.ts", import.meta.url).href;

async function exercise(options: { action?: "login"; fresh?: boolean; fail?: boolean; rejectFirst?: boolean; envToken?: boolean; missingCommand?: boolean } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "auto-router-cloudflare-")));
	const home = join(root, "home");
	const project = join(root, "workspace");
	const configDirectory = join(home, ".wrangler", "config");
	const configPath = join(configDirectory, "default.toml");
	const callsPath = join(root, "calls.jsonl");
	const commandPath = join(root, "wrangler.mjs");
	try {
		await mkdir(configDirectory, { recursive: true });
		await mkdir(project);
		await writeFile(join(project, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
		await writeFile(join(project, ".npmrc"), "node-linker=isolated\n");
		await writeFile(configPath, `oauth_token = "synthetic-old-token"\nexpiration_time = "${new Date(Date.now() + (options.fresh ? 3_600_000 : -3_600_000)).toISOString()}"\n`);
		await writeFile(commandPath, `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.TEST_CALLS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
if (process.cwd() !== process.env.HOME) {
	console.error("sh: wrangler: command not found in project workspace");
	process.exit(1);
}
if (process.env.TEST_FAIL === "1") {
	console.error("sh: wrangler: command not found");
	process.exit(1);
}
writeFileSync(process.env.TEST_CONFIG, 'oauth_token = "synthetic-refreshed-token"\\nexpiration_time = "' + new Date(Date.now() + 3_600_000).toISOString() + '"\\n');
`);
		const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
import { getToken, listAccounts, wranglerLogin } from ${JSON.stringify(cloudflareModule)};
const requests = [];
globalThis.fetch = async (_url, init) => {
	requests.push(init.headers.Authorization);
	if (${Boolean(options.rejectFirst)} && requests.length === 1) return new Response(null, { status: 401 });
	return Response.json({ result: [{ id: "synthetic-account", name: "Test account" }] });
};
try {
	const result = ${options.action === "login" ? "await wranglerLogin()" : "await listAccounts()"};
	const token = ${options.action === "login" ? "null" : "await getToken()"};
	console.log(JSON.stringify({ result, token, requests }));
} catch (error) {
	console.log(JSON.stringify({ error: error.message, causeCode: error.cause?.code, requests }));
}
`], {
			cwd: project,
			timeout: 10_000,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				WRANGLER_HOME: join(home, ".wrangler"),
				CLOUDFLARE_API_TOKEN: options.envToken ? "synthetic-env-token" : "",
				AUTO_ROUTER_WRANGLER: options.missingCommand ? join(root, "missing-wrangler") : `${process.execPath} ${commandPath}`,
				TEST_CALLS: callsPath,
				TEST_CONFIG: configPath,
				TEST_FAIL: options.fail ? "1" : "0",
			},
		});
		const calls = (await readFile(callsPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		return { ...JSON.parse(stdout), calls, home };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("expired Wrangler tokens refresh from home instead of the project workspace", async () => {
	const output = await exercise();
	assert.deepEqual(output.calls, [{ cwd: output.home, args: ["auth", "token", "--json"] }]);
	assert.deepEqual(output.requests, ["Bearer synthetic-refreshed-token"]);
	assert.equal(output.token.token, "synthetic-refreshed-token");
	assert.equal(output.token.source, "wrangler");
	assert.deepEqual(output.result, [{ id: "synthetic-account", name: "Test account" }]);
});

test("Wrangler login runs from home instead of the project workspace", async () => {
	const output = await exercise({ action: "login" });
	assert.equal(output.result, true);
	assert.deepEqual(output.calls, [{ cwd: output.home, args: ["login"] }]);
});

test("refresh failures report stderr without sending the expired token", async () => {
	const output = await exercise({ fail: true });
	assert.equal(output.error, "Could not refresh Wrangler OAuth token: sh: wrangler: command not found");
	assert.deepEqual(output.requests, []);
});

test("missing Wrangler commands retain execution diagnostics", async () => {
	const output = await exercise({ missingCommand: true });
	assert.match(output.error, /^Could not refresh Wrangler OAuth token: .*ENOENT/);
	assert.equal(output.causeCode, "ENOENT");
	assert.deepEqual(output.requests, []);
});

test("rejected fresh tokens force a refresh from home before retrying", async () => {
	const output = await exercise({ fresh: true, rejectFirst: true });
	assert.deepEqual(output.calls, [{ cwd: output.home, args: ["auth", "token", "--json"] }]);
	assert.deepEqual(output.requests, ["Bearer synthetic-old-token", "Bearer synthetic-refreshed-token"]);
	assert.equal(output.result[0].id, "synthetic-account");
});

test("refresh failures after token rejection stop retries and surface Wrangler diagnostics", async () => {
	const output = await exercise({ fresh: true, rejectFirst: true, fail: true });
	assert.equal(output.error, "Could not refresh Wrangler OAuth token: sh: wrangler: command not found");
	assert.deepEqual(output.requests, ["Bearer synthetic-old-token"]);
});

test("fresh Wrangler credentials do not need a command refresh", async () => {
	const output = await exercise({ fresh: true, fail: true });
	assert.deepEqual(output.calls, []);
	assert.deepEqual(output.requests, ["Bearer synthetic-old-token"]);
});

test("environment credentials bypass Wrangler", async () => {
	const output = await exercise({ envToken: true, fail: true });
	assert.deepEqual(output.calls, []);
	assert.deepEqual(output.requests, ["Bearer synthetic-env-token"]);
	assert.deepEqual(output.token, { token: "synthetic-env-token", source: "env" });
});
