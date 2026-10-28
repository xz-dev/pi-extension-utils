// Packed production-only install of pi-extension-utils, then a stock Pi host
// selected by the manifest creates a full private fork through `pi-extension-utils/
// private-inquiry` and receives one file-only result. No developer checkout
// import, no public pi-subagents, no bundled duplicate SDK.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
// npm is npm.cmd on Windows, which execFile cannot start; run npm's own CLI script via node.
const npm = (args, options) =>
	process.env.npm_execpath
		? execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options)
		: execFileAsync("npm", args, options);

const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/var/tmp", "piu-private-packed-"));
try {
	const packDir = join(root, "pack");
	const installRoot = join(root, "install");
	await Promise.all([mkdir(packDir, { recursive: true }), mkdir(installRoot, { recursive: true })]);
	await npm(["run", "build:dist"], { cwd: repoRoot, timeout: 120_000 });
	const { stdout } = await npm(["pack", "--json", "--pack-destination", packDir], {
		cwd: repoRoot,
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
	const tarball = join(packDir, JSON.parse(stdout)[0].filename);
	await npm(["init", "-y"], { cwd: installRoot, timeout: 30_000 });
	// Production-only install: lifecycle scripts run (postinstall prepares the
	// private runtime); the Git dependency is transitive to this temp root.
	await npm([
			"install",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--allow-git=all",
			tarball,
			`@earendil-works/pi-coding-agent@${manifest.devDependencies["@earendil-works/pi-coding-agent"]}`,
		],
		{ cwd: installRoot, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
	);
	const packageDir = join(installRoot, "node_modules", "pi-extension-utils");
	const privateDir = join(installRoot, "node_modules", "private-inquiry-subagents-runtime");
	const nestedPrivateDir = join(packageDir, "node_modules", "private-inquiry-subagents-runtime");
	const runtimeDir = await access(nestedPrivateDir).then(() => nestedPrivateDir, () => privateDir);
	const metadata = JSON.parse(await readFile(join(runtimeDir, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(metadata.exports), ["./watchdog-runtime"], "prepared private entry only");
	assert.equal(metadata.pi, undefined, "no public Pi discovery metadata");
	await assert.rejects(access(join(installRoot, "node_modules", "pi-subagents")), "no public pi-subagents");
	for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
		await assert.rejects(access(join(packageDir, "node_modules", "@earendil-works", name)), `no duplicate ${name}`);
		await assert.rejects(access(join(runtimeDir, "node_modules", "@earendil-works", name)), `no duplicate ${name}`);
	}

	const host = join(installRoot, "host.mjs");
	await writeFile(
		host,
		`
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureAnchor, createPrivateRuntime, runPrivateInquiry } from "pi-extension-utils/private-inquiry";

const cwd = await mkdtemp(join(process.env.PIU_TMP, "piu-private-host-"));
const models = await ModelRuntime.create({ modelsPath: null });
let requests = 0;
models.registerProvider("piu-test", {
  baseUrl: "http://127.0.0.1:1", apiKey: "k", api: "openai-completions",
  streamSimple: (model, context) => {
    requests++;
    const serialized = JSON.stringify(context.messages);
    // The marker holds a JSON string inside serialized JSON; Windows paths contain backslashes.
    const marker = serialized.match(/<private_inquiry_result_file>(.*?)<\\/private_inquiry_result_file>/)?.[1];
    const file = marker === undefined ? undefined : JSON.parse(JSON.parse('"' + marker + '"'));
    const answered = serialized.includes('"role":"toolResult"');
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const base = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), usage };
    // Stateful: one write call, then (only if the host ever continued) plain text.
    const message = !answered && file
      ? { ...base, content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: file, content: JSON.stringify({ answer: "forty-two" }) } }], stopReason: "toolUse" }
      : { ...base, content: [{ type: "text", text: "done" }], stopReason: "stop" };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "done", reason: message.stopReason, message }); });
    return stream;
  },
  models: [{ id: "local", name: "L", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
});
const parent = SessionManager.create(cwd, join(cwd, "sessions"));
const ts = Date.now() - 1000;
// A real Pi session persists its system state; the private fork inherits it.
parent.appendMessage({ role: "system", content: "Parent instructions", timestamp: ts });
parent.appendMessage({ role: "user", content: "Parent task", timestamp: ts });
parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Parent reply" }], stopReason: "stop", provider: "piu-test", api: "openai-completions", model: "local", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
const runtime = await createPrivateRuntime();
try {
  const result = await runPrivateInquiry({
    runtime,
    fork: { parent, parentProviderRegistry: models, cwd, model: "piu-test/local", retryPolicy: "disabled", anchorId: captureAnchor(parent) },
    isCurrent: () => true,
    validate: (payload) => payload && typeof payload.answer === "string" ? { valid: true, value: payload.answer } : { valid: false, error: "answer required" },
    prompt: () => "Answer privately.",
    correction: (error) => "Fix: " + error,
  });
  console.log(JSON.stringify({ result, requests }));
} finally {
  runtime.dispose();
}
`,
	);
	const { stdout: hostOut } = await execFileAsync(process.execPath, ["--import", "tsx", host], {
		cwd: installRoot,
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, NODE_PATH: "", PIU_TMP: process.platform === "win32" ? tmpdir() : "/var/tmp" },
	}).catch(async (error) => {
		// tsx is a dev dependency of the checkout, not of the production install.
		if (!String(error.stderr ?? error).includes("Cannot find package 'tsx'")) throw error;
		await npm(["install", "--no-save", "--no-audit", "--no-fund", "tsx"], { cwd: installRoot, timeout: 120_000 });
		return execFileAsync(process.execPath, ["--import", "tsx", host], { cwd: installRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PIU_TMP: process.platform === "win32" ? tmpdir() : "/var/tmp" } });
	});
	const parsed = JSON.parse(hostOut.trim().split("\n").at(-1));
	assert.equal(parsed.result.kind, "decision", JSON.stringify(parsed));
	assert.equal(parsed.result.decision, "forty-two");
	assert.equal(parsed.requests, 1, "file-only result: no post-write acknowledgement request");
	assert.equal(parsed.result.session?.kind, "available", "additive session evidence metadata");
	assert.match(parsed.result.session?.path ?? "", /[\\/]forks[\\/]/, "real native fork locator");
	console.log(JSON.stringify({ ok: true, packed: JSON.parse(stdout)[0].filename, result: parsed.result.kind, session: parsed.result.session.kind, requests: parsed.requests }));
} finally {
	await rm(root, { recursive: true, force: true });
}
