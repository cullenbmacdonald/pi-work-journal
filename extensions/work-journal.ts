/**
 * Work Journal Extension
 *
 * Processes session context into a structured markdown journal entry and writes
 * to a daily worklog file in a configurable vault (e.g., Obsidian).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/work-journal.json (global)
 * - <cwd>/.pi/work-journal.json (project-local)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

interface WorkJournalConfig {
	/** Path to the directory where daily worklog files are written */
	vaultPath: string;
	/** Filename pattern. Supports {{date}} (YYYY-MM-DD) and {{timestamp}} (ISO) */
	filePattern: string;
}

interface WorkRange {
	startMs: number;
	endMs: number;
}

interface MessageSlice {
	role: string;
	text: string;
	timestampMs: number;
}

const DEFAULT_CONFIG: WorkJournalConfig = {
	vaultPath: "~/Documents/work-journal",
	filePattern: "{{date}}-worklog.md",
};

function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(process.env.HOME || "/tmp", p.slice(2));
	}
	return p;
}

function loadConfig(cwd: string): WorkJournalConfig {
	const globalConfigPath = join(getAgentDir(), "work-journal.json");
	const projectConfigPath = join(cwd, ".pi", "work-journal.json");

	let globalConfig: Partial<WorkJournalConfig> = {};
	let projectConfig: Partial<WorkJournalConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}

function resolveFilename(pattern: string): string {
	const now = new Date();
	const date = now.toISOString().split("T")[0];
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return pattern.replace(/\{\{date\}\}/g, date).replace(/\{\{timestamp\}\}/g, timestamp);
}

function getTodayDateString(): string {
	return new Date().toISOString().split("T")[0];
}

function getTodayDailyLink(): string {
	return `[[${getTodayDateString()}]]`;
}

function getProjectName(cwd: string): string {
	return basename(cwd);
}

function formatHm(ms: number): string {
	return new Date(ms).toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function formatRange(range?: WorkRange): string {
	if (!range) return formatHm(Date.now());
	const start = formatHm(range.startMs);
	const end = formatHm(range.endMs);
	return start === end ? start : `${start}–${end}`;
}

function resolveDailyFile(cwd: string): {
	config: WorkJournalConfig;
	vaultDir: string;
	filePath: string;
	fileExists: boolean;
} {
	const config = loadConfig(cwd);
	const vaultDir = expandHome(config.vaultPath);
	const filename = resolveFilename(config.filePattern);
	const filePath = join(vaultDir, filename);
	return { config, vaultDir, filePath, fileExists: existsSync(filePath) };
}

async function ensureVaultDir(ctx: ExtensionCommandContext, vaultDir: string): Promise<boolean> {
	if (existsSync(vaultDir)) return true;
	const create = await ctx.ui.confirm(
		"Create vault directory?",
		`Journal vault path does not exist:\n${vaultDir}\n\nCreate it?`,
	);
	if (!create) {
		ctx.ui.notify("Journal cancelled. Configure vaultPath in work-journal.json", "warning");
		return false;
	}
	mkdirSync(vaultDir, { recursive: true });
	return true;
}

function extractMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const textParts = content
			.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text.trim())
			.filter(Boolean);
		return textParts.join("\n");
	}
	return "";
}

function getBranchMessages(ctx: ExtensionCommandContext): MessageSlice[] {
	const entries = ctx.sessionManager.getBranch();
	const messages: MessageSlice[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = (entry as any).message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractMessageText((entry as any).message);
		if (!text) continue;
		const ts = (entry as any).message?.timestamp;
		const timestampMs = typeof ts === "number" ? ts : new Date((entry as any).timestamp).getTime();
		if (!Number.isFinite(timestampMs)) continue;
		messages.push({ role, text, timestampMs });
	}

	messages.sort((a, b) => a.timestampMs - b.timestampMs);
	return messages;
}

function buildSessionTranscript(messages: MessageSlice[], maxMessages = 40): string {
	const recent = messages.slice(-maxMessages);
	return recent
		.map((m) => {
			const clipped = m.text.length > 700 ? `${m.text.slice(0, 700)}\n... (truncated)` : m.text;
			return `[${new Date(m.timestampMs).toISOString()}] ${m.role}:\n${clipped}`;
		})
		.join("\n\n");
}

function getLatestAssistantTextFromBranch(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type !== "message") continue;
		if (entry?.message?.role !== "assistant") continue;
		const text = extractMessageText(entry.message).trim();
		if (text) return text;
	}
	return "";
}

function extractTitleAndBody(content: string): { title: string; body: string } {
	const trimmed = content.trim();
	if (!trimmed) return { title: "Journal update", body: "" };

	const lines = trimmed.split("\n");
	const first = lines[0]?.trim() ?? "";

	const titleLineMatch = first.match(/^title:\s*(.+)$/i);
	if (titleLineMatch) {
		const title = titleLineMatch[1].trim() || "Journal update";
		const body = lines.slice(1).join("\n").trim();
		return { title, body: body || title };
	}

	const headingMatch = first.match(/^###\s+\d{2}:\d{2}(?:–\d{2}:\d{2})?\s+—\s+[^:]+:\s*(.+)$/);
	if (headingMatch) {
		const title = headingMatch[1].trim() || "Journal update";
		const body = lines.slice(1).join("\n").trim();
		return { title, body: body || title };
	}

	const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.trim() ?? "Journal update";
	const title = firstNonEmpty.replace(/^[#\-*\s>\[]+/, "").slice(0, 90) || "Journal update";
	return { title, body: trimmed };
}

function formatEntryMarkdown(content: string, cwd: string, range?: WorkRange): string {
	const project = getProjectName(cwd);
	const { title, body } = extractTitleAndBody(content);
	const heading = `### ${formatRange(range)} — ${project}: ${title}`;
	return `${heading}\n\n${body.trim()}`.trim();
}

function writeJournalEntry(params: { cwd: string; rawContent: string; range?: WorkRange }): { filePath: string; mode: "append" | "create" } {
	const { cwd, rawContent, range } = params;
	const { vaultDir, filePath, fileExists } = resolveDailyFile(cwd);

	if (!existsSync(vaultDir)) {
		mkdirSync(vaultDir, { recursive: true });
	}

	const entryMarkdown = formatEntryMarkdown(rawContent, cwd, range);

	if (fileExists) {
		appendFileSync(filePath, `\n\n---\n\n${entryMarkdown}\n`, "utf-8");
		return { filePath, mode: "append" };
	}

	const dateHeader = `# ${getTodayDateString()}`;
	writeFileSync(filePath, `${dateHeader}\n\n${entryMarkdown}\n`, "utf-8");
	return { filePath, mode: "create" };
}

function buildJournalInstruction(params: {
	project: string;
	cwd: string;
	filePath: string;
	fileExists: boolean;
	existingContent: string;
	dailyLink: string;
	timeRange: string;
	transcript: string;
}): string {
	const { project, cwd, filePath, fileExists, existingContent, dailyLink, timeRange, transcript } = params;

	return [
		"Review this session transcript and draft a concise work-journal entry.",
		"",
		"## Output format (strict)",
		"",
		"Line 1 must be exactly: `Title: <short title>`",
		"Then a blank line, then markdown body content only (no top heading).",
		"",
		"The writer will add the heading automatically using this time range:",
		`- ${timeRange}`,
		"",
		"Include whichever sections are relevant (skip empty):",
		"- **What was done**",
		"- **Key decisions**",
		"- **Open threads** (tasks format: `- [ ] ...`)",
		"- **Learnings**",
		"- **Links**",
		"",
		"## Obsidian conventions",
		"",
		"Use [[wikilinks]] for proper nouns/tools/projects/people/concepts where useful.",
		"Do not wikilink generic words.",
		`Include daily-note link somewhere: ${dailyLink}`,
		"",
		"## Context",
		"",
		`Target file: ${filePath}`,
		`Project: ${project} (${cwd})`,
		fileExists
			? [
					"",
					"Existing entries today (truncated):",
					"```",
					existingContent.slice(0, 2000),
					existingContent.length > 2000 ? "\n... (truncated)" : "",
					"```",
					"Do not duplicate existing TODOs unless adding a clear update.",
			  ].join("\n")
			: `No file exists yet for today. First write will create file header automatically (# ${getTodayDateString()}).`,
		"",
		"Session transcript excerpt:",
		"```",
		transcript || "(no transcript available)",
		"```",
		"",
		"Return ONLY the markdown output in the specified format. No code fences.",
	].join("\n");
}

type ReviewAction = "write" | "edit" | "cancel";

class JournalReviewOverlay implements Focusable {
	focused = false;
	private selected = 0;
	private actions: Array<{ id: ReviewAction; label: string }> = [
		{ id: "write", label: "Write" },
		{ id: "edit", label: "Edit" },
		{ id: "cancel", label: "Cancel" },
	];

	constructor(
		private theme: Theme,
		private draft: string,
		private done: (result: ReviewAction) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done("cancel");
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			this.selected = Math.min(this.actions.length - 1, this.selected + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(this.actions[this.selected]!.id);
		}
	}

	render(width: number): string[] {
		const w = Math.max(70, Math.min(120, width - 4));
		const inner = w - 2;
		const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const border = this.theme.fg("border", `╭${"─".repeat(inner)}╮`);
		const borderBottom = this.theme.fg("border", `╰${"─".repeat(inner)}╯`);
		const row = (content: string) => `${this.theme.fg("border", "│")}${pad(content)}${this.theme.fg("border", "│")}`;
		const clip = (line: string, maxWidth: number) => {
			if (visibleWidth(line) <= maxWidth) return line;
			return `${line.slice(0, Math.max(0, maxWidth - 1))}…`;
		};

		const lines: string[] = [
			border,
			row(` ${this.theme.fg("accent", "Journal draft review")}`),
			row(` ${this.theme.fg("dim", "Enter=select • arrows/tab=navigate • Esc=cancel")}`),
			row(""),
		];

		for (const previewLine of this.draft.split("\n").slice(0, 18)) {
			lines.push(row(` ${clip(previewLine, inner - 2)}`));
		}
		if (this.draft.split("\n").length > 18) {
			lines.push(row(` ${this.theme.fg("dim", "... (truncated)")}`));
		}

		lines.push(row(""));
		const actionLine = this.actions
			.map((a, idx) => {
				const selected = idx === this.selected;
				const token = `[${a.label}]`;
				return selected ? this.theme.fg("accent", token) : this.theme.fg("text", token);
			})
			.join("  ");
		lines.push(row(` ${actionLine}`));
		lines.push(borderBottom);
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

async function reviewDraftWithOverlay(ctx: ExtensionCommandContext, draft: string): Promise<ReviewAction> {
	const action = await ctx.ui.custom<ReviewAction>(
		(_tui, theme, _keybindings, done) => new JournalReviewOverlay(theme, draft, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "85%", minWidth: 80, maxHeight: "85%", margin: 1 },
		},
	);
	return action ?? "cancel";
}

async function reviewAndWriteLoop(
	ctx: ExtensionCommandContext,
	draftInitial: string,
	range: WorkRange | undefined,
): Promise<void> {
	let draft = draftInitial.trim();
	if (!draft) {
		ctx.ui.notify("Journal draft generation failed: no assistant output found.", "error");
		return;
	}

	let done = false;
	while (!done) {
		const action = await reviewDraftWithOverlay(ctx, draft);
		if (action === "cancel") {
			ctx.ui.notify("Journal cancelled", "warning");
			done = true;
			continue;
		}
		if (action === "edit") {
			const edited = await ctx.ui.editor("Edit journal draft", draft);
			if (edited?.trim()) {
				draft = edited.trim();
			}
			continue;
		}

		const result = writeJournalEntry({ cwd: ctx.cwd, rawContent: draft, range });
		ctx.ui.notify(`✅ Journal entry ${result.mode === "append" ? "appended" : "created"}:\n${result.filePath}`, "info");
		done = true;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("journal", {
		description: "Generate journal draft in an isolated session, review in overlay, then write",
		handler: async (_args, ctx) => {
			const { vaultDir, filePath, fileExists } = resolveDailyFile(ctx.cwd);
			if (!(await ensureVaultDir(ctx, vaultDir))) return;

			const project = getProjectName(ctx.cwd);
			const dailyLink = getTodayDailyLink();
			const originSessionFile = ctx.sessionManager.getSessionFile();
			const branchMessages = getBranchMessages(ctx);
			const transcript = buildSessionTranscript(branchMessages);
			const range: WorkRange | undefined =
				branchMessages.length > 0
					? {
							startMs: branchMessages[0]!.timestampMs,
							endMs: branchMessages[branchMessages.length - 1]!.timestampMs,
					  }
					: undefined;

			const existingContent = fileExists ? readFileSync(filePath, "utf-8") : "";
			const instruction = buildJournalInstruction({
				project,
				cwd: ctx.cwd,
				filePath,
				fileExists,
				existingContent,
				dailyLink,
				timeRange: formatRange(range),
				transcript,
			});

			await ctx.newSession({
				parentSession: originSessionFile,
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(instruction);
					await newCtx.waitForIdle();
					const draft = getLatestAssistantTextFromBranch(newCtx).trim();

					if (!originSessionFile) {
						await reviewAndWriteLoop(newCtx, draft, range);
						return;
					}

					await newCtx.switchSession(originSessionFile, {
						withSession: async (originCtx) => {
							await reviewAndWriteLoop(originCtx, draft, range);
							originCtx.ui.notify("Journal draft was generated in an isolated session", "info");
						},
					});
				},
			});
		},
	});

	pi.registerCommand("journal-write", {
		description: "Write a journal entry to the configured vault (formats heading automatically)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /journal-write <markdown content>", "warning");
				return;
			}

			const { vaultDir } = resolveDailyFile(ctx.cwd);
			if (!(await ensureVaultDir(ctx, vaultDir))) return;

			const result = writeJournalEntry({ cwd: ctx.cwd, rawContent: args.trim() });
			ctx.ui.notify(`✅ Journal entry ${result.mode === "append" ? "appended" : "created"}:\n${result.filePath}`, "info");
		},
	});

	pi.registerCommand("journal-config", {
		description: "Show current work journal configuration",
		handler: async (_args, ctx) => {
			const { config, vaultDir, filePath, fileExists } = resolveDailyFile(ctx.cwd);
			const lines = [
				"Work Journal Configuration:",
				"",
				`  Vault path:    ${config.vaultPath}`,
				`  Resolved:      ${vaultDir}`,
				`  Exists:        ${existsSync(vaultDir) ? "yes" : "NO — will be created on first use"}`,
				`  File pattern:  ${config.filePattern}`,
				`  Today's file:  ${filePath}`,
				`  File exists:   ${fileExists ? "yes (will append)" : "no (will create)"}`,
				"",
				"Config locations (project overrides global):",
				`  Global:  ${join(getAgentDir(), "work-journal.json")}`,
				`  Project: ${join(ctx.cwd, ".pi", "work-journal.json")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
