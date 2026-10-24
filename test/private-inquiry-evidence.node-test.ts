import { tmpdir } from "node:os";
/**
 * Real stock Pi 1.3.0 conformance for the read-only evidence profile and
 * immediate cancellation, through the prepared private runtime and the moved
 * core. A stateful synthetic provider scripts each child request; only the
 * private fork's own tools execute.
 */
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ExtensionRunner, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

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
	readonly requests: Array<{ readonly toolResults: string[]; readonly serialized: string }>;
	readonly streamAborted: () => boolean;
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function harness(t: TestContext, script: (request: number, resultFile: string) => Step): Promise<Harness> {
	const cwd = await mkdtemp(join(TEST_TMP, "piu-evidence-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "notes.txt"), "the secret evidence token is AMBER-42\n");
	const models = await ModelRuntime.create({ modelsPath: null });
	const requests: Array<{ toolResults: string[]; serialized: string }> = [];
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
			requests.push({ toolResults, serialized });
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

test("a failed inquiry retains the real fork JSONL at its advertised path", { timeout: 60_000 }, async (t) => {
	// Three provider replies never write the result file: the correction
	// allowance is exhausted and the logical inquiry ends decision-failed.
	const h = await harness(t, () => ({ text: "I refuse to write." }));
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision-failed", JSON.stringify(result));
	assert.equal(h.requests.length, 3, "three consumed responses, none extra");
	const session = result.session;
	assert.equal(session?.kind, "available", JSON.stringify(result.session));
	if (session?.kind !== "available") return;
	assert.equal(isAbsolute(session.path), true, "full copyable absolute path");
	assert.match(session.path, /forks\//, "real native fork location, not the temp result dir");
	// Settlement and disposal already happened: the file is still there,
	// regular, readable, and holds the failed child's own persisted history.
	assert.equal((await stat(session.path)).isFile(), true);
	await access(session.path);
	const persisted = await readFile(session.path, "utf8");
	assert.match(persisted, /I refuse to write\./, "own replies persisted");
	assert.match(persisted, /private_inquiry_result_file/, "inquiry prompt persisted");
});

test("setup failure after fork creation preserves the real session locator", { timeout: 60_000 }, async (t) => {
	// A parent with no inheritable system state fails inside fork() AFTER the
	// native fork JSONL already exists: the typed error must carry that file.
	const { WatchdogForkSetupError } = await import("private-inquiry-subagents-runtime/watchdog-runtime");
	const h = await harness(t, () => ({ text: "unused" }));
	const bareParent = SessionManager.create(h.cwd, join(h.cwd, "sessions2"));
	bareParent.appendMessage({ role: "user", content: "no system state", timestamp: Date.now() } as never);
	try {
		await h.runtime.fork({
			parent: bareParent,
			parentProviderRegistry: h.models,
			cwd: h.cwd,
			agentDir: await mkdtemp(join(TEST_TMP, "piu-evidence-agent-")),
			resultFile: join(await mkdtemp(join(TEST_TMP, "piu-evidence-result-")), "result.json"),
			model: "piu-test/local",
			retryPolicy: "native",
			anchorId: captureAnchor(bareParent),
		});
		assert.fail("fork should fail without inheritable system state");
	} catch (error) {
		assert.ok(error instanceof WatchdogForkSetupError, `expected typed setup error, got ${error}`);
		const file = (error as InstanceType<typeof WatchdogForkSetupError>).sessionFile;
		assert.equal(isAbsolute(file), true);
		assert.match(file, /forks\//);
		assert.equal((await stat(file)).isFile(), true, "the retained fork JSONL exists");
		assert.match(await readFile(file, "utf8"), /no system state/, "fork persisted parent history");
		// And the shared core surfaces that same locator as available evidence.
		const result = await runPrivateInquiry<string>({
			runtime: {
				fork: () => Promise.reject(error),
				dispose: () => {},
			},
			fork: {
				parent: h.parent,
				parentProviderRegistry: h.models,
				cwd: h.cwd,
				model: "piu-test/local",
				retryPolicy: "native",
			},
			isCurrent: () => true,
			validate: () => ({ valid: false, error: "unused" }),
			prompt: () => "unused",
			correction: () => "unused",
		});
		assert.equal(result.kind, "execution-error");
		assert.deepEqual(result.session, { kind: "available", path: file });
	}
});

test("context_with_system hook applies the fork projection without extension errors", { timeout: 60_000 }, async (t) => {
	// The SDK swallows hook errors and continues with untransformed messages;
	// capture ExtensionRunner.emitError so a swallowed context_with_system
	// fault cannot produce a false green.
	const emitted: Array<{ event?: unknown; error?: unknown }> = [];
	const originalEmit = ExtensionRunner.prototype.emitError;
	ExtensionRunner.prototype.emitError = function (error) {
		emitted.push(error as { event?: unknown; error?: unknown });
		return originalEmit.call(this, error);
	};
	t.after(() => {
		ExtensionRunner.prototype.emitError = originalEmit;
	});
	const h = await harness(t, (n, file) => (n === 1 ? write(file, "projected") : { text: "unexpected" }));
	let result;
	try {
		result = await inquire(h, EVIDENCE);
	} finally {
		ExtensionRunner.prototype.emitError = originalEmit;
	}
	assert.equal(result!.kind, "decision", JSON.stringify(result));
	assert.equal(result!.kind === "decision" && result!.decision, "projected");
	assert.equal(h.requests.length, 1);
	const hookErrors = emitted.filter(
		(e) => e.event === "context_with_system" || String(e.error ?? "").includes("forkedAt"),
	);
	assert.deepEqual(hookErrors, [], `swallowed context hook errors: ${JSON.stringify(emitted)}`);
	// The fork projection actually ran: inherited parent system state is in
	// the outgoing request, while the child's own generated preamble/rules
	// are not leaked into the provider request.
	const sent = h.requests[0]!.serialized;
	assert.match(sent, /Parent instructions/, "inherited parent system state projected");
	assert.match(sent, /Parent task/, "inherited conversation projected");
	// projectForkRequest ran: the request carries the parent's system prefix
	// plus the folded subagent_instructions block, not the child's own
	// generated preamble/rules/docs sections as top-level system entries.
	assert.match(sent, /subagent_instructions/, "fork projection applied");
	assert.doesNotMatch(sent, /"preamble":/, "no child-generated system prompt sections");
});

test("a post-create resolver failure keeps the real restored fork locator", { timeout: 60_000 }, async (t) => {
	// Fault window: native createBranchedSession() returned, then the
	// resolver's post-create inspection throws before prepare completes.
	// Simulated through SessionManager.open: after the real fork is created
	// the file is moved aside (existsSync fails → fallback path), and the
	// first fallback getHeader() restores it and throws the injected EIO.
	const fs = await import("node:fs");
	const originalOpen = SessionManager.open;
	let injected = 0;
	SessionManager.open = function (this: unknown, ...args: unknown[]) {
		const manager = Reflect.apply(originalOpen, this, args) as SessionManager;
		const create = manager.createBranchedSession.bind(manager);
		const realGetHeader = manager.getHeader?.bind(manager);
		let state: { file: string; backup: string } | undefined;
		return Object.assign(manager, {
			createBranchedSession: (leafId: string) => {
				const file = create(leafId);
				if (file !== undefined && injected === 0) {
					injected++;
					const backup = `${file}.eio-backup`;
					fs.renameSync(file, backup);
					state = { file, backup };
				}
				return file;
			},
			getHeader: () => {
				if (state !== undefined) {
					// Restore the real fork content, then fail the inspection.
					fs.renameSync(state.backup, state.file);
					state = undefined;
					const error = new Error("INJECTED_FORK_READ_EIO") as NodeJS.ErrnoException;
					error.code = "EIO";
					throw error;
				}
				return realGetHeader?.();
			},
		});
	} as typeof SessionManager.open;
	t.after(() => {
		SessionManager.open = originalOpen;
	});
	const h = await harness(t, () => ({ text: "unused" }));
	let result;
	try {
		result = await inquire(h, EVIDENCE);
	} finally {
		SessionManager.open = originalOpen;
	}
	assert.equal(injected, 1, "the injected post-create fault actually fired");
	assert.equal(result!.kind, "execution-error", JSON.stringify(result));
	assert.match(
		result!.kind === "execution-error" ? result!.error : "",
		/INJECTED_FORK_READ_EIO/,
		"original setup failure preserved",
	);
	assert.equal(h.requests.length, 0, "zero provider requests or extra forks");
	// The known locator — captured at createBranchedSession — survives the
	// prepare-stage failure; after the transient fault the real readable fork
	// is advertised, not "no-session" and not the parent.
	assert.equal(result!.session?.kind, "available", JSON.stringify(result!.session));
	if (result!.session?.kind === "available") {
		assert.match(result!.session.path, /forks\//);
		assert.equal((await stat(result!.session.path)).isFile(), true);
		assert.match(await readFile(result!.session.path, "utf8"), /Parent task/);
		assert.doesNotMatch(result!.session.path, /parent\.jsonl/);
	}
});

test("a successful inquiry advertises its available session too", { timeout: 60_000 }, async (t) => {
	const h = await harness(t, (n, file) => (n === 1 ? write(file, "kept") : { text: "unexpected" }));
	const result = await inquire(h, EVIDENCE);
	assert.equal(result.kind, "decision", JSON.stringify(result));
	assert.equal(result.session?.kind, "available");
	if (result.session?.kind === "available") {
		await access(result.session.path);
	}
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
