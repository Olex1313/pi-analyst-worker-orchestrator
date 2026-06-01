import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CUSTOM_MESSAGE = "pi-analyst-worker";
const STATE_ENTRY = "pi-analyst-worker-state";
const EXTENSION_VERSION = 1;
const MAX_AUTONOMOUS_WORKER_STEPS = 25;

type Role = "ANALYST" | "WORKER";
type Phase = "ANALYST_PLAN" | "WORKER_RUN" | "ANALYST_REVIEW";
type AwStateName =
	| "IDLE"
	| "CONFIGURING"
	| "ANALYST_PLANNING"
	| "WAITING_FOR_OPERATOR"
	| "WORKER_RUNNING"
	| "ANALYST_REVIEWING"
	| "BLOCKED_NEEDS_OPERATOR"
	| "DONE_NEEDS_OPERATOR_CONFIRMATION"
	| "ARCHIVING"
	| "ABORTED";

type ToolPolicy = "all-tools" | "read-only" | "no-tools";
type ArtifactPolicy = "keep-tmp" | "archive-docs" | "delete-after-finish";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LEVELS_DESC: ThinkingLevel[] = ["xhigh", "high", "medium", "low", "minimal", "off"];
const DEFAULT_ROLE_THINKING: Record<Role, ThinkingLevel> = { ANALYST: "high", WORKER: "high" };

interface AwConfig {
	cwd: string;
	taskTitle: string;
	taskDescription: string;
	taskSlug: string;
	taskId: string;
	analystModel: string;
	analystThinkingLevel: ThinkingLevel;
	workerModel: string;
	workerThinkingLevel: ThinkingLevel;
	analystContextLimitTokens: number;
	workerContextLimitTokens: number;
	toolPolicy: ToolPolicy;
	maxWorkerStepsBeforeOperator: number;
	artifactDir: string;
	artifactPolicy: ArtifactPolicy;
	startedAt: string;
}

interface AwRun {
	version: number;
	config: AwConfig;
	state: AwStateName;
	paused: boolean;
	currentStep: number;
	nextRole: Role | null;
	nextPhase: Phase | null;
	currentHypothesis: string;
	done: string[];
	openQuestions: string[];
	nextAction: string;
	operatorExpected: string;
	lastReportPath?: string;
	lastAnalystReportPath?: string;
	lastWorkerReportPath?: string;
	archiveDir?: string;
	operatorModel?: string;
	operatorThinkingLevel?: ThinkingLevel;
	workerStepsSinceOperator: number;
	updatedAt: string;
}

interface ActiveTurn {
	role: Role;
	phase: Phase;
	step: number;
	model: string;
	thinkingLevel: ThinkingLevel;
	stateAtStart: AwStateName;
	startedAt: string;
	auto: boolean;
	toolMs: number;
	toolCounts: Record<string, number>;
	toolErrors: number;
	externalMs: number;
}

interface UsageTotals {
	in: number;
	out: number;
	cache_read: number;
	cache_write: number;
	cost: number;
}

interface StepTiming {
	wall_ms: number;
	llm_ms: number;
	tool_ms: number;
	external_ms: number;
	tool_counts: Record<string, number>;
	tool_errors: number;
}

interface LedgerStep extends UsageTotals, StepTiming {
	step: number;
	role: Role;
	phase: Phase;
	model: string;
	thinking_level: ThinkingLevel;
	state_after: AwStateName;
	cumulative_model_in: number;
	cumulative_model_out: number;
	context_tokens: number | null;
	context_window: number | null;
	context_percent: number | null;
	started_at: string;
	finished_at: string;
	artifact: string;
}

interface LedgerCompaction {
	started_at: string;
	finished_at: string;
	model: string;
	phase: Phase;
	wall_ms: number;
	tokens_before: number | null;
	status: "completed" | "failed";
	error?: string;
}

interface Ledger {
	task_id: string;
	task_title: string;
	artifact_dir: string;
	started_at: string;
	config: AwConfig;
	totals: Record<string, UsageTotals>;
	steps: LedgerStep[];
	compactions?: LedgerCompaction[];
}

interface AwPreferences {
	version: number;
	analystModel: string;
	analystThinkingLevel?: ThinkingLevel;
	workerModel: string;
	workerThinkingLevel?: ThinkingLevel;
	analystContextLimitTokens: number;
	workerContextLimitTokens: number;
	toolPolicy: ToolPolicy;
	maxWorkerStepsBeforeOperator: number;
	artifactPolicy: ArtifactPolicy;
	updatedAt: string;
}

interface WorkflowSettings {
	analystModel: string;
	analystThinkingLevel: ThinkingLevel;
	workerModel: string;
	workerThinkingLevel: ThinkingLevel;
	analystContextLimitTokens: number;
	workerContextLimitTokens: number;
	toolPolicy: ToolPolicy;
	maxWorkerStepsBeforeOperator: number;
	artifactPolicy: ArtifactPolicy;
}

const SETTINGS_FILE = join(".pi", "analyst-worker.json");
const GLOBAL_SETTINGS_FILE = "analyst-worker.json";

const ANALYST_SYSTEM = `You are the ANALYST in a Pi Analyst/Worker workflow.

You plan, diagnose, review worker output, maintain state, and decide whether the next state is NEEDS_WORKER, NEEDS_OPERATOR, DONE, or ABORT.

Hard requirements:
- Start every visible answer with [ANALYST: <model>] plus Step, State, and Task lines.
- Maintain a high-level plan for the global operator task.
- At each analyst turn, update the plan and produce exactly one small, detailed, bounded worker stage when more work is needed.
- Do not perform worker implementation unless explicitly instructed by the operator.
- Stop and ask the operator if results are contradictory, invalid, risky, out of scope, context/cost constrained, require credentials/network, or require a human trade-off.
- Let the workflow continue automatically with the worker while the next state is NEEDS_WORKER.
- In final or operator-facing reviews, include token/time totals, major delays, important errors, and lessons to make future runs faster/better.`;

const WORKER_SYSTEM = `You are the WORKER in a Pi Analyst/Worker workflow.

You execute exactly one bounded task from the latest ANALYST instruction, then stop and report.

Hard requirements:
- Start every visible answer with [WORKER: <model>] plus Step, Action, and Task lines.
- Do not continue into a second task.
- Do not silently broaden scope.
- Keep scratch logs under the configured artifact directory.
- Stop on unexpected results, missing credentials/network/tool capability, unclear requirements, or out-of-scope diffs.`;

function nowIso(): string {
	return new Date().toISOString();
}

function pad(num: number, len = 2): string {
	return String(num).padStart(len, "0");
}

function pathTimestamp(date = new Date()): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function stepId(step: number): string {
	return String(step).padStart(4, "0");
}

function slugify(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{Letter}\p{Number}]+/gu, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return slug || "task";
}

function fallbackTaskTitle(description: string): string {
	const cleaned = description
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/github\.com\/\S+/gi, " ")
		.replace(/["'`*_()[\]{}<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const lower = description.toLowerCase();
	const hints: string[] = [];
	if (/gpgpuengine/i.test(description)) hints.push("GPGPUEngine");
	if (/gpu|cuda|4090|gpgpu/i.test(lower)) hints.push("GPU");
	if (/sort|сорт/i.test(lower)) hints.push("sort");
	if (/profile|nsys|ncu|профил/i.test(lower)) hints.push("profile");
	if (hints.length >= 2) return [...new Set(hints)].join(" ");
	const words = cleaned.split(" ").filter((word) => word.length > 2).slice(0, 6).join(" ");
	return words || "Analyst Worker Task";
}

function normalizeTaskTitle(title: string, description: string): string {
	const cleaned = title
		.replace(/^title\s*[:\-]\s*/i, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/["'`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const fallback = fallbackTaskTitle(description);
	if (!cleaned || cleaned.length > 80 || /https?:\/\//i.test(cleaned)) return fallback;
	return cleaned.slice(0, 80);
}

function shouldSkipModelProbe(): boolean {
	// Probe models by default so broken auth/provider access is caught before
	// starting the Analyst/Worker loop. Disable only for offline smoke tests or
	// explicit debugging with PI_ANALYST_WORKER_SKIP_MODEL_PROBE=1.
	return process.env.PI_OFFLINE === "1" || process.env.PI_ANALYST_WORKER_SKIP_MODEL_PROBE === "1";
}

async function runQuickPiPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelRef: string,
	thinkingLevel: ThinkingLevel | undefined,
	systemPrompt: string,
	prompt: string,
	timeoutMs = 30000,
): Promise<{ ok: true; text: string; usage: UsageTotals; wallMs: number } | { ok: false; error: string; wallMs: number }> {
	const started = Date.now();
	const args = [
		"NODE_USE_ENV_PROXY=1",
		"NODE_NO_WARNINGS=1",
		"pi",
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-tools",
		"--model",
		modelRef,
	];
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	args.push("--system-prompt", systemPrompt, "-p", prompt);
	const result = await pi.exec("env", args, { cwd: ctx.cwd, timeout: timeoutMs });
	const wallMs = Date.now() - started;
	let assistant: any | undefined;
	for (const line of result.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event?.type === "message_end" && event.message?.role === "assistant") assistant = event.message;
		} catch {
			// Non-JSON output is handled as an error below.
		}
	}
	if (assistant) {
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { ok: false, error: sanitizeProviderError(assistant.errorMessage || `pi probe returned ${assistant.stopReason}`), wallMs };
		}
		const text = textFromContent(assistant.content).trim();
		if (result.code === 0 && text) return { ok: true, text, usage: usageFromMessages([assistant]), wallMs };
	}
	const error = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
	return { ok: false, error: sanitizeProviderError(error || `pi probe exited with code ${result.code}${result.killed ? " (timeout)" : ""}`), wallMs };
}

async function generateTaskTitle(pi: ExtensionAPI, ctx: ExtensionCommandContext, description: string, analystModelRef: string, analystThinkingLevel: ThinkingLevel): Promise<string> {
	const fallback = fallbackTaskTitle(description);
	if (shouldSkipModelProbe() || !findModel(ctx, analystModelRef)) return fallback;
	try {
		const result = await runQuickPiPrompt(
			pi,
			ctx,
			analystModelRef,
			analystThinkingLevel,
			"You create short task titles. Output only the title.",
			`Create a short human-readable task title for this Analyst/Worker run.\n\nRules:\n- 2 to 6 words.\n- No URL.\n- Prefer concise technical nouns.\n- Keep useful project/library names.\n- Output only the title, no quotes, no punctuation.\n\nTask description:\n${description}`,
			30000,
		);
		if (!result.ok) return fallback;
		const line = result.text
			.split(/\r?\n/)
			.map((part) => part.trim())
			.filter(Boolean)
			.pop();
		return normalizeTaskTitle(line || result.text, description);
	} catch {
		return fallback;
	}
}

async function probeModelRequest(pi: ExtensionAPI, ctx: ExtensionContext, ref: string, role: Role, thinkingLevel: ThinkingLevel): Promise<{ ok: true } | { ok: false; error: string }> {
	if (shouldSkipModelProbe()) return { ok: true };
	if (!findModel(ctx, ref)) return { ok: false, error: `Model not found in Pi registry: ${ref}` };
	try {
		const result = await runQuickPiPrompt(
			pi,
			ctx,
			ref,
			thinkingLevel,
			"Tiny availability probe. Reply only with the requested OK text.",
			`Reply with exactly: OK ${role}`,
			30000,
		);
		if (!result.ok) return { ok: false, error: result.error };
		return { ok: true };
	} catch (error) {
		return { ok: false, error: sanitizeProviderError(error) };
	}
}

function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `./${rel}` : path;
}

function shouldUseExternalAnalyst(modelRef: string): boolean {
	if (process.env.PI_ANALYST_WORKER_EXTERNAL_ANALYST === "0") return false;
	if (process.env.PI_ANALYST_WORKER_EXTERNAL_ANALYST === "1") return true;
	return modelRef.startsWith("openai-codex/");
}

async function readSnippet(path: string | undefined, max = 12000): Promise<string> {
	if (!path) return "";
	try {
		return truncate(await readFile(path, "utf8"), max);
	} catch {
		return "";
	}
}

async function buildExternalAnalystPrompt(run: AwRun, turn: ActiveTurn): Promise<string> {
	const state = await readSnippet(statePath(run), 14000);
	const ledger = await readSnippet(ledgerPath(run), 8000);
	const latestWorker = await readSnippet(run.lastWorkerReportPath ? resolve(run.config.cwd, run.lastWorkerReportPath) : undefined, 18000);
	const latestAnalyst = await readSnippet(run.lastAnalystReportPath ? resolve(run.config.cwd, run.lastAnalystReportPath) : undefined, 8000);
	return `${buildRolePrompt(run, turn)}

Embedded workflow state (because this analyst turn runs in a proxy-safe subprocess without tools):

## state.md
${state || "not available"}

## ledger.json
${ledger || "not available"}

## latest worker report
${latestWorker || "none yet"}

## latest analyst report
${latestAnalyst || "none yet"}
`;
}

function syntheticAssistantMessage(modelRef: string, text: string, error?: string, usage?: UsageTotals): any {
	const parsed = parseModelRef(modelRef);
	const u = usage ?? { in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0 };
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "external-pi-probe",
		provider: parsed?.provider ?? "unknown",
		model: parsed?.id ?? modelRef,
		usage: {
			input: u.in,
			output: u.out,
			cacheRead: u.cache_read,
			cacheWrite: u.cache_write,
			totalTokens: u.in + u.out + u.cache_read + u.cache_write,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
		},
		stopReason: error ? "error" : "stop",
		errorMessage: error,
		timestamp: Date.now(),
	};
}

function artifactDir(run: AwRun): string {
	return isAbsolute(run.config.artifactDir) ? run.config.artifactDir : resolve(run.config.cwd, run.config.artifactDir);
}

function statePath(run: AwRun): string {
	return join(artifactDir(run), "state.md");
}

function ledgerPath(run: AwRun): string {
	return join(artifactDir(run), "ledger.json");
}

function stepsDir(run: AwRun): string {
	return join(artifactDir(run), "steps");
}

function phaseState(phase: Phase): AwStateName {
	if (phase === "ANALYST_PLAN") return "ANALYST_PLANNING";
	if (phase === "WORKER_RUN") return "WORKER_RUNNING";
	return "ANALYST_REVIEWING";
}

function phaseRole(phase: Phase): Role {
	return phase === "WORKER_RUN" ? "WORKER" : "ANALYST";
}

function phaseFileName(phase: Phase): string {
	if (phase === "ANALYST_PLAN") return "analyst_plan";
	if (phase === "WORKER_RUN") return "worker_result";
	return "analyst_review";
}

function phaseLabel(phase: Phase): string {
	if (phase === "ANALYST_PLAN") return "analyst planning";
	if (phase === "WORKER_RUN") return "worker execution";
	return "analyst review";
}

function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const clean = ref.trim();
	const slash = clean.indexOf("/");
	if (slash <= 0 || slash === clean.length - 1) return undefined;
	return { provider: clean.slice(0, slash), id: clean.slice(slash + 1) };
}

function modelRef(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function asNumber(input: string | undefined, fallback: number): number {
	const n = Number(String(input ?? "").replace(/[^0-9]/g, ""));
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as string[]).includes(value);
}

function normalizeThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
	return isThinkingLevel(value) ? value : fallback;
}

function modelSupportedThinkingLevels(model: any | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

function clampThinkingLevelForModel(model: any | undefined, level: ThinkingLevel): ThinkingLevel {
	const available = modelSupportedThinkingLevels(model);
	if (available.includes(level)) return level;
	const requestedIndex = THINKING_LEVELS.indexOf(level);
	for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
		const candidate = THINKING_LEVELS[i];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = THINKING_LEVELS[i];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

function thinkingDescription(level: ThinkingLevel): string {
	if (level === "off") return "off — no extended thinking";
	if (level === "minimal") return "minimal — tiny reasoning budget";
	if (level === "low") return "low — light reasoning";
	if (level === "medium") return "medium — balanced reasoning";
	if (level === "high") return "high — deep reasoning";
	return "xhigh — maximum/extra-high reasoning";
}

function truncate(text: string, max = 24000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`;
}

function stripHtmlForError(text: string): string {
	return text
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeProviderError(error: unknown, max = 1200): string {
	const raw = error instanceof Error ? error.message : String(error ?? "Unknown model failure");
	if (/<html[\s>]/i.test(raw) || /<!doctype\s+html/i.test(raw) || /Unable to load site/i.test(raw)) {
		const text = stripHtmlForError(raw);
		const clue = /Unable to load site/i.test(text) ? 'OpenAI/Cloudflare returned an HTML "Unable to load site" page' : "provider returned an HTML page";
		const ip = text.match(/IP\s*:\s*[^|\]\s]+/i)?.[0];
		const ray = text.match(/Ray ID\s*:\s*[^|\]\s]+/i)?.[0];
		const meta = [ip, ray].filter(Boolean).join("; ");
		return `${clue} instead of model output. This is usually an auth/IP/VPN/provider-access problem, not a task problem. Choose a different model or re-login/check provider access.${meta ? ` (${meta})` : ""}`;
	}
	return truncate(raw.replace(/\s+$/g, ""), max);
}

function sanitizeAssistantErrorInPlace(message: any): void {
	if (!message || message.role !== "assistant") return;
	if (typeof message.errorMessage === "string") {
		message.errorMessage = sanitizeProviderError(message.errorMessage, 1200);
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part?.type !== "text" || typeof part.text !== "string") continue;
			if (/<html[\s>]/i.test(part.text) || /Unable to load site/i.test(part.text)) {
				part.text = `Error: ${sanitizeProviderError(part.text, 1200)}`;
			}
		}
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				return (part as { text?: string }).text ?? "";
			}
			return "";
		})
		.join("");
}

function assistantText(messages: any[]): string {
	return messages
		.filter((message) => message?.role === "assistant")
		.map((message) => textFromContent(message.content))
		.filter(Boolean)
		.join("\n\n");
}

function transcriptFromMessages(messages: any[]): string {
	const chunks: string[] = [];
	for (const message of messages) {
		if (message?.role === "assistant") {
			if (typeof message.errorMessage === "string") chunks.push(`\n[assistant_error]\n${sanitizeProviderError(message.errorMessage)}`);
			const parts = Array.isArray(message.content) ? message.content : [];
			for (const part of parts) {
				if (part?.type === "text") chunks.push(part.text ?? "");
				if (part?.type === "toolCall") {
					chunks.push(`\n[tool_call: ${part.name}]\n${JSON.stringify(part.arguments ?? {}, null, 2)}`);
				}
			}
		}
		if (message?.role === "toolResult") {
			chunks.push(`\n[tool_result: ${message.toolName}${message.isError ? " ERROR" : ""}]\n${textFromContent(message.content)}`);
		}
	}
	return truncate(chunks.filter(Boolean).join("\n\n"));
}

function usageFromMessages(messages: any[]): UsageTotals {
	const totals: UsageTotals = { in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0 };
	for (const message of messages) {
		if (message?.role !== "assistant" || !message.usage) continue;
		totals.in += Number(message.usage.input ?? 0);
		totals.out += Number(message.usage.output ?? 0);
		totals.cache_read += Number(message.usage.cacheRead ?? 0);
		totals.cache_write += Number(message.usage.cacheWrite ?? 0);
		totals.cost += Number(message.usage.cost?.total ?? 0);
	}
	return totals;
}

function formatMoney(n: number): string {
	return n > 0 ? `$${n.toFixed(6)}` : "$0";
}

function formatUsage(usage: UsageTotals): string {
	return `IN ${usage.in}, OUT ${usage.out}, cache read ${usage.cache_read}, cache write ${usage.cache_write}, cost ${formatMoney(usage.cost)}`;
}

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		in: a.in + b.in,
		out: a.out + b.out,
		cache_read: a.cache_read + b.cache_read,
		cache_write: a.cache_write + b.cache_write,
		cost: a.cost + b.cost,
	};
}

function newLedger(run: AwRun): Ledger {
	return {
		task_id: run.config.taskId,
		task_title: run.config.taskTitle,
		artifact_dir: run.config.artifactDir,
		started_at: run.config.startedAt,
		config: run.config,
		totals: {},
		steps: [],
		compactions: [],
	};
}

async function readLedger(run: AwRun): Promise<Ledger> {
	try {
		return JSON.parse(await readFile(ledgerPath(run), "utf8")) as Ledger;
	} catch {
		return newLedger(run);
	}
}

async function writeLedger(run: AwRun, ledger: Ledger): Promise<void> {
	await mkdir(artifactDir(run), { recursive: true });
	await writeFile(ledgerPath(run), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

async function appendCompaction(run: AwRun, compaction: LedgerCompaction): Promise<void> {
	const ledger = await readLedger(run);
	ledger.compactions ??= [];
	ledger.compactions.push(compaction);
	await writeLedger(run, ledger);
}

function ledgerTimingSummary(ledger: Ledger): string {
	const steps = ledger.steps ?? [];
	const compactions = ledger.compactions ?? [];
	const sum = (values: number[]) => values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
	const wall = sum(steps.map((step) => step.wall_ms ?? 0));
	const tools = sum(steps.map((step) => step.tool_ms ?? 0));
	const llm = sum(steps.map((step) => step.llm_ms ?? Math.max(0, (step.wall_ms ?? 0) - (step.tool_ms ?? 0))));
	const external = sum(steps.map((step) => step.external_ms ?? 0));
	const analyst = sum(steps.filter((step) => step.role === "ANALYST").map((step) => step.wall_ms ?? 0));
	const worker = sum(steps.filter((step) => step.role === "WORKER").map((step) => step.wall_ms ?? 0));
	const compactionWall = sum(compactions.map((item) => item.wall_ms ?? 0));
	const toolCounts: Record<string, number> = {};
	let toolErrors = 0;
	for (const step of steps) {
		toolErrors += step.tool_errors ?? 0;
		for (const [name, count] of Object.entries(step.tool_counts ?? {})) toolCounts[name] = (toolCounts[name] ?? 0) + count;
	}
	const topTools = Object.entries(toolCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([name, count]) => `${name}×${count}`)
		.join(", ");
	return [
		`End-to-end since start: ${formatDuration(Date.now() - Date.parse(ledger.started_at))}`,
		`Recorded step wall time: ${formatDuration(wall)} (Analyst ${formatDuration(analyst)}, Worker ${formatDuration(worker)})`,
		`LLM/orchestration: ${formatDuration(llm)}, tools/experiments: ${formatDuration(tools)}${external ? `, external analyst subprocess: ${formatDuration(external)}` : ""}`,
		`Compaction: ${formatDuration(compactionWall)} across ${compactions.length} run(s)`,
		topTools ? `Tool calls: ${topTools}${toolErrors ? `; tool errors: ${toolErrors}` : ""}` : undefined,
	].filter(Boolean).join("\n");
}

function preferencesPath(cwd: string): string {
	return resolve(cwd, SETTINGS_FILE);
}

function globalPreferencesPath(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), GLOBAL_SETTINGS_FILE);
}

function isAwPreferences(value: unknown): value is AwPreferences {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as AwPreferences).version === EXTENSION_VERSION &&
			typeof (value as AwPreferences).analystModel === "string" &&
			typeof (value as AwPreferences).workerModel === "string",
	);
}

function normalizePreferences(prefs: AwPreferences): AwPreferences {
	return {
		version: EXTENSION_VERSION,
		analystModel: prefs.analystModel,
		analystThinkingLevel: normalizeThinkingLevel(prefs.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST),
		workerModel: prefs.workerModel,
		workerThinkingLevel: normalizeThinkingLevel(prefs.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER),
		analystContextLimitTokens: asNumber(String(prefs.analystContextLimitTokens ?? ""), 128000),
		workerContextLimitTokens: asNumber(String(prefs.workerContextLimitTokens ?? ""), 128000),
		toolPolicy: "all-tools",
		maxWorkerStepsBeforeOperator: 1,
		artifactPolicy: "keep-tmp",
		updatedAt: prefs.updatedAt ?? nowIso(),
	};
}

function mergePreferences(globalPrefs: AwPreferences | undefined, localPrefs: AwPreferences | undefined): AwPreferences | undefined {
	if (!globalPrefs && !localPrefs) return undefined;
	if (!globalPrefs) return normalizePreferences(localPrefs!);
	if (!localPrefs) return normalizePreferences(globalPrefs);
	return normalizePreferences({
		...globalPrefs,
		...localPrefs,
		analystThinkingLevel: localPrefs.analystThinkingLevel ?? globalPrefs.analystThinkingLevel,
		workerThinkingLevel: localPrefs.workerThinkingLevel ?? globalPrefs.workerThinkingLevel,
		updatedAt: localPrefs.updatedAt ?? globalPrefs.updatedAt,
	});
}

async function readPreferencesFile(file: string): Promise<AwPreferences | undefined> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return isAwPreferences(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function readPreferencesSource(cwd: string): Promise<{ prefs: AwPreferences; source: string } | undefined> {
	const localFile = preferencesPath(cwd);
	const globalFile = globalPreferencesPath();
	const [globalPrefs, localPrefs] = await Promise.all([readPreferencesFile(globalFile), readPreferencesFile(localFile)]);
	const prefs = mergePreferences(globalPrefs, localPrefs);
	if (!prefs) return undefined;
	const source = localPrefs && globalPrefs ? `${SETTINGS_FILE} + ${globalFile}` : localPrefs ? SETTINGS_FILE : globalFile;
	return { prefs, source };
}

async function readPreferences(cwd: string): Promise<AwPreferences | undefined> {
	return (await readPreferencesSource(cwd))?.prefs;
}

async function writePreferencesFile(file: string, prefs: AwPreferences): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}

async function writePreferences(cwd: string, settings: WorkflowSettings): Promise<AwPreferences> {
	const normalized: WorkflowSettings = {
		...settings,
		analystThinkingLevel: normalizeThinkingLevel(settings.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST),
		workerThinkingLevel: normalizeThinkingLevel(settings.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER),
		toolPolicy: "all-tools",
		maxWorkerStepsBeforeOperator: 1,
		artifactPolicy: "keep-tmp",
	};
	const prefs: AwPreferences = { version: EXTENSION_VERSION, ...normalized, updatedAt: nowIso() };
	await writePreferencesFile(preferencesPath(cwd), prefs);
	await writePreferencesFile(globalPreferencesPath(), prefs);
	return prefs;
}

function settingsFromPreferences(prefs: AwPreferences): WorkflowSettings {
	const normalized = normalizePreferences(prefs);
	return {
		analystModel: normalized.analystModel,
		analystThinkingLevel: normalized.analystThinkingLevel!,
		workerModel: normalized.workerModel,
		workerThinkingLevel: normalized.workerThinkingLevel!,
		analystContextLimitTokens: normalized.analystContextLimitTokens,
		workerContextLimitTokens: normalized.workerContextLimitTokens,
		toolPolicy: "all-tools",
		maxWorkerStepsBeforeOperator: 1,
		artifactPolicy: "keep-tmp",
	};
}

function settingsFromRun(run: AwRun): WorkflowSettings {
	return {
		analystModel: run.config.analystModel,
		analystThinkingLevel: normalizeThinkingLevel(run.config.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST),
		workerModel: run.config.workerModel,
		workerThinkingLevel: normalizeThinkingLevel(run.config.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER),
		analystContextLimitTokens: run.config.analystContextLimitTokens,
		workerContextLimitTokens: run.config.workerContextLimitTokens,
		toolPolicy: "all-tools",
		maxWorkerStepsBeforeOperator: 1,
		artifactPolicy: "keep-tmp",
	};
}

function settingsSummary(settings: WorkflowSettings | AwPreferences): string {
	return `Analyst model: ${settings.analystModel}\nAnalyst thinking: ${normalizeThinkingLevel(settings.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST)}\nWorker model: ${settings.workerModel}\nWorker thinking: ${normalizeThinkingLevel(settings.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER)}\nAnalyst context limit: ${settings.analystContextLimitTokens}\nWorker context limit: ${settings.workerContextLimitTokens}\nTool policy: all-tools (always enabled)\nWorkflow: automatic analyst → worker loop until done/blocked/operator-needed`;
}

function stateMarkdown(run: AwRun): string {
	const latestArtifacts = [run.lastAnalystReportPath, run.lastWorkerReportPath, run.lastReportPath]
		.filter(Boolean)
		.map((p) => `- ${p}`)
		.join("\n");
	return `# Analyst/Worker State

Task: ${run.config.taskTitle}
Task ID: ${run.config.taskId}
Current state: ${run.state}
Paused: ${run.paused ? "Yes" : "No"}
Analyst model: ${run.config.analystModel}
Analyst thinking: ${roleThinkingLevel(run, "ANALYST")}
Worker model: ${run.config.workerModel}
Worker thinking: ${roleThinkingLevel(run, "WORKER")}
Operator model before workflow: ${run.operatorModel ?? "not recorded"}
Operator thinking before workflow: ${run.operatorThinkingLevel ?? "not recorded"}
Started: ${run.config.startedAt}
Updated: ${run.updatedAt}
Last step: ${run.currentStep}
Artifact dir: ${run.config.artifactDir}
Ledger: ${displayPath(ledgerPath(run), run.config.cwd)}
Tool policy: ${run.config.toolPolicy}
Archive policy: ${run.config.artifactPolicy}
Autonomous worker steps since operator: ${run.workerStepsSinceOperator ?? 0}

## Global task description
${run.config.taskDescription || run.config.taskTitle}

## Current hypothesis
${run.currentHypothesis || "TBD by analyst."}

## Done
${run.done.length ? run.done.map((item) => `- ${item}`).join("\n") : "- Nothing recorded yet."}

## Open questions
${run.openQuestions.length ? run.openQuestions.map((item) => `- ${item}`).join("\n") : "- None recorded yet."}

## Next action
${run.nextAction || "Run /analyst-worker."}

## Operator expected?
${run.operatorExpected || "No."}

## Latest artifacts
${latestArtifacts || "- None yet."}
`;
}

async function writeState(run: AwRun): Promise<void> {
	await mkdir(stepsDir(run), { recursive: true });
	await writeFile(statePath(run), stateMarkdown(run), "utf8");
	if (!existsSync(ledgerPath(run))) {
		await writeLedger(run, newLedger(run));
	}
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0 ms";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)} s`;
	const min = Math.floor(sec / 60);
	const rest = sec - min * 60;
	return `${min}m ${rest.toFixed(1)}s`;
}

function timingForTurn(turn: ActiveTurn, finishedMs = Date.now()): StepTiming {
	const wall = Math.max(0, finishedMs - Date.parse(turn.startedAt));
	const tool = Math.max(0, turn.toolMs || 0);
	const external = Math.max(0, turn.externalMs || 0);
	return {
		wall_ms: wall,
		tool_ms: tool,
		external_ms: external,
		llm_ms: Math.max(0, wall - tool),
		tool_counts: { ...(turn.toolCounts ?? {}) },
		tool_errors: turn.toolErrors ?? 0,
	};
}

function formatTiming(timing: StepTiming): string {
	const tools = Object.entries(timing.tool_counts)
		.map(([name, count]) => `${name}×${count}`)
		.join(", ");
	return `Wall: ${formatDuration(timing.wall_ms)}, LLM/orchestration: ${formatDuration(timing.llm_ms)}, tools/experiments: ${formatDuration(timing.tool_ms)}${timing.external_ms ? `, external subprocess: ${formatDuration(timing.external_ms)}` : ""}${tools ? `, tool calls: ${tools}` : ""}${timing.tool_errors ? `, tool errors: ${timing.tool_errors}` : ""}`;
}

function stepReportMarkdown(turn: ActiveTurn, run: AwRun, usage: UsageTotals, stateAfter: AwStateName, transcript: string, timing: StepTiming): string {
	return `# Analyst/Worker Step Report

Role: ${turn.role}
Phase: ${turn.phase}
Step: ${turn.step}
Model: ${turn.model}
Thinking level: ${turn.thinkingLevel}
Started: ${turn.startedAt}
Finished: ${run.updatedAt}
State after: ${stateAfter}

## Wall time

${formatTiming(timing)}

## Token usage

Input: ${usage.in}
Output: ${usage.out}
Cache read: ${usage.cache_read}
Cache write: ${usage.cache_write}
Cost: ${formatMoney(usage.cost)}

## Assistant/tool transcript

${transcript || "No assistant text captured."}
`;
}

function turnHeader(run: AwRun, turn: Pick<ActiveTurn, "role" | "phase" | "step" | "model" | "stateAtStart">): string {
	if (turn.role === "ANALYST") {
		return `[ANALYST: ${turn.model}]\nStep: ${stepId(turn.step)}\nState: ${turn.stateAtStart}\nTask: ${run.config.taskSlug}`;
	}
	return `[WORKER: ${turn.model}]\nStep: ${stepId(turn.step)}\nAction: ${phaseLabel(turn.phase)}\nTask: ${run.config.taskSlug}`;
}

function operatorMessage(run: AwRun, reason: string, expected: string): string {
	return `[OPERATOR HANDOFF]\nState: ${run.state}\nReason: ${reason}\nExpected operator input:\n  ${expected}`;
}

function parseAnalystNextState(text: string): "NEEDS_WORKER" | "NEEDS_OPERATOR" | "DONE" | "ABORT" | undefined {
	const nextStateLine = text.match(/(?:^|\n)\s*##?\s*Next state\s*\n([\s\S]{0,200})/i)?.[1] ?? text;
	if (/\bABORT\b/i.test(nextStateLine)) return "ABORT";
	if (/\bDONE\b/i.test(nextStateLine)) return "DONE";
	if (/\bNEEDS_OPERATOR\b|\bBLOCKED\b|OPERATOR ACTION REQUIRED/i.test(nextStateLine)) return "NEEDS_OPERATOR";
	if (/\bNEEDS_WORKER\b|\bMORE_WORK\b/i.test(nextStateLine)) return "NEEDS_WORKER";
	return undefined;
}

function createRun(ctx: ExtensionCommandContext, config: Omit<AwConfig, "cwd" | "taskSlug" | "taskId" | "startedAt">): AwRun {
	const startedAt = nowIso();
	const slug = slugify(config.taskTitle);
	const day = startedAt.slice(0, 10).replace(/-/g, "");
	return {
		version: EXTENSION_VERSION,
		config: {
			...config,
			cwd: ctx.cwd,
			taskSlug: slug,
			taskId: `${day}_${slug}`,
			startedAt,
		},
		state: "ANALYST_PLANNING",
		paused: false,
		currentStep: 0,
		nextRole: "ANALYST",
		nextPhase: "ANALYST_PLAN",
		currentHypothesis: "TBD by analyst.",
		done: [],
		openQuestions: [],
		nextAction: "Run /analyst-worker to ask the analyst for the initial plan.",
		operatorExpected: "No: analyst planning starts automatically.",
		operatorModel: ctx.model ? modelRef(ctx.model) : undefined,
		workerStepsSinceOperator: 0,
		updatedAt: startedAt,
	};
}

function isAwRun(value: unknown): value is AwRun {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as AwRun).version === EXTENSION_VERSION &&
			(value as AwRun).config &&
			typeof (value as AwRun).config.taskTitle === "string",
	);
}

function findModel(ctx: ExtensionContext, ref: string) {
	const parsed = parseModelRef(ref);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.id);
}

function clampSettingsForModels(ctx: ExtensionContext, settings: WorkflowSettings): WorkflowSettings {
	return {
		...settings,
		analystThinkingLevel: clampThinkingLevelForModel(findModel(ctx, settings.analystModel), settings.analystThinkingLevel),
		workerThinkingLevel: clampThinkingLevelForModel(findModel(ctx, settings.workerModel), settings.workerThinkingLevel),
	};
}

function roleThinkingLevel(run: AwRun, role: Role): ThinkingLevel {
	return role === "ANALYST"
		? normalizeThinkingLevel(run.config.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST)
		: normalizeThinkingLevel(run.config.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER);
}

function modelOptions(ctx: ExtensionContext): string[] {
	const seen = new Set<string>();
	const options: string[] = [];
	const push = (prefix: string, ref: string | undefined) => {
		if (!ref || seen.has(ref)) return;
		seen.add(ref);
		options.push(`${prefix}: ${ref}`);
	};

	push("current", ctx.model ? modelRef(ctx.model) : undefined);

	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") push("recent", `${entry.provider}/${entry.modelId}`);
	}

	for (const model of ctx.modelRegistry.getAvailable()) push("available", modelRef(model));
	for (const model of ctx.modelRegistry.getAll()) push("model", modelRef(model));

	options.push("manual: enter provider/model");
	return options;
}

function selectedModelRef(selection: string | undefined): string | undefined {
	if (!selection) return undefined;
	const idx = selection.indexOf(":");
	return idx >= 0 ? selection.slice(idx + 1).trim() : selection.trim();
}

async function chooseModel(ctx: ExtensionCommandContext, title: string, fallback: string): Promise<string | undefined> {
	if (!ctx.hasUI) return fallback;

	const options = modelOptions(ctx);
	if (fallback) {
		const withoutFallback = options.filter((option) => selectedModelRef(option) !== fallback);
		options.splice(0, options.length, `saved/default: ${fallback}`, ...withoutFallback);
	}

	const choice = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let filter = "";
		let selectedIndex = 0;
		const maxVisible = 12;
		const searchable = options.map((option) => ({
			value: option,
			search: option.toLowerCase(),
		}));

		const getFiltered = () => {
			const needle = filter.trim().toLowerCase();
			if (!needle) return searchable;
			return searchable.filter((item) => item.search.includes(needle));
		};

		const clampSelection = (itemsLength: number) => {
			if (itemsLength <= 0) {
				selectedIndex = 0;
				return;
			}
			selectedIndex = Math.max(0, Math.min(selectedIndex, itemsLength - 1));
		};

		const setFilter = (next: string) => {
			filter = next;
			selectedIndex = 0;
		};

		return {
			render(width: number): string[] {
				const items = getFiltered();
				clampSelection(items.length);
				const safeWidth = Math.max(20, width);
				const lines: string[] = [
					theme.fg("accent", theme.bold(truncateToWidth(title, safeWidth, ""))),
					theme.fg(
						"dim",
						truncateToWidth("Type to filter by substring • ↑↓ navigate • Enter select • Esc cancel", safeWidth, ""),
					),
					truncateToWidth(
						`Filter: ${filter || "—"}  (${items.length}/${searchable.length})`,
						safeWidth,
						"",
					),
				];

				if (items.length === 0) {
					lines.push(theme.fg("warning", truncateToWidth("  No matching models. Backspace or keep typing.", safeWidth, "")));
					return lines;
				}

				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
				const end = Math.min(start + maxVisible, items.length);
				for (let i = start; i < end; i++) {
					const item = items[i];
					if (!item) continue;
					const isSelected = i === selectedIndex;
					const line = truncateToWidth(`${isSelected ? "→" : " "} ${item.value}`, safeWidth, "");
					lines.push(isSelected ? theme.bg("selectedBg", theme.fg("accent", line)) : line);
				}

				if (start > 0 || end < items.length) {
					lines.push(theme.fg("dim", truncateToWidth(`  (${selectedIndex + 1}/${items.length})`, safeWidth, "")));
				}
				return lines;
			},
			invalidate() {},
			handleInput(data: string): void {
				const items = getFiltered();
				if (matchesKey(data, Key.up)) {
					if (items.length > 0) selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
				} else if (matchesKey(data, Key.down)) {
					if (items.length > 0) selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
				} else if (matchesKey(data, Key.enter)) {
					const selected = items[selectedIndex];
					if (selected) done(selected.value);
					return;
				} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				} else if (matchesKey(data, Key.backspace)) {
					setFilter(filter.slice(0, -1));
				} else if (matchesKey(data, Key.delete)) {
					setFilter("");
				} else if (!data.startsWith("\x1b") && data >= " " && data !== "\x7f") {
					setFilter(filter + data);
				}
				tui.requestRender();
			},
		};
	});

	if (!choice) return undefined;
	if (choice.startsWith("manual:")) {
		return (await ctx.ui.input(`${title}: provider/model`, fallback))?.trim();
	}
	return selectedModelRef(choice);
}

function thinkingOptionLabel(model: any | undefined, level: ThinkingLevel): string {
	const mapped = model?.thinkingLevelMap?.[level];
	const suffix = typeof mapped === "string" && mapped !== level ? ` → provider ${mapped}` : "";
	return `${level}: ${thinkingDescription(level)}${suffix}`;
}

function selectedThinkingLevel(selection: string | undefined): ThinkingLevel | undefined {
	const raw = selection?.split(":")[0]?.trim();
	return isThinkingLevel(raw) ? raw : undefined;
}

async function chooseThinkingLevel(ctx: ExtensionCommandContext, role: Role, ref: string, fallback: ThinkingLevel): Promise<ThinkingLevel | undefined> {
	const model = findModel(ctx, ref);
	const levels = modelSupportedThinkingLevels(model);
	const effectiveFallback = clampThinkingLevelForModel(model, fallback);
	if (!ctx.hasUI) return effectiveFallback;
	if (levels.length <= 1) return levels[0] ?? "off";
	const ordered = THINKING_LEVELS_DESC.filter((level) => levels.includes(level));
	const selectedDefault = ordered.includes(effectiveFallback) ? effectiveFallback : ordered[0] ?? "off";
	const label = role === "ANALYST"
		? "Please choose analyst thinking level — reasoning depth for analyst planning/review"
		: "Please choose worker thinking level — reasoning depth for coding/execution";
	const choice = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let selectedIndex = Math.max(0, ordered.indexOf(selectedDefault));
		return {
			render(width: number): string[] {
				const safeWidth = Math.max(20, width);
				const lines = [
					theme.fg("accent", theme.bold(truncateToWidth(label, safeWidth, ""))),
					theme.fg("dim", truncateToWidth("Ordered strongest → weakest • ↑↓ navigate • Enter select • Esc cancel", safeWidth, "")),
				];
				for (let i = 0; i < ordered.length; i++) {
					const level = ordered[i]!;
					const suffix = level === selectedDefault ? " (saved/default)" : "";
					const line = truncateToWidth(`${i === selectedIndex ? "→" : " "} ${thinkingOptionLabel(model, level)}${suffix}`, safeWidth, "");
					lines.push(i === selectedIndex ? theme.bg("selectedBg", theme.fg("accent", line)) : line);
				}
				return lines;
			},
			invalidate() {},
			handleInput(data: string): void {
				if (matchesKey(data, Key.up)) selectedIndex = selectedIndex === 0 ? ordered.length - 1 : selectedIndex - 1;
				else if (matchesKey(data, Key.down)) selectedIndex = selectedIndex === ordered.length - 1 ? 0 : selectedIndex + 1;
				else if (matchesKey(data, Key.enter)) {
					done(ordered[selectedIndex]);
					return;
				} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				}
				tui.requestRender();
			},
		};
	});
	return selectedThinkingLevel(choice);
}

async function chooseNumber(ctx: ExtensionCommandContext, title: string, fallback: number): Promise<number | undefined> {
	if (!ctx.hasUI) return fallback;
	const initial = String(fallback);
	const value = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let text = initial;
		let cursor = text.length;
		return {
			render(width: number): string[] {
				const safeWidth = Math.max(20, width);
				const before = text.slice(0, cursor);
				const at = text[cursor] ?? " ";
				const after = text.slice(cursor + 1);
				const valueLine = `Value: ${before}${theme.bg("selectedBg", at)}${after}`;
				return [
					theme.fg("accent", theme.bold(truncateToWidth(title, safeWidth, ""))),
					theme.fg("dim", truncateToWidth("Default is prefilled. Edit/delete it, then press Enter. Esc cancels.", safeWidth, "")),
					truncateToWidth(valueLine, safeWidth, ""),
				];
			},
			invalidate() {},
			handleInput(data: string): void {
				if (matchesKey(data, Key.enter)) {
					done(text);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.left)) cursor = Math.max(0, cursor - 1);
				else if (matchesKey(data, Key.right)) cursor = Math.min(text.length, cursor + 1);
				else if (matchesKey(data, Key.home)) cursor = 0;
				else if (matchesKey(data, Key.end)) cursor = text.length;
				else if (matchesKey(data, Key.backspace)) {
					if (cursor > 0) {
						text = text.slice(0, cursor - 1) + text.slice(cursor);
						cursor--;
					}
				} else if (matchesKey(data, Key.delete)) {
					if (cursor < text.length) text = text.slice(0, cursor) + text.slice(cursor + 1);
				} else if (!data.startsWith("\x1b") && data >= " " && data !== "\x7f") {
					text = text.slice(0, cursor) + data + text.slice(cursor);
					cursor += data.length;
				}
				tui.requestRender();
			},
		};
	});
	return value === undefined ? undefined : asNumber(value, fallback);
}

function toolAllowed(policy: ToolPolicy, toolName: string): boolean {
	if (policy === "all-tools") return true;
	if (policy === "no-tools") return false;
	const readOnly = new Set(["read", "grep", "find", "ls", "pdf_info", "pdf_extract_text", "pdf_extract_tables"]);
	return readOnly.has(toolName) || toolName.startsWith("pdf_extract");
}

function roleContextLimit(run: AwRun, role: Role): number {
	return role === "ANALYST" ? run.config.analystContextLimitTokens : run.config.workerContextLimitTokens;
}

function buildRolePrompt(run: AwRun, turn: ActiveTurn): string {
	const header = turnHeader(run, turn);
	const state = displayPath(statePath(run), run.config.cwd);
	const ledger = displayPath(ledgerPath(run), run.config.cwd);
	const artifacts = displayPath(artifactDir(run), run.config.cwd);
	const lastReport = run.lastReportPath ? run.lastReportPath : "none yet";
	const common = `${header}

Workflow files:
- State: ${state}
- Ledger: ${ledger}
- Artifact dir: ${artifacts}
- Latest report: ${lastReport}

Global task description:
${run.config.taskDescription || run.config.taskTitle}

Constraints:
- Tool policy: ${run.config.toolPolicy}
- Analyst thinking level: ${roleThinkingLevel(run, "ANALYST")}
- Worker thinking level: ${roleThinkingLevel(run, "WORKER")}
- Analyst context limit: ${run.config.analystContextLimitTokens}
- Worker context limit: ${run.config.workerContextLimitTokens}
- No autonomous infinite loop. Return control according to the role protocol.
- Keep context compact: do not paste large logs, full fetched pages, or long source files into chat. Save raw outputs under the artifact dir and summarize only the relevant findings with file paths.
`;

	if (turn.phase === "ANALYST_PLAN") {
		return `${common}
[ANALYST MODE]
Read the workflow state and the conversation context. Produce a high-level plan with major stages, then plan exactly one small detailed worker stage to execute now.

Required sections:
## Diagnosis / Review
## Hypothesis
## Worker instruction
## Validation / Risks
## Next state
## Operator handoff

When handing off or declaring DONE, include an operations reflection: time/tokens, major delays, important errors, benchmark reliability concerns, and lessons for future runs.
`;
	}

	if (turn.phase === "WORKER_RUN") {
		return `${common}
[WORKER MODE]
Execute exactly one bounded task from the latest ANALYST worker instruction. Do not continue into a second task. Put logs/scratch files under ${artifacts}.

Required sections:
## Task understood
## Actions taken
## Result
## Validation
## Diff / artifacts
## Worker recommendation / next steps
## Stop / handoff
`;
	}

	return `${common}
[ANALYST REVIEW MODE]
Review the latest worker result, update the high-level plan, and decide the next state. If more work is needed, produce exactly one next detailed worker stage. Ask the operator only when the result is done, blocked, ambiguous, risky, contradictory, or needs a human trade-off.

Required sections:
## Diagnosis / Review
## Hypothesis
## Worker instruction
## Validation / Risks
## Next state
## Operator handoff

When handing off or declaring DONE, include an operations reflection: time/tokens, major delays, important errors, benchmark reliability concerns, and lessons for future runs.
`;
}

function prependAssistantHeader(message: any, header: string, role: Role): any {
	sanitizeAssistantErrorInPlace(message);
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const prefix = role === "ANALYST" ? "[ANALYST:" : "[WORKER:";
	const firstText = message.content.find((part: any) => part?.type === "text");
	if (firstText?.text?.trimStart().startsWith(prefix)) return message;

	const content = [...message.content];
	const idx = content.findIndex((part: any) => part?.type === "text");
	if (idx >= 0) {
		content[idx] = { ...content[idx], text: `${header}\n\n${content[idx].text ?? ""}` };
	} else {
		content.unshift({ type: "text", text: `${header}\n\n` });
	}
	return { ...message, content };
}

async function nextArchiveDir(run: AwRun): Promise<string> {
	const date = new Date(run.config.startedAt);
	const base = resolve(
		run.config.cwd,
		"docs",
		"prompts",
		String(date.getFullYear()),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
	);
	await mkdir(base, { recursive: true });
	const entries = await readdir(base).catch(() => [] as string[]);
	const max = entries.reduce((acc, name) => {
		const n = Number(name.match(/^(\d{3})_/)?.[1] ?? 0);
		return Number.isFinite(n) ? Math.max(acc, n) : acc;
	}, 0);
	return join(base, `${String(max + 1).padStart(3, "0")}_${run.config.taskSlug}`);
}

export default function analystWorkerExtension(pi: ExtensionAPI) {
	let run: AwRun | undefined;
	let activeTurn: ActiveTurn | undefined;
	const validatedModels = new Set<string>();
	const activeToolStarts = new Map<string, { started: number; step: number; toolName: string }>();

	async function saveRun(ctx?: ExtensionContext): Promise<void> {
		if (!run) return;
		run.updatedAt = nowIso();
		await writeState(run);
		pi.appendEntry(STATE_ENTRY, run);
		if (ctx) updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!run) {
			ctx.ui.setStatus("aw", undefined);
			return;
		}
		ctx.ui.setStatus("aw", `AW ${run.state} #${run.currentStep}`);
	}

	function sendMessage(content: string, details?: unknown): void {
		pi.sendMessage({ customType: CUSTOM_MESSAGE, content, display: true, details });
	}

	function beginWork(ctx: ExtensionContext, message: string, details?: unknown): () => void {
		sendMessage(`[SYSTEM]\n${message}`, { type: "progress", ...(typeof details === "object" && details ? details : {}) });
		let interval: NodeJS.Timeout | undefined;
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setWorkingMessage(message);
			ctx.ui.setWorkingVisible(true);
			const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			let i = 0;
			const render = () => ctx.ui.setStatus("aw-work", ctx.ui.theme.fg("accent", `${frames[i++ % frames.length]} Working: ${message}`));
			render();
			interval = setInterval(render, 100);
		}
		let done = false;
		return () => {
			if (done) return;
			done = true;
			if (interval) clearInterval(interval);
			if (ctx.hasUI) {
				ctx.ui.setStatus("aw-work", undefined);
				ctx.ui.setWorkingVisible(false);
				ctx.ui.setWorkingMessage();
			}
		};
	}

	async function restoreInteractiveModel(ctx: ExtensionContext, reason: string): Promise<void> {
		if (!run) return;
		const current = ctx.model ? modelRef(ctx.model) : undefined;
		const preferred = run.operatorModel && !shouldUseExternalAnalyst(run.operatorModel) ? run.operatorModel : undefined;
		const safeFallback = !shouldUseExternalAnalyst(run.config.workerModel) ? run.config.workerModel : undefined;
		const target = preferred ?? safeFallback ?? run.operatorModel;
		const targetThinking = preferred ? run.operatorThinkingLevel : safeFallback ? roleThinkingLevel(run, "WORKER") : run.operatorThinkingLevel;
		if (!target) return;
		const model = findModel(ctx, target);
		if (!model) return;
		let changed = false;
		if (current !== target) {
			const ok = await pi.setModel(model);
			if (!ok) return;
			changed = true;
		}
		if (targetThinking) {
			const clamped = clampThinkingLevelForModel(model, targetThinking);
			if (pi.getThinkingLevel() !== clamped) {
				pi.setThinkingLevel(clamped);
				changed = true;
			}
		}
		if (changed) {
			sendMessage(`[SYSTEM]\nRestored interactive model to ${target}${targetThinking ? ` with ${targetThinking} thinking` : ""} after Analyst/Worker ${reason}.`, { type: "progress", model: target, thinkingLevel: targetThinking, reason });
		}
	}

	function shouldRestoreInteractiveModel(run: AwRun): boolean {
		return run.state === "DONE_NEEDS_OPERATOR_CONFIRMATION" || run.state === "BLOCKED_NEEDS_OPERATOR" || run.state === "ABORTED" || run.state === "WAITING_FOR_OPERATOR";
	}

	async function ensureModelReady(ctx: ExtensionContext, ref: string, role: Role, state: AwStateName = "CONFIGURING", updateRunOnFailure = true, thinkingLevel?: ThinkingLevel): Promise<boolean> {
		const model = findModel(ctx, ref);
		const effectiveThinking = clampThinkingLevelForModel(model, thinkingLevel ?? (run ? roleThinkingLevel(run, role) : pi.getThinkingLevel()));
		const validationKey = `${ref}:${effectiveThinking}`;
		if (shouldSkipModelProbe() || validatedModels.has(validationKey)) return true;
		const endWork = beginWork(ctx, `Probing ${role.toLowerCase()} model ${ref} with ${effectiveThinking} thinking...`, { role, model: ref, thinkingLevel: effectiveThinking });
		let result: Awaited<ReturnType<typeof probeModelRequest>>;
		try {
			result = await probeModelRequest(pi, ctx, ref, role, effectiveThinking);
		} finally {
			endWork();
		}
		if (result.ok) {
			validatedModels.add(validationKey);
			sendMessage(`[SYSTEM]\nProbe OK: ${role.toLowerCase()} model ${ref} is available with ${effectiveThinking} thinking.`, { type: "progress", role, model: ref, thinkingLevel: effectiveThinking });
			return true;
		}
		const reason = `${role.toLowerCase()} model ${ref} with ${effectiveThinking} thinking failed an availability probe: ${result.error}`;
		if (run && updateRunOnFailure) {
			run.state = "BLOCKED_NEEDS_OPERATOR";
			run.nextAction = `Model ${ref} is not usable right now. Run /analyst-worker config and choose another ${role.toLowerCase()} model, or re-login/check provider access.`;
			run.operatorExpected = `Yes: choose another ${role.toLowerCase()} model or fix provider access.`;
			await saveRun(ctx);
		}
		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run?.state ?? state}\nReason: ${reason}\nExpected operator input:\n  Choose another ${role.toLowerCase()} model in the picker if it opens, or run /analyst-worker config; alternatively fix provider access and retry.\n\nTip: if OpenAI/Codex returns an HTML/Cloudflare page, use a different provider/model for this role until login/IP/VPN/access is fixed.`,
			{ type: "model-probe-failed", role, model: ref, error: result.error },
		);
		return false;
	}

	function restore(ctx: ExtensionContext): void {
		let restored: AwRun | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && isAwRun(entry.data)) {
				restored = entry.data;
			}
		}
		run = restored;
		if (run && typeof run.workerStepsSinceOperator !== "number") run.workerStepsSinceOperator = 0;
		updateStatus(ctx);
		if (run && shouldRestoreInteractiveModel(run)) {
			void restoreInteractiveModel(ctx, "session restore").catch(() => undefined);
		}
	}

	async function maybeCompactBeforeTurn(ctx: ExtensionContext, phase: Phase, model: string, step: number): Promise<boolean> {
		const role = phaseRole(phase);
		if (!run) return false;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return false;
		const configuredLimit = roleContextLimit(run, role);
		const effectiveLimit = Math.min(configuredLimit || usage.contextWindow, usage.contextWindow || configuredLimit);
		if (!effectiveLimit || usage.tokens < effectiveLimit * 0.9) return false;

		// openai-codex analyst turns are executed in a proxy-safe child `pi` process and
		// do not need the main in-process context. Avoid invoking Pi's in-process
		// compactor while the current model is openai-codex; compact before the next
		// worker turn instead, using the worker model that already works in-process.
		if (role === "ANALYST" && shouldUseExternalAnalyst(model)) return false;

		let compactModelRef = model;
		if (shouldUseExternalAnalyst(compactModelRef) && run.config.workerModel && !shouldUseExternalAnalyst(run.config.workerModel)) {
			compactModelRef = run.config.workerModel;
		}
		if (compactModelRef !== model) {
			const compactModel = findModel(ctx, compactModelRef);
			if (compactModel && (await ensureModelReady(ctx, compactModelRef, phaseRole("WORKER_RUN"), "CONFIGURING", false))) {
				const setForCompaction = await pi.setModel(compactModel);
				if (setForCompaction) pi.setThinkingLevel(clampThinkingLevelForModel(compactModel, roleThinkingLevel(run, "WORKER")));
				else compactModelRef = model;
			} else {
				compactModelRef = model;
			}
		}

		run.state = "BLOCKED_NEEDS_OPERATOR";
		run.nextAction = "Context is near the configured limit. Pi compaction is running; workflow will continue automatically when compaction completes.";
		run.operatorExpected = "No: wait for compaction to finish. Intervene only if compaction fails.";
		await saveRun(ctx);

		const compactionStartedAt = nowIso();
		const compactionStartedMs = Date.now();
		const endWork = beginWork(ctx, `Compacting context before ${phaseLabel(phase)}...`, { phase, model: compactModelRef });

		sendMessage(
			`[${role}: ${model}]\nStep: ${stepId(step)}\nState: NEEDS_COMPACTION\nTask: ${run.config.taskSlug}\nContext: ${usage.tokens} / ${effectiveLimit}\nAction: compacting state before continuing${compactModelRef !== model ? `\nCompaction model: ${compactModelRef}` : ""}`,
			{ type: "context-compaction", usage, effectiveLimit, model: compactModelRef },
		);
		ctx.compact({
			customInstructions: `Compact for Pi Analyst/Worker task ${run.config.taskId}. Preserve current hypothesis, high-level plan, done/open questions, latest analyst instruction, latest worker result, validation, risks, and artifact paths from ${displayPath(statePath(run), run.config.cwd)}.`,
			onComplete: (result) => {
				endWork();
				void (async () => {
					if (!run) return;
					await appendCompaction(run, {
						started_at: compactionStartedAt,
						finished_at: nowIso(),
						model: compactModelRef,
						phase,
						wall_ms: Date.now() - compactionStartedMs,
						tokens_before: result.tokensBefore ?? usage.tokens ?? null,
						status: "completed",
					});
					sendMessage(`[SYSTEM]\nCompaction completed; continuing automatically with ${phaseLabel(phase)}.`, { type: "context-compaction-complete", result });
					await startRoleTurn(ctx, phase, true);
				})().catch((error) => sendMessage(operatorMessage(run!, `Post-compaction continuation failed: ${sanitizeProviderError(error)}`, "Run /analyst-worker to continue."), { type: "model-probe-failed" }));
			},
			onError: (error) => {
				endWork();
				void (async () => {
					if (!run) return;
					await appendCompaction(run, {
						started_at: compactionStartedAt,
						finished_at: nowIso(),
						model: compactModelRef,
						phase,
						wall_ms: Date.now() - compactionStartedMs,
						tokens_before: usage.tokens ?? null,
						status: "failed",
						error: sanitizeProviderError(error, 1200),
					});
				})();
				sendMessage(
					operatorMessage(
						run!,
						`Compaction failed: ${sanitizeProviderError(error, 1200)}`,
						"Resolve context manually, switch/reauthenticate the analyst model, or raise context limits, then run /analyst-worker.",
					),
					{ type: "model-probe-failed" },
				);
			},
		});
		return true;
	}

	// MVP runner: role-switched turns in the current Pi session. Keep this
	// boundary narrow so a future version can replace it with nested Pi/RPC calls.
	async function startRoleTurn(ctx: ExtensionContext, phase: Phase, auto = false): Promise<void> {
		if (!run) return;
		const role = phaseRole(phase);
		const ref = role === "ANALYST" ? run.config.analystModel : run.config.workerModel;
		const model = findModel(ctx, ref);
		const thinkingLevel = clampThinkingLevelForModel(model, roleThinkingLevel(run, role));
		if (!model) {
			run.state = "BLOCKED_NEEDS_OPERATOR";
			run.nextAction = `Model not found: ${ref}. Run /analyst-worker config or choose a valid model.`;
			run.operatorExpected = "Yes: configure a valid model.";
			await saveRun(ctx);
			sendMessage(operatorMessage(run, `Model not found: ${ref}`, "Run /model or /analyst-worker config with a valid model."));
			return;
		}

		if (!(await ensureModelReady(ctx, ref, role, phaseState(phase), true, thinkingLevel))) return;

		const usesExternalAnalyst = role === "ANALYST" && shouldUseExternalAnalyst(ref);
		if (!usesExternalAnalyst) {
			const ok = await pi.setModel(model);
			if (!ok) {
				run.state = "BLOCKED_NEEDS_OPERATOR";
				run.nextAction = `No configured auth for model ${ref}.`;
				run.operatorExpected = "Yes: login/configure API key or pick another model.";
				await saveRun(ctx);
				sendMessage(operatorMessage(run, `No configured auth for ${ref}`, "Use /login, configure API key, or restart with another model."));
				return;
			}
			pi.setThinkingLevel(thinkingLevel);
		} else {
			// External Analyst turns are executed by a child `pi` process. Do not set
			// the main interactive session to openai-codex here: the main in-process
			// Codex transport can bypass the terminal proxy, and ordinary user prompts
			// after the workflow should keep using the previous/safe interactive model.
			await restoreInteractiveModel(ctx, "external analyst turn");
		}

		const nextStep = run.currentStep + 1;
		if (await maybeCompactBeforeTurn(ctx, phase, ref, nextStep)) return;

		if (!auto) run.workerStepsSinceOperator = 0;
		run.currentStep = nextStep;
		run.state = phaseState(phase);
		run.nextRole = role;
		run.nextPhase = phase;
		run.nextAction = `${role} is running: ${phaseLabel(phase)}.`;
		run.operatorExpected = auto ? "No: workflow is continuing automatically." : "No: role turn is running.";
		await saveRun(ctx);

		activeTurn = {
			role,
			phase,
			step: nextStep,
			model: ref,
			thinkingLevel,
			stateAtStart: run.state,
			startedAt: nowIso(),
			auto,
			toolMs: 0,
			toolCounts: {},
			toolErrors: 0,
			externalMs: 0,
		};

		if (role === "ANALYST" && shouldUseExternalAnalyst(ref)) {
			try {
				await runExternalAnalystTurn(ctx, activeTurn);
			} catch (error) {
				if (!run || !activeTurn) return;
				const message = syntheticAssistantMessage(ref, "", sanitizeProviderError(error));
				await finishTurn({ type: "agent_end", messages: [message] } as AgentEndEvent, ctx);
			}
			return;
		}

		const prompt = buildRolePrompt(run, activeTurn);
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	async function runExternalAnalystTurn(ctx: ExtensionContext, turn: ActiveTurn): Promise<void> {
		if (!run) return;
		const prompt = await buildExternalAnalystPrompt(run, turn);
		sendMessage(
			`${turnHeader(run, turn)}\nAction: analyst review running\nModel: ${turn.model}\nThinking: ${turn.thinkingLevel}`,
			{ type: "external-analyst-start", turn },
		);
		const endWork = beginWork(ctx, `Running analyst ${turn.model} (${turn.thinkingLevel} thinking)...`, { role: turn.role, model: turn.model, thinkingLevel: turn.thinkingLevel, step: turn.step });
		let result: Awaited<ReturnType<typeof runQuickPiPrompt>>;
		try {
			result = await runQuickPiPrompt(pi, ctx, turn.model, turn.thinkingLevel, ANALYST_SYSTEM, prompt, 180000);
		} finally {
			endWork();
		}
		if (!run || activeTurn !== turn) return;
		turn.externalMs += result.wallMs;
		if (result.ok) {
			const text = result.text.trim();
			sendMessage(`${turnHeader(run, turn)}\n\n${text}`, { type: "external-analyst-output", turn });
			await finishTurn({ type: "agent_end", messages: [syntheticAssistantMessage(turn.model, text, undefined, result.usage)] } as AgentEndEvent, ctx);
		} else {
			const error = result.error;
			sendMessage(`${turnHeader(run, turn)}\n\nError: ${error}`, { type: "model-probe-failed", role: turn.role, model: turn.model, error });
			await finishTurn({ type: "agent_end", messages: [syntheticAssistantMessage(turn.model, "", error)] } as AgentEndEvent, ctx);
		}
	}

	async function finishTurn(event: AgentEndEvent, ctx: ExtensionContext): Promise<void> {
		if (!run || !activeTurn) return;
		const turn = activeTurn;
		activeTurn = undefined;

		const finishedMs = Date.now();
		const timing = timingForTurn(turn, finishedMs);
		const messages = event.messages as any[];
		const usage = usageFromMessages(messages);
		const transcript = transcriptFromMessages(messages);
		const text = assistantText(messages);
		let stateAfter: AwStateName = "WAITING_FOR_OPERATOR";
		let nextPhase: Phase | null = "WORKER_RUN";
		let nextRole: Role | null = "WORKER";
		let autoNextPhase: Phase | null = null;
		let reason = `${turn.role.toLowerCase()} ${phaseLabel(turn.phase)} finished`;
		let expected = "No operator action needed; workflow is continuing automatically.";

		const stopDone = () => {
			stateAfter = "DONE_NEEDS_OPERATOR_CONFIRMATION";
			nextPhase = null;
			nextRole = null;
			autoNextPhase = null;
			run!.nextAction = "Review completion summary, then run /analyst-worker finish or /analyst-worker archive.";
			run!.operatorExpected = "Yes: confirm completion and choose archive action.";
			expected = "Confirm completion with /analyst-worker finish or archive with /analyst-worker archive.";
		};

		const stopAbort = () => {
			stateAfter = "ABORTED";
			nextPhase = null;
			nextRole = null;
			autoNextPhase = null;
			run!.nextAction = "Workflow aborted by analyst recommendation.";
			run!.operatorExpected = "Yes: inspect artifacts and decide cleanup.";
			expected = "Inspect artifacts, then /analyst-worker archive --keep-tmp or cleanup manually.";
		};

		const stopNeedsOperator = () => {
			stateAfter = "BLOCKED_NEEDS_OPERATOR";
			nextPhase = "ANALYST_PLAN";
			nextRole = "ANALYST";
			autoNextPhase = null;
			run!.nextAction = "Operator input is required before another worker step.";
			run!.operatorExpected = "Yes: answer the analyst question, then run /analyst-worker.";
			expected = "Answer the analyst question, then run /analyst-worker.";
		};

		const continueWithWorker = (why: string) => {
			stateAfter = "WORKER_RUNNING";
			nextPhase = "WORKER_RUN";
			nextRole = "WORKER";
			autoNextPhase = "WORKER_RUN";
			reason = why;
			run!.nextAction = "Workflow is continuing automatically with the next worker stage.";
			run!.operatorExpected = "No: worker executes the next bounded stage automatically.";
			expected = "No operator action needed. Interrupt only if you need to steer.";
		};

		const substantiveText = text.replace(turnHeader(run, turn), "").trim();
		const analystProducedPlan = turn.role !== "ANALYST" || substantiveText.length >= 80;

		if (turn.phase === "ANALYST_PLAN") {
			const next = parseAnalystNextState(text);
			if (!analystProducedPlan) {
				stopNeedsOperator();
				run.nextAction = "Analyst model produced no substantive plan. Switch/reauthenticate the analyst model before continuing.";
				run.operatorExpected = "Yes: switch/reauthenticate analyst model or run /analyst-worker config.";
				reason = "analyst produced no substantive plan";
				expected = "Switch/reauthenticate the analyst model or run /analyst-worker config, then continue.";
			} else if (next === "DONE") stopDone();
			else if (next === "ABORT") stopAbort();
			else if (next === "NEEDS_OPERATOR") stopNeedsOperator();
			else continueWithWorker("analyst planned the first detailed worker stage; starting worker automatically");
		}

		if (turn.phase === "WORKER_RUN") {
			run.workerStepsSinceOperator = (run.workerStepsSinceOperator ?? 0) + 1;
			stateAfter = "ANALYST_REVIEWING";
			nextPhase = "ANALYST_REVIEW";
			nextRole = "ANALYST";
			autoNextPhase = "ANALYST_REVIEW";
			run.nextAction = "Workflow is continuing automatically with analyst review of the worker result.";
			run.operatorExpected = "No: analyst review will run automatically.";
			reason = "worker stage finished; starting analyst review automatically";
			expected = "No operator action needed. Analyst will review and either plan the next stage or ask for help.";
		}

		if (turn.phase === "ANALYST_REVIEW") {
			const next = parseAnalystNextState(text);
			if (!analystProducedPlan) {
				stopNeedsOperator();
				run.nextAction = "Analyst model produced no substantive review/next plan. Switch/reauthenticate the analyst model before continuing.";
				run.operatorExpected = "Yes: switch/reauthenticate analyst model or run /analyst-worker config.";
				reason = "analyst produced no substantive review/next plan";
				expected = "Switch/reauthenticate the analyst model or run /analyst-worker config, then continue.";
			} else if (next === "DONE") {
				stopDone();
			} else if (next === "ABORT") {
				stopAbort();
			} else if (next === "NEEDS_OPERATOR") {
				stopNeedsOperator();
			} else if ((run.workerStepsSinceOperator ?? 0) >= MAX_AUTONOMOUS_WORKER_STEPS) {
				stateAfter = "BLOCKED_NEEDS_OPERATOR";
				nextPhase = "WORKER_RUN";
				nextRole = "WORKER";
				autoNextPhase = null;
				run.nextAction = "Safety stop: many worker stages ran without operator input. Inspect progress, then run /analyst-worker to continue.";
				run.operatorExpected = "Yes: inspect progress and explicitly continue if desired.";
				reason = "safety stop after many autonomous worker stages";
				expected = "Inspect state/reports, then run /analyst-worker to continue or steer.";
			} else {
				continueWithWorker("analyst reviewed the result and planned the next worker stage; starting worker automatically");
			}
		}

		run.state = stateAfter;
		run.nextPhase = nextPhase;
		run.nextRole = nextRole;
		const reportAbs = join(stepsDir(run), `${stepId(turn.step)}_${phaseFileName(turn.phase)}.md`);
		run.lastReportPath = displayPath(reportAbs, run.config.cwd);
		if (turn.role === "ANALYST") run.lastAnalystReportPath = run.lastReportPath;
		else run.lastWorkerReportPath = run.lastReportPath;
		await saveRun(ctx);
		await writeFile(reportAbs, stepReportMarkdown(turn, run, usage, stateAfter, transcript, timing), "utf8");

		const ledger = await readLedger(run);
		const previous = ledger.totals[turn.model] ?? { in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0 };
		const cumulative = addUsage(previous, usage);
		ledger.totals[turn.model] = cumulative;
		const contextUsage = ctx.getContextUsage();
		ledger.steps.push({
			...usage,
			...timing,
			step: turn.step,
			role: turn.role,
			phase: turn.phase,
			model: turn.model,
			thinking_level: turn.thinkingLevel,
			state_after: stateAfter,
			cumulative_model_in: cumulative.in,
			cumulative_model_out: cumulative.out,
			context_tokens: contextUsage?.tokens ?? null,
			context_window: contextUsage?.contextWindow ?? null,
			context_percent: contextUsage?.percent ?? null,
			started_at: turn.startedAt,
			finished_at: run.updatedAt,
			artifact: run.lastReportPath,
		});
		await writeLedger(run, ledger);

		const totalsText = Object.entries(ledger.totals)
			.map(([model, total]) => `  ${model}: IN ${total.in}, OUT ${total.out}, cache read ${total.cache_read}, cache write ${total.cache_write}, cost ${formatMoney(total.cost)}`)
			.join("\n");
		const usageBlock = `Step usage (${turn.model}, ${turn.thinkingLevel} thinking): ${formatUsage(usage)}\nStep time: ${formatTiming(timing)}\nCumulative by model:\n${totalsText || "  none"}\nReport: ${run.lastReportPath}`;
		if (autoNextPhase) {
			sendMessage(
				`${turnHeader(run, turn)}\nState: CONTINUING\nAction: ${reason}\nNext: ${phaseLabel(autoNextPhase)} (${phaseRole(autoNextPhase)})\n\n${usageBlock}`,
				{ type: "step-continue", step: turn.step, role: turn.role, phase: turn.phase, nextPhase: autoNextPhase, usage, totals: ledger.totals },
			);
			await startRoleTurn(ctx, autoNextPhase, true);
		} else {
			await restoreInteractiveModel(ctx, "operator handoff");
			sendMessage(
				`${operatorMessage(run, reason, expected)}\n\n${usageBlock}`,
				{ type: "step-complete", step: turn.step, role: turn.role, phase: turn.phase, usage, totals: ledger.totals },
			);
		}
	}

	async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
		if (run && shouldRestoreInteractiveModel(run)) await restoreInteractiveModel(ctx, "status");
		if (!run) {
			sendMessage("[OPERATOR HANDOFF]\nState: IDLE\nReason: Analyst/Worker mode is not started.\nExpected operator input:\n  Run /analyst-worker.");
			return;
		}
		const ledger = await readLedger(run);
		const totalsText = Object.entries(ledger.totals)
			.map(([model, total]) => `- ${model}: IN ${total.in}, OUT ${total.out}, cache read ${total.cache_read}, cache write ${total.cache_write}, cost ${formatMoney(total.cost)}`)
			.join("\n");
		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run.state}\nReason: status requested\nExpected operator input:\n  ${run.nextAction}\n\nTask: ${run.config.taskTitle}\nStep: ${run.currentStep}\nPaused: ${run.paused ? "yes" : "no"}\nState file: ${displayPath(statePath(run), ctx.cwd)}\nLedger: ${displayPath(ledgerPath(run), ctx.cwd)}\nNext role: ${run.nextRole ?? "none"}\nNext phase: ${run.nextPhase ?? "none"}\nAnalyst: ${run.config.analystModel} (${roleThinkingLevel(run, "ANALYST")} thinking)\nWorker: ${run.config.workerModel} (${roleThinkingLevel(run, "WORKER")} thinking)\n\nToken totals:\n${totalsText || "- none yet"}\n\nTime totals:\n${ledgerTimingSummary(ledger)}`,
			{ type: "status", run, ledger },
		);
	}

	pi.registerMessageRenderer(CUSTOM_MESSAGE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : textFromContent(message.content);
		const details = message.details as { type?: string } | undefined;
		const isError =
			details?.type === "model-probe-failed" ||
			/\bfailed an availability probe\b|\bCompaction failed\b|\bError:/i.test(text) ||
			/\bState:\s*(BLOCKED_NEEDS_OPERATOR|ABORTED)\b/i.test(text);
		if (isError) return new Text(theme.fg("error", text), 0, 0);
		return undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!run || !activeTurn) return;
		const rolePrompt = activeTurn.role === "ANALYST" ? ANALYST_SYSTEM : WORKER_SYSTEM;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${rolePrompt}\n\nCurrent Analyst/Worker state file: ${displayPath(statePath(run), run.config.cwd)}\nCurrent Analyst/Worker ledger: ${displayPath(ledgerPath(run), run.config.cwd)}\nAlways obey the role header and bounded-step protocol.`,
		};
	});

	pi.on("message_update", (event: MessageUpdateEvent) => {
		if (event.message.role !== "assistant") return;
		sanitizeAssistantErrorInPlace(event.message);
		const assistantEvent = event.assistantMessageEvent as any;
		sanitizeAssistantErrorInPlace(assistantEvent?.partial);
		sanitizeAssistantErrorInPlace(assistantEvent?.error);
	});

	pi.on("message_end", (event: MessageEndEvent) => {
		if (event.message.role !== "assistant") return;
		sanitizeAssistantErrorInPlace(event.message);
		if (!run || !activeTurn) return { message: event.message };
		return { message: prependAssistantHeader(event.message, turnHeader(run, activeTurn), activeTurn.role) };
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (!run || !activeTurn) return;
		if (!toolAllowed(run.config.toolPolicy, event.toolName)) {
			return { block: true, reason: `pi-analyst-worker tool policy ${run.config.toolPolicy} blocks ${event.toolName}` };
		}
	});

	pi.on("tool_execution_start", (event) => {
		if (!activeTurn) return;
		activeToolStarts.set(event.toolCallId, { started: Date.now(), step: activeTurn.step, toolName: event.toolName });
	});

	pi.on("tool_execution_end", (event) => {
		const started = activeToolStarts.get(event.toolCallId);
		if (!started) return;
		activeToolStarts.delete(event.toolCallId);
		if (!activeTurn || activeTurn.step !== started.step) return;
		activeTurn.toolMs += Math.max(0, Date.now() - started.started);
		activeTurn.toolCounts[started.toolName] = (activeTurn.toolCounts[started.toolName] ?? 0) + 1;
		if (event.isError) activeTurn.toolErrors += 1;
	});

	pi.on("agent_end", async (event, ctx) => {
		await finishTurn(event, ctx);
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	function getFallbackModel(ctx: ExtensionCommandContext): string | undefined {
		const model = ctx.model ?? ctx.modelRegistry.getAvailable()[0] ?? ctx.modelRegistry.getAll()[0];
		return model ? modelRef(model) : undefined;
	}

	async function chooseRoleSettings(
		ctx: ExtensionCommandContext,
		role: Role,
		title: string,
		fallbackModel: string,
		fallbackThinking: ThinkingLevel,
	): Promise<{ model: string; thinkingLevel: ThinkingLevel } | undefined> {
		const selected = await chooseModel(ctx, title, fallbackModel);
		if (!selected) return undefined;
		const selectedModel = findModel(ctx, selected);
		const thinkingLevel = await chooseThinkingLevel(ctx, role, selected, clampThinkingLevelForModel(selectedModel, fallbackThinking));
		if (!thinkingLevel) return undefined;
		return { model: selected, thinkingLevel };
	}

	async function collectSettings(
		ctx: ExtensionCommandContext,
		fallbackModel: string,
		defaults?: Partial<WorkflowSettings>,
	): Promise<WorkflowSettings | undefined> {
		let analystFallbackModel = defaults?.analystModel ?? fallbackModel;
		let analystFallbackThinking = normalizeThinkingLevel(defaults?.analystThinkingLevel, DEFAULT_ROLE_THINKING.ANALYST);
		let workerFallbackModel = defaults?.workerModel ?? fallbackModel;
		let workerFallbackThinking = normalizeThinkingLevel(defaults?.workerThinkingLevel, DEFAULT_ROLE_THINKING.WORKER);
		let analyst: { model: string; thinkingLevel: ThinkingLevel } | undefined;
		let worker: { model: string; thinkingLevel: ThinkingLevel } | undefined;

		for (let attempt = 0; attempt < 3; ++attempt) {
			const retrySuffix = attempt === 0 ? "" : " (previous model/thinking probe failed)";
			analyst = await chooseRoleSettings(
				ctx,
				"ANALYST",
				`Please choose analyst model — smart reasoning model, e.g. openai/gpt-5.5 with high thinking${retrySuffix}`,
				analystFallbackModel,
				analystFallbackThinking,
			);
			if (!analyst) return undefined;
			worker = await chooseRoleSettings(
				ctx,
				"WORKER",
				`Please choose worker model — capable coding/execution model; can be faster/cheaper than analyst${retrySuffix}`,
				workerFallbackModel,
				workerFallbackThinking,
			);
			if (!worker) return undefined;

			sendMessage(`[SYSTEM]\nModel selection complete. Probing analyst first, then worker...`, { type: "progress" });
			const analystReady = await ensureModelReady(ctx, analyst.model, "ANALYST", "CONFIGURING", false, analyst.thinkingLevel);
			const workerReady = analystReady && (await ensureModelReady(ctx, worker.model, "WORKER", "CONFIGURING", false, worker.thinkingLevel));
			if (analystReady && workerReady) break;

			analystFallbackModel = analyst.model;
			analystFallbackThinking = analyst.thinkingLevel;
			workerFallbackModel = worker.model;
			workerFallbackThinking = worker.thinkingLevel;
			analyst = undefined;
			worker = undefined;
		}

		if (!analyst || !worker) {
			sendMessage(
				`[OPERATOR HANDOFF]\nState: CONFIGURING\nReason: model/thinking selection cancelled after repeated failed probes\nExpected operator input:\n  Fix provider access or run /analyst-worker config again and choose a different model or thinking level.`,
				{ type: "model-probe-repeated-failure" },
			);
			return undefined;
		}

		const analystContextLimitTokens = await chooseNumber(
			ctx,
			"Analyst context limit tokens — compaction threshold; recommended: 128000",
			defaults?.analystContextLimitTokens ?? 128000,
		);
		if (!analystContextLimitTokens) return undefined;
		const workerContextLimitTokens = await chooseNumber(
			ctx,
			"Worker context limit tokens — compaction threshold; recommended: 128000",
			defaults?.workerContextLimitTokens ?? 128000,
		);
		if (!workerContextLimitTokens) return undefined;
		return {
			analystModel: analyst.model,
			analystThinkingLevel: analyst.thinkingLevel,
			workerModel: worker.model,
			workerThinkingLevel: worker.thinkingLevel,
			analystContextLimitTokens,
			workerContextLimitTokens,
			toolPolicy: "all-tools",
			maxWorkerStepsBeforeOperator: 1,
			artifactPolicy: "keep-tmp",
		};
	}

	function stripStartFlags(args: string): { taskDescription: string; forceConfigure: boolean } {
		const parts = args.split(/\s+/).filter(Boolean);
		const kept: string[] = [];
		let forceConfigure = false;
		for (const part of parts) {
			if (part === "--configure" || part === "--config" || part === "--settings") {
				forceConfigure = true;
				continue;
			}
			kept.push(part);
		}
		return { taskDescription: kept.join(" "), forceConfigure };
	}

	async function chooseTaskDescription(ctx: ExtensionCommandContext, provided: string): Promise<string | undefined> {
		const trimmed = provided.trim();
		if (trimmed) return trimmed;
		if (!ctx.hasUI) return "analyst-worker-task";
		const value = await ctx.ui.editor("Describe the global task for Analyst/Worker", "");
		const description = value?.trim();
		return description || undefined;
	}

	async function configureWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		const fallbackModel = getFallbackModel(ctx);
		if (!fallbackModel) {
			ctx.ui.notify("No models found. Configure Pi models first.", "error");
			return;
		}
		const prefs = await readPreferences(ctx.cwd);
		const defaults = run ? settingsFromRun(run) : prefs ? clampSettingsForModels(ctx, settingsFromPreferences(prefs)) : undefined;
		const settings = await collectSettings(ctx, fallbackModel, defaults);
		if (!settings) return;
		await writePreferences(ctx.cwd, settings);
		if (run) {
			Object.assign(run.config, settings);
			run.nextAction = "Settings updated. Use /analyst-worker to continue with the updated models/settings.";
			await saveRun(ctx);
		}
		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run?.state ?? "IDLE"}\nReason: Analyst/Worker settings updated\nExpected operator input:\n  Run /analyst-worker to continue, or /analyst-worker start <task> for a new task.\n\nSaved to:\n- ${SETTINGS_FILE}\n- ${globalPreferencesPath()}\n\nSaved settings:\n${settingsSummary(settings)}\n\nTo change them later: /analyst-worker config or /analyst-worker start --configure`,
			{ type: "settings-updated", settings },
		);
	}

	async function startWorkflow(rawArgs: string, ctx: ExtensionCommandContext, options?: { autoPlan?: boolean; forceConfigure?: boolean }): Promise<void> {
		const { taskDescription: taskDescriptionArg, forceConfigure: flagConfigure } = stripStartFlags(rawArgs);
		const forceConfigure = options?.forceConfigure || flagConfigure;
		const autoPlan = options?.autoPlan ?? true;

		if (run && run.state !== "ABORTED" && run.state !== "DONE_NEEDS_OPERATOR_CONFIRMATION") {
			const ok =
				!ctx.hasUI ||
				(await ctx.ui.confirm(
					"Restart Analyst/Worker?",
					`Current task: ${run.config.taskTitle}\nState: ${run.state}\n\nStarting a new task will keep existing artifacts but switch the active workflow state.`,
				));
			if (!ok) return;
		}

		const fallbackModel = getFallbackModel(ctx);
		if (!fallbackModel) {
			ctx.ui.notify("No models found. Configure Pi models first.", "error");
			return;
		}

		const prefsSource = await readPreferencesSource(ctx.cwd);
		const prefs = prefsSource?.prefs;
		let settings: WorkflowSettings | undefined;
		if (prefs && !forceConfigure) {
			sendMessage(`[SYSTEM]\nChecking saved Analyst/Worker settings and model availability...`, { type: "progress" });
			const analystExists = Boolean(findModel(ctx, prefs.analystModel));
			const workerExists = Boolean(findModel(ctx, prefs.workerModel));
			if (analystExists && workerExists) {
				const savedSettings = clampSettingsForModels(ctx, settingsFromPreferences(prefs));
				const analystReady = await ensureModelReady(ctx, savedSettings.analystModel, "ANALYST", "CONFIGURING", false, savedSettings.analystThinkingLevel);
				const workerReady = analystReady && (await ensureModelReady(ctx, savedSettings.workerModel, "WORKER", "CONFIGURING", false, savedSettings.workerThinkingLevel));
				if (analystReady && workerReady) {
					settings = savedSettings;
					sendMessage(
						`[OPERATOR HANDOFF]\nState: CONFIGURING\nReason: using saved Analyst/Worker settings from ${prefsSource?.source ?? SETTINGS_FILE}\nExpected operator input:\n  Nothing needed. To change models, thinking levels, or limits, run /analyst-worker config or /analyst-worker start --configure.\n\nUsing:\n${settingsSummary(settings)}`,
						{ type: "using-saved-settings", settings },
					);
				}
			} else {
				sendMessage(
					`[OPERATOR HANDOFF]\nState: CONFIGURING\nReason: saved Analyst/Worker model no longer exists in Pi model registry\nExpected operator input:\n  Choose replacement models in the settings wizard.\n\nSaved analyst model found: ${analystExists ? "yes" : "no"} (${prefs.analystModel})\nSaved worker model found: ${workerExists ? "yes" : "no"} (${prefs.workerModel})`,
					{ type: "saved-settings-invalid", prefs },
				);
			}
		}

		if (!settings) {
			const defaults = prefs ? clampSettingsForModels(ctx, settingsFromPreferences(prefs)) : run ? settingsFromRun(run) : undefined;
			settings = await collectSettings(ctx, fallbackModel, defaults);
			if (!settings) return;
			await writePreferences(ctx.cwd, settings);
			sendMessage(
				`[OPERATOR HANDOFF]\nState: CONFIGURING\nReason: Analyst/Worker settings saved to ${SETTINGS_FILE} and ${globalPreferencesPath()}\nExpected operator input:\n  Future /analyst-worker starts will reuse these settings automatically, including in other folders.\n\nSaved settings:\n${settingsSummary(settings)}\n\nTo change them later: /analyst-worker config or /analyst-worker start --configure`,
				{ type: "settings-saved", settings },
			);
		}

		const taskDescription = await chooseTaskDescription(ctx, taskDescriptionArg);
		if (!taskDescription) return;
		const endTitleWork = beginWork(ctx, "Deriving short task title and artifact slug...", { type: "title-generation" });
		let taskTitle: string;
		try {
			taskTitle = await generateTaskTitle(pi, ctx, taskDescription, settings.analystModel, settings.analystThinkingLevel);
		} finally {
			endTitleWork();
		}
		const artifactDirInput = `./tmp/aw_${pathTimestamp()}_${slugify(taskTitle)}`;

		sendMessage(`[SYSTEM]\nInitializing Analyst/Worker state files...`, { type: "progress" });
		run = createRun(ctx, {
			taskTitle,
			taskDescription,
			...settings,
			artifactDir: artifactDirInput,
		});
		run.operatorThinkingLevel = pi.getThinkingLevel();

		await mkdir(stepsDir(run), { recursive: true });
		await writeLedger(run, newLedger(run));
		await saveRun(ctx);
		pi.setSessionName(`AW: ${taskTitle}`);
		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run.state}\nReason: Analyst/Worker workflow is ready\nExpected operator input:\n  ${autoPlan ? "No action needed: analyst planning starts now." : "Run /analyst-worker to continue."}\n\nHow it will run:\n  1. Analyst plans the global task and one detailed worker stage.\n  2. Worker executes that stage and reports results.\n  3. Analyst reviews, updates the plan, and either starts the next worker stage or hands off to you.\n\nUse any time:\n  /analyst-worker status\n  /analyst-worker config\n  /analyst-worker archive --keep-tmp\n\nState file: ${displayPath(statePath(run), ctx.cwd)}\nLedger: ${displayPath(ledgerPath(run), ctx.cwd)}`,
			{ type: "started", run },
		);

		if (autoPlan) {
			sendMessage(`[SYSTEM]\nStarting analyst planning...`, { type: "progress" });
			await startRoleTurn(ctx, "ANALYST_PLAN", false);
		}
	}

	async function continueWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		if (!run) {
			await startWorkflow("", ctx, { autoPlan: true });
			return;
		}
		if (run.paused) {
			sendMessage(operatorMessage(run, "Workflow is paused", "Run /analyst-worker resume, or choose Resume from /analyst-worker."));
			return;
		}
		if (!run.nextPhase || run.state === "ABORTED" || run.state === "DONE_NEEDS_OPERATOR_CONFIRMATION") {
			await restoreInteractiveModel(ctx, "idle workflow");
			sendMessage(operatorMessage(run, "No next role phase is available", "Run /analyst-worker archive, /analyst-worker start <task>, or /analyst-worker abort."));
			return;
		}
		await startRoleTurn(ctx, run.nextPhase, false);
	}

	async function pauseWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		if (!run) return showStatus(ctx);
		run.paused = true;
		run.operatorExpected = "Yes: run /analyst-worker resume to continue.";
		await saveRun(ctx);
		await restoreInteractiveModel(ctx, "pause");
		sendMessage(operatorMessage(run, "Workflow paused", "Run /analyst-worker resume to continue."));
	}

	async function resumeWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		if (!run) return showStatus(ctx);
		run.paused = false;
		run.operatorExpected = "Yes: run /analyst-worker when ready.";
		await saveRun(ctx);
		sendMessage(operatorMessage(run, "Workflow resumed", "Run /analyst-worker to choose the next action."));
	}

	async function finishWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		if (!run) return showStatus(ctx);
		run.state = "DONE_NEEDS_OPERATOR_CONFIRMATION";
		run.nextRole = null;
		run.nextPhase = null;
		run.nextAction = "Archive records with /analyst-worker archive [--commit] [--keep-tmp] [--delete-tmp].";
		run.operatorExpected = "Yes: choose archive policy.";
		await saveRun(ctx);
		await restoreInteractiveModel(ctx, "finish");
		const ledger = await readLedger(run);
		const totalsText = Object.entries(ledger.totals)
			.map(([model, total]) => `- ${model}: ${formatUsage(total)}`)
			.join("\n");
		sendMessage(`[TASK COMPLETE — OPERATOR CONFIRMATION REQUIRED]\nAnalyst: ${run.config.analystModel} (${roleThinkingLevel(run, "ANALYST")} thinking)\nWorker: ${run.config.workerModel} (${roleThinkingLevel(run, "WORKER")} thinking)\nResult: task marked complete by operator\nValidation: see ${displayPath(statePath(run), ctx.cwd)} and ${displayPath(ledgerPath(run), ctx.cwd)}\n\nToken totals:\n${totalsText || "- none"}\n\nTime totals:\n${ledgerTimingSummary(ledger)}\n\nOperational notes:\n- Review latest Analyst/Worker reports for blockers, failed commands, suspicious benchmark variance, and compaction/model issues before archiving.\n- If important errors occurred, include them in the final analyst summary so future runs can avoid them.\n\nRecommended archive action:\n  /analyst-worker archive --keep-tmp\nQuestion:\n  Finish analyst-worker mode now?`, { type: "finish", run, ledger });
	}

	async function archiveWorkflow(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!run) return showStatus(ctx);
		const commit = /(?:^|\s)--commit(?:\s|$)/.test(args);
		const deleteTmp = /(?:^|\s)--delete-tmp(?:\s|$)/.test(args) || run.config.artifactPolicy === "delete-after-finish";
		const keepTmp = /(?:^|\s)--keep-tmp(?:\s|$)/.test(args) || !deleteTmp;

		run.state = "ARCHIVING";
		await saveRun(ctx);

		const src = artifactDir(run);
		const dest = await nextArchiveDir(run);
		await mkdir(dirname(dest), { recursive: true });
		if (resolve(src) !== resolve(dest)) {
			await cp(src, dest, { recursive: true, force: true });
		}
		run.archiveDir = displayPath(dest, ctx.cwd);

		let commitOutput = "";
		run.state = "DONE_NEEDS_OPERATOR_CONFIRMATION";
		run.nextAction = "Archive completed. Use /analyst-worker start <task> for a new task.";
		run.operatorExpected = "No.";
		await saveRun(ctx);
		await restoreInteractiveModel(ctx, "archive");

		if (resolve(src) !== resolve(dest)) {
			await cp(src, dest, { recursive: true, force: true });
		}

		if (deleteTmp && !keepTmp && resolve(src) !== resolve(dest)) {
			await rm(src, { recursive: true, force: true });
		}

		if (commit) {
			const ok = !ctx.hasUI || (await ctx.ui.confirm("Commit archive/source changes?", "Run: git add -A && git commit -m 'Archive analyst-worker: ...'"));
			if (ok) {
				const add = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd, timeout: 30000 });
				const msg = `Archive analyst-worker: ${run.config.taskTitle}`;
				const gitCommit = await pi.exec("git", ["commit", "-m", msg], { cwd: ctx.cwd, timeout: 60000 });
				commitOutput = `\nGit add: ${add.code}\n${add.stderr || add.stdout}\nGit commit: ${gitCommit.code}\n${gitCommit.stderr || gitCommit.stdout}`;
			}
		}

		sendMessage(operatorMessage(run, `Archive completed at ${run.archiveDir}`, `Records ${deleteTmp && !keepTmp ? "copied and tmp deleted" : "copied; tmp kept"}.${commitOutput ? " Commit attempted." : ""}`) + commitOutput, { type: "archive", archiveDir: run.archiveDir });
	}

	async function abortWorkflow(ctx: ExtensionCommandContext): Promise<void> {
		if (!run) return showStatus(ctx);
		run.state = "ABORTED";
		run.nextRole = null;
		run.nextPhase = null;
		run.nextAction = "Workflow aborted. Inspect artifacts manually or run /analyst-worker archive --keep-tmp.";
		run.operatorExpected = "No.";
		await saveRun(ctx);
		await restoreInteractiveModel(ctx, "abort");
		sendMessage(operatorMessage(run, "Workflow aborted", "Inspect artifacts or start a new run with /analyst-worker start <task>."));
	}

	function showHelp(): void {
		sendMessage(`[OPERATOR HANDOFF]\nState: ${run?.state ?? "IDLE"}\nReason: help requested\nExpected operator input:\n  Use /analyst-worker with no arguments for the smart menu.\n\nCommands:\n  /analyst-worker                         start or continue via smart menu\n  /analyst-worker <global task>           start new task using saved settings\n  /analyst-worker start --configure       start and reconfigure models/settings\n  /analyst-worker status                  show state files and token ledger\n  /analyst-worker config                  change saved analyst/worker settings\n  /analyst-worker pause | resume\n  /analyst-worker finish\n  /analyst-worker archive --keep-tmp      archive records\n  /analyst-worker abort\n\nWorkflow continues analyst → worker → analyst automatically until DONE, NEEDS_OPERATOR, ABORT, context compaction, or safety stop.\nSaved settings file: ${SETTINGS_FILE}`);
	}

	async function smartMenu(ctx: ExtensionCommandContext): Promise<void> {
		if (!run || run.state === "ABORTED") {
			await startWorkflow("", ctx, { autoPlan: true });
			return;
		}

		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run.state}\nReason: /analyst-worker opened the control panel\nExpected operator input:\n  Choose an action below. Continue resumes the automatic analyst → worker loop.\n\nTask: ${run.config.taskTitle}\nNext: ${run.nextPhase ?? "none"} (${run.nextRole ?? "none"})\nModels: analyst ${run.config.analystModel} (${roleThinkingLevel(run, "ANALYST")}), worker ${run.config.workerModel} (${roleThinkingLevel(run, "WORKER")})\nChange models/settings: /analyst-worker config`,
			{ type: "control-panel", run },
		);

		if (!ctx.hasUI) {
			await continueWorkflow(ctx);
			return;
		}

		const options: string[] = [];
		if (run.state !== "DONE_NEEDS_OPERATOR_CONFIRMATION" && run.nextPhase && !run.paused) {
			options.push(`continue: resume automatic loop from ${run.nextRole} (${run.nextPhase})`);
		}
		if (run.paused) options.push("resume: resume workflow");
		options.push("status: show state and ledger");
		options.push("config: change models/settings");
		if (run.state !== "DONE_NEEDS_OPERATOR_CONFIRMATION") options.push("pause: pause workflow");
		options.push("finish: mark complete");
		options.push("archive: archive records");
		options.push("start: start a new task");
		options.push("abort: abort workflow");

		const choice = await ctx.ui.select("Analyst Worker", options);
		if (!choice) return;
		const action = choice.split(":")[0];
		if (action === "continue") return continueWorkflow(ctx);
		if (action === "resume") return resumeWorkflow(ctx);
		if (action === "status") return showStatus(ctx);
		if (action === "config") return configureWorkflow(ctx);
		if (action === "pause") return pauseWorkflow(ctx);
		if (action === "finish") return finishWorkflow(ctx);
		if (action === "archive") return archiveWorkflow("--keep-tmp", ctx);
		if (action === "start") return startWorkflow("", ctx, { autoPlan: true });
		if (action === "abort") return abortWorkflow(ctx);
	}

	async function handleAnalyticWorker(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		const trimmed = args.trim();
		if (!trimmed) return smartMenu(ctx);

		const [first, ...restParts] = trimmed.split(/\s+/);
		const rest = restParts.join(" ");
		const action = first.toLowerCase();

		if (action === "help" || action === "?") return showHelp();
		if (action === "start" || action === "new") return startWorkflow(rest, ctx, { autoPlan: true });
		if (action === "config" || action === "settings") return configureWorkflow(ctx);
		if (action === "status") return showStatus(ctx);
		if (action === "step" || action === "next" || action === "continue") return continueWorkflow(ctx);
		if (action === "pause") return pauseWorkflow(ctx);
		if (action === "resume") return resumeWorkflow(ctx);
		if (action === "finish" || action === "done") return finishWorkflow(ctx);
		if (action === "archive") return archiveWorkflow(rest, ctx);
		if (action === "abort") return abortWorkflow(ctx);

		if (!run || run.state === "ABORTED" || run.state === "DONE_NEEDS_OPERATOR_CONFIRMATION") {
			return startWorkflow(trimmed, ctx, { autoPlan: true });
		}

		run.workerStepsSinceOperator = 0;
		await saveRun(ctx);
		sendMessage(
			`[OPERATOR HANDOFF]\nState: ${run.state}\nReason: operator note recorded\nExpected operator input:\n  Run /analyst-worker to choose the next action. The next analyst turn will see this note.\n\nOperator note:\n${trimmed}`,
			{ type: "operator-note", text: trimmed },
		);
	}

	const subcommands = [
		"start",
		"start --configure",
		"status",
		"config",
		"next",
		"pause",
		"resume",
		"finish",
		"archive --keep-tmp",
		"archive --delete-tmp",
		"archive --commit",
		"abort",
		"help",
	];

	pi.registerCommand("analyst-worker", {
		description: "Smart Analyst/Worker workflow: start, continue, status, settings, archive",
		getArgumentCompletions: (prefix) => {
			const filtered = subcommands.filter((item) => item.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: handleAnalyticWorker,
	});

}
