import { tmpdir } from "node:os";
/**
 * Real stock Pi 1.3.0 conformance for the read-only evidence profile and
 * immediate cancellation, through the prepared private runtime and the moved
 * core. A stateful synthetic provider scripts each child request; only the
 * private fork's own tools execute.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import {
	captureAnchor,
	createPrivateRuntime,
	type ExecutionProfile,
	type PrivateRuntime,
	runPrivateInquiry,
} from "../src/private-inquiry.js";

// POSIX: /var/tmp (not a RAM-backed /tmp); elsewhere the OS temp dir.
const TEST_TMP = process.platform === "win32" ? tmpdir() : "/var/tmp";

type Call = { readonly name: string; readonly arguments: Record<string, string | number> };
/** One scripted child response: tool calls, plain text, or a slow stream. */
type Step =
	| { readonly calls: readonly Call[] }
	| { readonly text: string }
	| { readonly hang: true };

interface Harness {
	readonly cwd: string;
	readonly runtime: PrivateRuntime;
	readonly models: ModelRuntime;
	readonly parent: SessionManager;
	readonly requests: Array<{ readonly toolResults: string[] }>;
	readonly streamAborted: () => boolean;
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function harness(t: TestContext, script: (request: number, resultFile: string) => Step): Promise<Harness> {
	const cwd = await mkdtemp(join(TEST_TMP, "piu-evidence-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "notes.txt"), "the secret evidence token is AMBER-42\n");
	const models = await ModelRuntime.create({ modelsPath: null });
	const requests: Array<{ toolResults: string[] }> = [];
	let aborted = false;
	let resultFile = "";
	let callSeq = 0;
	models.registerProvider("piu-test", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "k",
		api: "openai-completions",
		streamSimple: (model, context, options) => {
			const messages = context.messages as Array<{ role: string; content?: unknown }>;
			const serialized = JSON.stringify(messages);
			// The marker holds a JSON string inside serialized JSON; Windows paths contain backslashes.
			const marker = serialized.match(/<private_inquiry_result_file>(.*?)<\/private_inquiry_result_file>/)?.[1];
			resultFile = marker === undefined ? resultFile : JSON.parse(JSON.parse(`"${marker}"`));
			const toolResults = messages
				.filter((message) => message.role === "toolResult")
				.map((message) => JSON.stringify(message.content));
			requests.push({ toolResults });
			const step = script(requests.length, resultFile);
			const base = { role: "assistant" as const, provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), usage };
			const stream = createAssistantMessageEventStream();
			if ("hang" in step) {
				// Slow provider: streams nothing until aborted.
				const partial = { ...base, content: [], stopReason: "stop" as const };
				queueMicrotask(() => stream.push({ type: "start", partial }));
				options?.signal?.addEventListener("abort", () => {
					aborted = true;
					const message = { ...base, content: [], stopReason: "aborted" as const, errorMessage: "aborted" };
					stream.push({ type: "error", reason: "aborted", error: message });
				}, { once: true });
				return stream;
			}
			const message = "calls" in step
				? { ...base, stopReason: "toolUse" as const, content: step.calls.map((call) => ({ type: "toolCall" as const, id: `c${++callSeq}`, name: call.name, arguments: call.arguments })) }
				: { ...base, stopReason: "stop" as const, content: [{ type: "text" as const, text: step.text }] };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
		models: [{ id: "local", name: "L", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
	});
	const parent = SessionManager.create(cwd, join(cwd, "sessions"));
	const ts = Date.now() - 1000;
	parent.appendMessage({ role: "system", content: "Parent instructions", timestamp: ts } as never);
	parent.appendMessage({ role: "user", content: "Parent task", timestamp: ts });
	const runtime = await createPrivateRuntime();
	t.after(() => runtime.dispose());
	return { cwd, runtime, models, parent, requests, streamAborted: () => aborted };
}

function inquire(h: Harness, profile: ExecutionProfile | undefined, signal?: AbortSignal) {
	return runPrivateInquiry<string>({
		runtime: h.runtime,
		fork: {
			parent: h.parent,
			parentProviderRegistry: h.models,
			cwd: h.cwd,
			model: "piu-test/local",
			retryPolicy: "native",
			anchorId: captureAnchor(h.parent),
			...(profile === undefined ? {} : { profile }),
		},
		...(signal === undefined ? {} : { signal }),
		isCurrent: () => true,
		validate: (payload) =>
			typeof payload === "object" && payload !== null && typeof (payload as { answer?: unknown }).answer === "string"
				? { valid: true, value: (payload as { answer: string }).answer }
				: { valid: false, error: "answer required" },
		prompt: () => "Investigate, then write the result file.",
		correction: (error) => `Fix: ${error}`,
	});
}

const writeCall = (file: string, answer: string): Call => ({ name: "write", arguments: { path: file, content: JSON.stringify({ answer }) } });
const write = (file: string, answer: string): Step => ({ calls: [writeCall(file, answer)] });
const EVIDENCE: ExecutionProfile = { kind: "read-only-evidence" };

test("evidence helpers execute in the child and do not consume terminal attempts", { timeout: 60_000 }, async (t) => {
	const h = await harness(t, (n, file) =>
		n === 1 ? { calls: [{ name: "read", arguments: { path: "notes.txt" } }, { name: "ls", arguments: { path: "." } }] }
			: n === 2 ? { calls: [{ name: "grep", arguments: { pattern: "AMBER", path: "." } }, { name: "find", arguments: { pattern: "*.txt", path: "." } }] }
				: n === 3 ? write(file, "AMBER-42")
					: { text: "unexpected" });
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(result.kind === "decision" && result.decision, "AMBER-42");
	assert.equal(h.requests.length, 3, "two helper turns + one write; no post-write request");
	// The read and grep actually ran inside the private child.
	assert.match(h.requests[1]!.toolResults.join("\n"), /AMBER-42/);
	assert.match(h.requests[2]!.toolResults.join("\n"), /notes\.txt/);
});

test("write-only profile rejects helpers before any effect", { timeout: 60_000 }, async (t) => {
	const h = await harness(t, (n, file) =>
		n === 1 ? { calls: [{ name: "read", arguments: { path: "notes.txt" } }] } : write(file, "ok"));
	const result = await inquire(h, undefined);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(h.requests.length, 2, "rejected helper = one consumed attempt, then corrected");
	assert.doesNotMatch(h.requests[1]!.toolResults.join("\n"), /AMBER-42/, "the read never executed");
});

test("mixed helper+write and unknown-tool batches execute nothing", { timeout: 60_000 }, async (t) => {
	const h = await harness(t, (n, file) =>
		n === 1 ? { calls: [{ name: "read", arguments: { path: "notes.txt" } }, writeCall(file, "too-early")] }
			: n === 2 ? { calls: [{ name: "bash", arguments: { command: "echo pwned > pwned.txt" } }] }
				: write(file, "final"));
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(result.kind === "decision" && result.decision, "final", "the mixed batch's write never landed");
	assert.equal(h.requests.length, 3);
	for (const request of h.requests) assert.doesNotMatch(request.toolResults.join("\n"), /AMBER-42/);
});

test("one operation-wide helper budget: an over-budget batch is rejected whole", { timeout: 60_000 }, async (t) => {
	const read = (i: number): Call => ({ name: "read", arguments: { path: "notes.txt", offset: i } });
	const h = await harness(t, (n, file) =>
		n === 1 ? { calls: [read(1), read(2), read(3), read(4), read(5), read(6), read(7), read(8)] }
			: n === 2 ? { calls: [read(9), read(10), read(11)] } // 8 + 3 > 10
				: write(file, "bounded"));
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(h.requests.length, 3);
	assert.equal(h.requests[2]!.toolResults.length, 8, "only the first eight admitted reads produced results");
});

test("duplicate evidence calls in one response are rejected", { timeout: 60_000 }, async (t) => {
	const dup: Call = { name: "read", arguments: { path: "notes.txt" } };
	const h = await harness(t, (n, file) => (n === 1 ? { calls: [dup, dup] } : write(file, "deduped")));
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(h.requests[1]!.toolResults.length, 0, "nothing executed");
});

test("the child's result write never follows a link that replaced the result file", { timeout: 60_000 }, async (t) => {
	const fs = await import("node:fs");
	let target = "";
	const h = await harness(t, (n, file) => {
		if (n === 1) {
			// Outside the owned temp dir, which cleanup removes.
			target = join(h.cwd, "outside.txt");
			fs.writeFileSync(target, "untouched");
			fs.rmSync(file);
			fs.symlinkSync(target, file);
		}
		return write(file, "redirected");
	});
	const result = await inquire(h, undefined);
	assert.equal(result.kind, "execution-error", JSON.stringify(result));
	assert.equal(fs.readFileSync(target, "utf8"), "untouched");
	assert.equal(h.requests.length, 1, "no retry after a host file failure");
});

test("abort during a provider stream settles cancelled promptly", { timeout: 60_000 }, async (t) => {
	const h = await harness(t, () => ({ hang: true }));
	const controller = new AbortController();
	const pending = inquire(h, EVIDENCE, controller.signal);
	while (h.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
	const started = performance.now();
	controller.abort();
	const result = await pending;
	const elapsed = performance.now() - started;
	assert.equal(result.kind, "cancelled");
	assert.equal(h.streamAborted(), true, "the provider request itself was aborted");
	assert.ok(elapsed < 1000, `settled in ${elapsed.toFixed(0)}ms`);
	assert.equal(h.requests.length, 1, "no further provider call after abort");
});

// The shadow rg is a POSIX shell script, which Windows cannot execute.
test("abort during a slow grep subprocess kills it and settles promptly", { timeout: 60_000, skip: process.platform === "win32" }, async (t) => {
	// Shadow ripgrep with a slow script inside an isolated agent bin dir.
	const agentDir = await mkdtemp(join(TEST_TMP, "piu-evidence-agent-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const marker = join(agentDir, "rg.pid");
	await mkdir(join(agentDir, "bin"), { recursive: true });
	await writeFile(join(agentDir, "bin", "rg"), `#!/bin/sh\necho $$ > ${marker}\nexec sleep 30\n`);
	await chmod(join(agentDir, "bin", "rg"), 0o755);
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	// getBinDir() is read at SDK module load: run this scenario in a fresh process.
	const child = promisify(execFile)(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "--test-name-pattern=^grep-abort-scenario$", import.meta.filename], {
		// Drop the parent test runner's context so the child reports its own TAP.
		env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")), PI_CODING_AGENT_DIR: agentDir, PIU_GREP_ABORT_SCENARIO: marker },
		timeout: 50_000,
	});
	const { stdout } = await child;
	assert.match(stdout, /# pass 1/);
	assert.match(stdout, /# fail 0/);
});

if (process.env.PIU_GREP_ABORT_SCENARIO !== undefined) {
	test("grep-abort-scenario", { timeout: 40_000 }, async (t) => {
		const marker = process.env.PIU_GREP_ABORT_SCENARIO!;
		const { readFile } = await import("node:fs/promises");
		const h = await harness(t, () => ({ calls: [{ name: "grep", arguments: { pattern: "AMBER", path: "." } }] }));
		const controller = new AbortController();
		const pending = inquire(h, EVIDENCE, controller.signal);
		let pid = 0;
		for (let i = 0; i < 400 && pid === 0; i++) {
			pid = Number((await readFile(marker, "utf8").catch(() => "")).trim()) || 0;
			if (pid === 0) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(pid > 0, "slow rg subprocess started");
		const started = performance.now();
		controller.abort();
		const result = await pending;
		const elapsed = performance.now() - started;
		assert.equal(result.kind, "cancelled");
		assert.ok(elapsed < 1000, `settled in ${elapsed.toFixed(0)}ms`);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => process.kill(pid, 0), "the rg subprocess is dead");
		assert.equal(h.requests.length, 1, "no further provider call after abort");
	});
}
