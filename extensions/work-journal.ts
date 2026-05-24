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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

interface WorkJournalConfig {
	/** Path to the directory where daily worklog files are written */
	vaultPath: string;
	/** Filename pattern. Supports {{date}} (YYYY-MM-DD) and {{timestamp}} (ISO) */
	filePattern: string;
	/** Optional provider to use for journal generation/reconcile commands */
	provider?: string;
	/** Optional model id to use for journal generation/reconcile commands */
	model?: string;
}

interface WorkRange {
	startMs: number;
	endMs: number;
}

interface WorkSegment {
	range: WorkRange;
	messageCount: number;
}

interface MessageSlice {
	role: string;
	text: string;
	timestampMs: number;
	sourceSession?: string;
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

function resolveFilename(pattern: string, dateString?: string): string {
	const now = new Date();
	const date = dateString ?? now.toISOString().split("T")[0];
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return pattern.replace(/\{\{date\}\}/g, date).replace(/\{\{timestamp\}\}/g, timestamp);
}

function getDateString(dayOffset = 0): string {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	return d.toISOString().split("T")[0];
}

function getTodayDateString(): string {
	return getDateString(0);
}

function isIsoDateString(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toIsoDateUtc(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function getWeekRangeForDate(referenceDate: string): { startDate: string; endDate: string } {
	const base = new Date(`${referenceDate}T00:00:00.000Z`);
	const day = base.getUTCDay();
	const daysSinceMonday = (day + 6) % 7;

	const start = new Date(base);
	start.setUTCDate(base.getUTCDate() - daysSinceMonday);

	const end = new Date(start);
	end.setUTCDate(start.getUTCDate() + 6);

	return { startDate: toIsoDateUtc(start), endDate: toIsoDateUtc(end) };
}

function getDateStringsInRange(startDate: string, endDate: string): string[] {
	const start = new Date(`${startDate}T00:00:00.000Z`);
	const end = new Date(`${endDate}T00:00:00.000Z`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

	const days: string[] = [];
	const cursor = new Date(start);
	while (cursor <= end) {
		days.push(toIsoDateUtc(cursor));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days;
}

function getDailyLink(dateString: string): string {
	return `[[${dateString}]]`;
}

function getTodayDailyLink(): string {
	return getDailyLink(getTodayDateString());
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

function resolveDatedFile(cwd: string, dateString: string): {
	config: WorkJournalConfig;
	vaultDir: string;
	filePath: string;
	fileExists: boolean;
} {
	const config = loadConfig(cwd);
	const vaultDir = expandHome(config.vaultPath);
	const filename = resolveFilename(config.filePattern, dateString);
	const filePath = join(vaultDir, filename);
	return { config, vaultDir, filePath, fileExists: existsSync(filePath) };
}

function resolveDailyFile(cwd: string): {
	config: WorkJournalConfig;
	vaultDir: string;
	filePath: string;
	fileExists: boolean;
} {
	return resolveDatedFile(cwd, getTodayDateString());
}

function resolveWeeklyReviewFile(cwd: string, startDate: string, endDate: string): {
	config: WorkJournalConfig;
	vaultDir: string;
	filePath: string;
	fileExists: boolean;
} {
	const config = loadConfig(cwd);
	const vaultDir = expandHome(config.vaultPath);
	const filePath = join(vaultDir, `${startDate}_to_${endDate}-weekly-review.md`);
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

async function withConfiguredJournalModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	run: () => Promise<void>,
): Promise<void> {
	const cfg = loadConfig(ctx.cwd);
	const provider = cfg.provider?.trim();
	const modelId = cfg.model?.trim();
	if ((!provider && modelId) || (provider && !modelId)) {
		ctx.ui.notify("Journal config model selection requires both provider and model. Using current model.", "warning");
		await run();
		return;
	}
	if (!provider || !modelId) {
		await run();
		return;
	}

	const targetModel = ctx.modelRegistry.find(provider, modelId);
	if (!targetModel) {
		ctx.ui.notify(`Configured journal model not found: ${provider}/${modelId}. Using current model.`, "warning");
		await run();
		return;
	}

	const currentModel = ctx.model;
	const alreadyUsing = currentModel?.provider === targetModel.provider && currentModel?.id === targetModel.id;
	if (alreadyUsing) {
		await run();
		return;
	}

	let switched = false;
	try {
		switched = await pi.setModel(targetModel);
	} catch (e) {
		ctx.ui.notify(`Could not switch to configured journal model ${provider}/${modelId} (${e}). Using current model.`, "warning");
		await run();
		return;
	}
	if (!switched) {
		ctx.ui.notify(`Could not switch to configured journal model ${provider}/${modelId}. Using current model.`, "warning");
		await run();
		return;
	}

	ctx.ui.notify(`Using configured journal model: ${provider}/${modelId}`, "info");
	try {
		await run();
	} finally {
		if (currentModel && (currentModel.provider !== targetModel.provider || currentModel.id !== targetModel.id)) {
			try {
				await pi.setModel(currentModel);
			} catch {
				// Session/runtime may have been replaced during /journal flows; ignore restore failures.
			}
		}
	}
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
			const source = m.sourceSession ? ` (${m.sourceSession})` : "";
			return `[${new Date(m.timestampMs).toISOString()}]${source} ${m.role}:\n${clipped}`;
		})
		.join("\n\n");
}

function getSessionFilePaths(sessionDir: string): string[] {
	if (!sessionDir || !existsSync(sessionDir)) return [];
	return readdirSync(sessionDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionDir, name));
}

function getAllSessionFilePaths(): string[] {
	const sessionsRoot = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsRoot)) return [];
	const files: string[] = [];
	for (const dirName of readdirSync(sessionsRoot)) {
		const dirPath = join(sessionsRoot, dirName);
		try {
			const entries = readdirSync(dirPath);
			for (const entry of entries) {
				if (entry.endsWith(".jsonl")) {
					files.push(join(dirPath, entry));
				}
			}
		} catch {
			// skip non-directories or unreadable entries
		}
	}
	return files;
}

function extractMessagesFromSessionFileInRange(filePath: string, startDate: string, endDate: string): MessageSlice[] {
	const messages: MessageSlice[] = [];
	let raw = "";
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return messages;
	}

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry?.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractMessageText(entry.message);
		if (!text) continue;

		const tsFromMessage = entry?.message?.timestamp;
		const fallbackTs = new Date(entry?.timestamp).getTime();
		const timestampMs = typeof tsFromMessage === "number" ? tsFromMessage : fallbackTs;
		if (!Number.isFinite(timestampMs)) continue;
		const messageDate = new Date(timestampMs).toISOString().slice(0, 10);
		if (messageDate < startDate || messageDate > endDate) continue;

		messages.push({
			role,
			text,
			timestampMs,
			sourceSession: basename(filePath),
		});
	}

	return messages;
}

function extractMessagesFromSessionFile(filePath: string, targetDate: string): MessageSlice[] {
	return extractMessagesFromSessionFileInRange(filePath, targetDate, targetDate);
}

function collectTodayMessagesAcrossSessions(ctx: ExtensionCommandContext, targetDate: string): {
	messages: MessageSlice[];
	scannedSessionCount: number;
	contributingSessionCount: number;
} {
	const sessionDir = ctx.sessionManager.getSessionDir();
	const files = getSessionFilePaths(sessionDir);
	const all: MessageSlice[] = [];
	let contributing = 0;

	for (const filePath of files) {
		const extracted = extractMessagesFromSessionFile(filePath, targetDate);
		if (extracted.length > 0) {
			contributing++;
			all.push(...extracted);
		}
	}

	const deduped = new Map<string, MessageSlice>();
	for (const m of all) {
		const key = `${m.timestampMs}:${m.role}:${m.text.slice(0, 140)}`;
		if (!deduped.has(key)) deduped.set(key, m);
	}

	const messages = [...deduped.values()].sort((a, b) => a.timestampMs - b.timestampMs);
	return { messages, scannedSessionCount: files.length, contributingSessionCount: contributing };
}

function collectMessagesAcrossAllSessionsInRange(startDate: string, endDate: string): {
	messages: MessageSlice[];
	scannedSessionCount: number;
	contributingSessionCount: number;
} {
	const files = getAllSessionFilePaths();
	const all: MessageSlice[] = [];
	let contributing = 0;

	for (const filePath of files) {
		const extracted = extractMessagesFromSessionFileInRange(filePath, startDate, endDate);
		if (extracted.length > 0) {
			contributing++;
			all.push(...extracted);
		}
	}

	const deduped = new Map<string, MessageSlice>();
	for (const m of all) {
		const key = `${m.timestampMs}:${m.role}:${m.text.slice(0, 140)}`;
		if (!deduped.has(key)) deduped.set(key, m);
	}

	const messages = [...deduped.values()].sort((a, b) => a.timestampMs - b.timestampMs);
	return { messages, scannedSessionCount: files.length, contributingSessionCount: contributing };
}

function collectMessagesAcrossAllSessions(targetDate: string): {
	messages: MessageSlice[];
	scannedSessionCount: number;
	contributingSessionCount: number;
} {
	return collectMessagesAcrossAllSessionsInRange(targetDate, targetDate);
}

function splitIntoWorkSegments(messages: MessageSlice[], gapMinutes = 90): WorkSegment[] {
	if (messages.length === 0) return [];
	const thresholdMs = gapMinutes * 60 * 1000;
	const segments: WorkSegment[] = [];

	let start = messages[0]!.timestampMs;
	let prev = messages[0]!.timestampMs;
	let count = 1;

	for (let i = 1; i < messages.length; i++) {
		const ts = messages[i]!.timestampMs;
		if (ts - prev >= thresholdMs) {
			segments.push({ range: { startMs: start, endMs: prev }, messageCount: count });
			start = ts;
			count = 1;
		} else {
			count++;
		}
		prev = ts;
	}

	segments.push({ range: { startMs: start, endMs: prev }, messageCount: count });
	return segments;
}

function formatSegmentsForPrompt(segments: WorkSegment[]): string {
	if (segments.length === 0) return "(no activity segments found)";
	return segments
		.map((s, idx) => `- Segment ${idx + 1}: ${formatRange(s.range)} (${s.messageCount} msgs)`)
		.join("\n");
}

function getLastMessageRange(messages: MessageSlice[]): WorkRange | undefined {
	if (messages.length === 0) return undefined;
	const ts = messages[messages.length - 1]!.timestampMs;
	return { startMs: ts, endMs: ts };
}

function writeFullDailyJournalFile(cwd: string, fullMarkdown: string, targetDate?: string): { filePath: string } {
	const dateString = targetDate ?? getTodayDateString();
	const { vaultDir, filePath } = resolveDatedFile(cwd, dateString);
	if (!existsSync(vaultDir)) {
		mkdirSync(vaultDir, { recursive: true });
	}

	const normalized = fullMarkdown.trim().replace(/\s+$/g, "");
	writeFileSync(filePath, `${normalized}\n`, "utf-8");
	return { filePath };
}

function hasUsableDailyJournalContent(content: string, date: string): boolean {
	const normalized = content.trim();
	if (!normalized) return false;
	const headerOnly = `# ${date}`;
	return normalized !== headerOnly;
}

function collectExistingJournalContentInRange(cwd: string, startDate: string, endDate: string): string {
	const days = getDateStringsInRange(startDate, endDate);
	const chunks: string[] = [];
	for (const day of days) {
		const { filePath, fileExists } = resolveDatedFile(cwd, day);
		if (!fileExists) continue;
		let content = "";
		try {
			content = readFileSync(filePath, "utf-8").trim();
		} catch {
			continue;
		}
		if (!hasUsableDailyJournalContent(content, day)) continue;
		chunks.push(`## ${day}\n${content.slice(0, 3500)}${content.length > 3500 ? "\n... (truncated)" : ""}`);
	}
	return chunks.join("\n\n");
}

function getMissingDailyWorklogDates(cwd: string, startDate: string, endDate: string): string[] {
	const days = getDateStringsInRange(startDate, endDate);
	const missing: string[] = [];
	for (const day of days) {
		const { filePath, fileExists } = resolveDatedFile(cwd, day);
		if (!fileExists) {
			missing.push(day);
			continue;
		}
		let content = "";
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			missing.push(day);
			continue;
		}
		if (!hasUsableDailyJournalContent(content, day)) {
			missing.push(day);
		}
	}
	return missing;
}

function writeWeeklyReviewFile(cwd: string, fullMarkdown: string, startDate: string, endDate: string): { filePath: string } {
	const { vaultDir, filePath } = resolveWeeklyReviewFile(cwd, startDate, endDate);
	if (!existsSync(vaultDir)) {
		mkdirSync(vaultDir, { recursive: true });
	}

	const normalized = fullMarkdown.trim().replace(/\s+$/g, "");
	writeFileSync(filePath, `${normalized}\n`, "utf-8");
	return { filePath };
}

function normalizeModelMarkdownOutput(raw: string): string {
	let draft = raw.trim();
	const fenced = draft.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
	if (fenced?.[1]) {
		draft = fenced[1].trim();
	}
	return draft;
}

function normalizeReconcileDraft(raw: string, targetDate?: string): string {
	const draft = normalizeModelMarkdownOutput(raw);
	if (!targetDate) return draft;
	const header = `# ${targetDate}`;
	const idx = draft.indexOf(header);
	if (idx >= 0) {
		return draft.slice(idx).trim();
	}
	return draft;
}

function isValidReconcileDraft(draft: string, targetDate?: string): boolean {
	const normalized = draft.trim();
	if (!normalized) return false;
	if (targetDate && !normalized.startsWith(`# ${targetDate}`)) return false;
	if (!/^#\s+\d{4}-\d{2}-\d{2}/.test(normalized)) return false;
	return true;
}

function normalizeWeeklyReviewDraft(raw: string, startDate: string, endDate: string): string {
	const draft = normalizeModelMarkdownOutput(raw);
	const header = `# Weekly Review: ${startDate} → ${endDate}`;
	const idx = draft.indexOf(header);
	if (idx >= 0) return draft.slice(idx).trim();
	return draft;
}

function isValidWeeklyReviewDraft(draft: string, startDate: string, endDate: string): boolean {
	const normalized = draft.trim();
	if (!normalized) return false;
	if (!normalized.startsWith(`# Weekly Review: ${startDate} → ${endDate}`)) return false;
	if (!normalized.includes("## Highlights")) return false;
	if (!normalized.includes("## Lowlights")) return false;
	if (!normalized.includes("## Uncompleted work")) return false;
	return true;
}

function getLatestAssistantSnapshotFromBranch(ctx: ExtensionCommandContext): { entryId?: string; text: string } {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type !== "message") continue;
		if (entry?.message?.role !== "assistant") continue;
		const text = extractMessageText(entry.message).trim();
		if (text) return { entryId: entry?.id, text };
	}
	return { text: "" };
}

function getLatestAssistantTextFromBranch(ctx: ExtensionCommandContext): string {
	return getLatestAssistantSnapshotFromBranch(ctx).text;
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

function writeJournalEntry(params: {
	cwd: string;
	rawContent: string;
	range?: WorkRange;
	targetDate?: string;
}): { filePath: string; mode: "append" | "create" } {
	const { cwd, rawContent, range, targetDate } = params;
	const dateString = targetDate ?? getTodayDateString();
	const { vaultDir, filePath, fileExists } = resolveDatedFile(cwd, dateString);

	if (!existsSync(vaultDir)) {
		mkdirSync(vaultDir, { recursive: true });
	}

	const entryMarkdown = formatEntryMarkdown(rawContent, cwd, range);

	if (fileExists) {
		appendFileSync(filePath, `\n\n---\n\n${entryMarkdown}\n`, "utf-8");
		return { filePath, mode: "append" };
	}

	const dateHeader = `# ${dateString}`;
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

function buildReconcileInstruction(params: {
	project: string;
	cwd: string;
	filePath: string;
	existingContent: string;
	dailyLink: string;
	todayDate: string;
	sessionCount: number;
	contributingSessionCount: number;
	segmentsText: string;
	transcript: string;
}): string {
	const {
		project,
		cwd,
		filePath,
		existingContent,
		dailyLink,
		todayDate,
		sessionCount,
		contributingSessionCount,
		segmentsText,
		transcript,
	} = params;

	return [
		"Reconstruct and reconcile the FULL daily worklog from today's Pi session activity.",
		"",
		"Goal: produce a complete rewritten day log that reads like the user journaled at key moments.",
		"",
		"## Output format (strict)",
		"",
		"Return the ENTIRE final daily markdown file, not a partial snippet.",
		`Line 1 must be exactly: # ${todayDate}`,
		"",
		"For each work segment, create one journal entry with this heading style:",
		"### HH:MM or HH:MM–HH:MM — <project>: <title>",
		"",
		"Separate entries with:",
		"---",
		"",
		"Include all important work/decisions/todos from the transcript.",
		"If something already exists in the journal, preserve it but merge/deduplicate.",
		"Use checkbox TODOs (`- [ ] ...`) for open items.",
		`Include daily-note link somewhere in the file: ${dailyLink}`,
		"",
		"## Segment hints (from message time gaps)",
		segmentsText,
		"",
		"## Context",
		`Date: ${todayDate}`,
		`Project: ${project} (${cwd})`,
		`Target file: ${filePath}`,
		`Sessions scanned: ${sessionCount} (${contributingSessionCount} with activity today)`,
		"",
		"Existing daily journal content (truncated):",
		"```",
		existingContent.slice(0, 7000) || "(none)",
		existingContent.length > 7000 ? "\n... (truncated)" : "",
		"```",
		"",
		"Today's session transcript excerpts:",
		"```",
		transcript || "(no transcript available)",
		"```",
		"",
		"Return ONLY final markdown file contents. No code fences.",
	].join("\n");
}

function buildEodMissingInstruction(params: {
	project: string;
	cwd: string;
	filePath: string;
	fileExists: boolean;
	existingContent: string;
	dailyLink: string;
	todayDate: string;
	sessionCount: number;
	contributingSessionCount: number;
	transcript: string;
}): string {
	const {
		project,
		cwd,
		filePath,
		fileExists,
		existingContent,
		dailyLink,
		todayDate,
		sessionCount,
		contributingSessionCount,
		transcript,
	} = params;

	return [
		"Create an end-of-day note with ONLY items missing from today's work journal.",
		"",
		"Goal: compare today's Pi sessions against the full current worklog and list only follow-ups/loose ends/TODOs not already captured.",
		"",
		"## Output format (strict)",
		"",
		"Line 1 must be exactly: `Title: EOD missing items`",
		"Then a blank line, then markdown body content only (no top heading).",
		"",
		"Sections:",
		"- **Missing follow-ups / TODOs** (checkboxes: `- [ ] ...`)",
		"- **Missing loose ends / risks**",
		"- **Coverage notes** (1-3 bullets max)",
		"",
		"Rules:",
		"- Include only items not already represented in the journal.",
		"- If everything is already covered, output: `- Nothing missing; journal appears reconciled.`",
		"- Be concrete and deduplicated.",
		`- Include daily-note link somewhere: ${dailyLink}`,
		"",
		"## Context",
		"",
		`Date: ${todayDate}`,
		`Project: ${project} (${cwd})`,
		`Target file: ${filePath}`,
		`Sessions scanned: ${sessionCount} (${contributingSessionCount} with activity today)`,
		fileExists
			? [
					"",
					"Existing FULL work journal content for today (truncated):",
					"```",
					existingContent.slice(0, 7000),
					existingContent.length > 7000 ? "\n... (truncated)" : "",
					"```",
			  ].join("\n")
			: "No work-journal file exists yet for today.",
		"",
		"Pi session transcript excerpts for today:",
		"```",
		transcript || "(no transcript available)",
		"```",
		"",
		"Return ONLY the markdown output in the specified format. No code fences.",
	].join("\n");
}

function buildWeeklyReviewInstruction(params: {
	project: string;
	cwd: string;
	filePath: string;
	startDate: string;
	endDate: string;
	worklogDayCount: number;
	dailyLinks: string;
	existingWeeklyReviewContent: string;
	existingDailyJournals: string;
}): string {
	const {
		project,
		cwd,
		filePath,
		startDate,
		endDate,
		worklogDayCount,
		dailyLinks,
		existingWeeklyReviewContent,
		existingDailyJournals,
	} = params;

	return [
		"Create a weekly review markdown file using ONLY the provided daily worklogs.",
		"",
		"Goal: help the user quickly regain context on Monday morning.",
		"",
		"## Output format (strict)",
		"",
		`Line 1 must be exactly: # Weekly Review: ${startDate} → ${endDate}`,
		"Then include these sections in order:",
		"- ## Highlights",
		"- ## Lowlights",
		"- ## Uncompleted work",
		"- ## Monday restart context",
		"",
		"Section rules:",
		"- Highlights: 5-10 bullets of key wins/results.",
		"- Lowlights: blockers, regressions, friction, risks.",
		"- Uncompleted work: checkbox tasks (`- [ ] ...`) only.",
		"- Monday restart context: concise plan with first 3 actions.",
		"- Deduplicate aggressively.",
		"- Do not invent work not grounded in the daily logs.",
		"",
		"Use [[wikilinks]] where useful.",
		`Include these daily links somewhere: ${dailyLinks}`,
		"",
		"## Context",
		`Project: ${project} (${cwd})`,
		`Week range: ${startDate} → ${endDate}`,
		`Target file: ${filePath}`,
		`Daily worklogs available in range: ${worklogDayCount}`,
		"",
		existingWeeklyReviewContent
			? [
					"Existing weekly review file content (truncated):",
					"```",
					existingWeeklyReviewContent.slice(0, 5000),
					existingWeeklyReviewContent.length > 5000 ? "\n... (truncated)" : "",
					"```",
			  ].join("\n")
			: "No weekly review file currently exists for this range.",
		"",
		"Daily worklog files in range (truncated):",
		"```",
		existingDailyJournals || "(none)",
		"```",
		"",
		"Return ONLY final markdown file contents. No code fences.",
	].join("\n");
}

type ReviewAction = "write" | "edit" | "cancel";

class JournalReviewOverlay implements Focusable {
	focused = false;
	private selected = 0;
	private scrollOffset = 0;
	private readonly previewWindow = 24;
	private readonly draftLines: string[];
	private actions: Array<{ id: ReviewAction; label: string }> = [
		{ id: "write", label: "Write" },
		{ id: "edit", label: "Edit" },
		{ id: "cancel", label: "Cancel" },
	];

	constructor(
		private theme: Theme,
		private draft: string,
		private done: (result: ReviewAction) => void,
	) {
		this.draftLines = draft.split("\n");
	}

	private maxScrollOffset(): number {
		return Math.max(0, this.draftLines.length - this.previewWindow);
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset + delta));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done("cancel");
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "pageup")) {
			this.scrollBy(-this.previewWindow);
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.scrollBy(this.previewWindow);
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollOffset = this.maxScrollOffset();
			return;
		}
		if (matchesKey(data, "left")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab")) {
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

		const end = Math.min(this.draftLines.length, this.scrollOffset + this.previewWindow);
		const visible = this.draftLines.slice(this.scrollOffset, end);

		const lines: string[] = [
			border,
			row(` ${this.theme.fg("accent", "Journal draft review")}`),
			row(` ${clip(this.theme.fg("dim", "↑/↓ scroll • PgUp/PgDn jump • ←/→ actions • Enter select • Esc cancel"), inner - 2)}`),
			row(` ${clip(this.theme.fg("dim", `Lines ${this.scrollOffset + 1}-${end} of ${this.draftLines.length}`), inner - 2)}`),
			row(""),
		];

		for (const previewLine of visible) {
			lines.push(row(` ${clip(previewLine, inner - 2)}`));
		}

		if (visible.length < this.previewWindow) {
			for (let i = 0; i < this.previewWindow - visible.length; i++) {
				lines.push(row(""));
			}
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
	targetDate?: string,
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

		const result = writeJournalEntry({ cwd: ctx.cwd, rawContent: draft, range, targetDate });
		ctx.ui.notify(`✅ Journal entry ${result.mode === "append" ? "appended" : "created"}:\n${result.filePath}`, "info");
		done = true;
	}
}

async function reviewAndRewriteDailyFileLoop(
	ctx: ExtensionCommandContext,
	draftInitial: string,
	targetDate?: string,
): Promise<void> {
	let draft = normalizeReconcileDraft(draftInitial, targetDate);
	if (!draft) {
		ctx.ui.notify("Journal reconcile failed: no assistant output found.", "error");
		return;
	}

	let done = false;
	while (!done) {
		const action = await reviewDraftWithOverlay(ctx, draft);
		if (action === "cancel") {
			ctx.ui.notify("Journal reconcile cancelled", "warning");
			done = true;
			continue;
		}
		if (action === "edit") {
			const edited = await ctx.ui.editor("Edit reconciled day log", draft);
			if (edited?.trim()) {
				draft = edited.trim();
			}
			continue;
		}

		if (!isValidReconcileDraft(draft, targetDate)) {
			ctx.ui.notify(
				"Reconcile draft does not look like a full markdown day file (missing `# YYYY-MM-DD` header). Please edit before writing.",
				"warning",
			);
			const edited = await ctx.ui.editor("Edit reconciled day log", draft);
			if (edited?.trim()) {
				draft = normalizeReconcileDraft(edited.trim(), targetDate);
			}
			continue;
		}

		const result = writeFullDailyJournalFile(ctx.cwd, draft, targetDate);
		ctx.ui.notify(`✅ Journal day file rewritten:\n${result.filePath}`, "info");
		done = true;
	}
}

async function reviewAndWriteWeeklyReviewLoop(
	ctx: ExtensionCommandContext,
	draftInitial: string,
	startDate: string,
	endDate: string,
): Promise<void> {
	let draft = normalizeWeeklyReviewDraft(draftInitial, startDate, endDate);
	if (!draft) {
		ctx.ui.notify("Weekly review generation failed: no assistant output found.", "error");
		return;
	}

	let done = false;
	while (!done) {
		const action = await reviewDraftWithOverlay(ctx, draft);
		if (action === "cancel") {
			ctx.ui.notify("Weekly review cancelled", "warning");
			done = true;
			continue;
		}
		if (action === "edit") {
			const edited = await ctx.ui.editor("Edit weekly review", draft);
			if (edited?.trim()) {
				draft = edited.trim();
			}
			continue;
		}

		if (!isValidWeeklyReviewDraft(draft, startDate, endDate)) {
			ctx.ui.notify(
				"Weekly review draft is missing required structure (`# Weekly Review: ...`, highlights/lowlights/uncompleted). Please edit before writing.",
				"warning",
			);
			const edited = await ctx.ui.editor("Edit weekly review", draft);
			if (edited?.trim()) {
				draft = normalizeWeeklyReviewDraft(edited.trim(), startDate, endDate);
			}
			continue;
		}

		const result = writeWeeklyReviewFile(ctx.cwd, draft, startDate, endDate);
		ctx.ui.notify(`✅ Weekly review written:\n${result.filePath}`, "info");
		done = true;
	}
}

async function ensureWeekWorklogs(params: {
	ctx: ExtensionCommandContext;
	originSessionFile?: string;
	startDate: string;
	endDate: string;
}): Promise<{ createdDates: string[]; noActivityDates: string[]; failedDates: string[] }> {
	const { ctx, originSessionFile, startDate, endDate } = params;
	const missingDates = getMissingDailyWorklogDates(ctx.cwd, startDate, endDate);
	if (missingDates.length === 0) {
		return { createdDates: [], noActivityDates: [], failedDates: [] };
	}

	const createdDates: string[] = [];
	const noActivityDates: string[] = [];
	const failedDates: string[] = [];
	const project = getProjectName(ctx.cwd);

	for (const date of missingDates) {
		const { filePath } = resolveDatedFile(ctx.cwd, date);
		const { messages, scannedSessionCount, contributingSessionCount } = collectMessagesAcrossAllSessions(date);

		if (messages.length === 0) {
			const placeholder = [
				`# ${date}`,
				"",
				`### 00:00 — ${project}: No recorded work`,
				"",
				"- No Pi session activity found for this date.",
				"- [ ] Backfill manually if work happened outside Pi.",
			].join("\n");
			writeFullDailyJournalFile(ctx.cwd, placeholder, date);
			noActivityDates.push(date);
			continue;
		}

		const dailyLink = getDailyLink(date);
		const transcript = buildSessionTranscript(messages, 220);
		const segments = splitIntoWorkSegments(messages, 90);
		const segmentsText = formatSegmentsForPrompt(segments);
		const instruction = buildReconcileInstruction({
			project,
			cwd: ctx.cwd,
			filePath,
			existingContent: "",
			dailyLink,
			todayDate: date,
			sessionCount: scannedSessionCount,
			contributingSessionCount,
			segmentsText,
			transcript,
		});

		let draft = "";
		try {
			await ctx.newSession({
				parentSession: originSessionFile,
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(instruction);
					await newCtx.waitForIdle();
					draft = getLatestAssistantTextFromBranch(newCtx).trim();
				},
			});
		} catch (e) {
			ctx.ui.notify(`Could not auto-reconcile missing day ${date}: ${e}`, "warning");
			failedDates.push(date);
			continue;
		}

		const normalized = normalizeReconcileDraft(draft, date);
		if (!isValidReconcileDraft(normalized, date)) {
			ctx.ui.notify(`Auto-reconcile returned invalid markdown for ${date}; skipping.`, "warning");
			failedDates.push(date);
			continue;
		}

		writeFullDailyJournalFile(ctx.cwd, normalized, date);
		createdDates.push(date);
	}

	return { createdDates, noActivityDates, failedDates };
}

async function runReconcileAndEodForDate(params: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	targetDate: string;
	noActivityMessage: string;
	completionMessage: string;
}): Promise<void> {
	const { pi, ctx, targetDate, noActivityMessage, completionMessage } = params;
	try {
		await withConfiguredJournalModel(pi, ctx, async () => {
		const { vaultDir, filePath, fileExists } = resolveDatedFile(ctx.cwd, targetDate);
		if (!(await ensureVaultDir(ctx, vaultDir))) return;

		const project = getProjectName(ctx.cwd);
		const dailyLink = getDailyLink(targetDate);
		const originSessionFile = ctx.sessionManager.getSessionFile();
		const { messages, scannedSessionCount, contributingSessionCount } = collectMessagesAcrossAllSessions(targetDate);
		const transcript = buildSessionTranscript(messages, 260);
		const existingContent = fileExists ? readFileSync(filePath, "utf-8") : "";

		if (!existingContent.trim() && messages.length === 0) {
			ctx.ui.notify(noActivityMessage, "warning");
			return;
		}

		const segments = splitIntoWorkSegments(messages, 90);
		const segmentsText = formatSegmentsForPrompt(segments);
		const reconcileInstruction = buildReconcileInstruction({
			project,
			cwd: ctx.cwd,
			filePath,
			existingContent,
			dailyLink,
			todayDate: targetDate,
			sessionCount: scannedSessionCount,
			contributingSessionCount,
			segmentsText,
			transcript,
		});

		await ctx.newSession({
			parentSession: originSessionFile,
			withSession: async (newCtx) => {
				await newCtx.sendUserMessage(reconcileInstruction);
				await newCtx.waitForIdle();
				const reconcileDraft = getLatestAssistantTextFromBranch(newCtx).trim();

				let eodDraft = "";
				try {
					const beforeEod = getLatestAssistantSnapshotFromBranch(newCtx);
					const eodInstruction = buildEodMissingInstruction({
						project,
						cwd: ctx.cwd,
						filePath,
						fileExists: true,
						existingContent: reconcileDraft || existingContent,
						dailyLink,
						todayDate: targetDate,
						sessionCount: scannedSessionCount,
						contributingSessionCount,
						transcript,
					});
					await newCtx.sendUserMessage(eodInstruction);
					await newCtx.waitForIdle();
					const afterEod = getLatestAssistantSnapshotFromBranch(newCtx);
					if (!afterEod.text || (beforeEod.entryId && afterEod.entryId === beforeEod.entryId)) {
						throw new Error("No new assistant output for EOD step");
					}
					eodDraft = normalizeModelMarkdownOutput(afterEod.text);
					if (!/^title\s*:/i.test(eodDraft)) {
						newCtx.ui.notify("EOD output was not in expected `Title:` format; skipping EOD write.", "warning");
						eodDraft = "";
					}
				} catch (e) {
					newCtx.ui.notify(`EOD generation failed; continuing with reconcile write only: ${e}`, "warning");
				}
				const eodRange = getLastMessageRange(messages);

				if (!originSessionFile) {
					await reviewAndRewriteDailyFileLoop(newCtx, reconcileDraft, targetDate);
					if (eodDraft) {
						await reviewAndWriteLoop(newCtx, eodDraft, eodRange, targetDate);
					}
					return;
				}

				await newCtx.switchSession(originSessionFile, {
					withSession: async (originCtx) => {
						await reviewAndRewriteDailyFileLoop(originCtx, reconcileDraft, targetDate);
						if (eodDraft) {
							await reviewAndWriteLoop(originCtx, eodDraft, eodRange, targetDate);
						}
						originCtx.ui.notify(completionMessage, "info");
					},
				});
			},
		});
		});
	} catch (e) {
		ctx.ui.notify(`Journal reconcile flow failed: ${e}`, "error");
	}
}

export const __testables = {
	isIsoDateString,
	resolveFilename,
	getWeekRangeForDate,
	getDateStringsInRange,
	extractTitleAndBody,
	splitIntoWorkSegments,
	formatSegmentsForPrompt,
	buildReconcileInstruction,
	buildEodMissingInstruction,
	buildWeeklyReviewInstruction,
	normalizeModelMarkdownOutput,
	normalizeReconcileDraft,
	normalizeWeeklyReviewDraft,
	isValidReconcileDraft,
	isValidWeeklyReviewDraft,
	getLatestAssistantSnapshotFromBranch,
	extractMessagesFromSessionFile,
	getAllSessionFilePaths,
	collectMessagesAcrossAllSessions,
	collectMessagesAcrossAllSessionsInRange,
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("journal", {
		description: "Generate journal draft in an isolated session, review in overlay, then write",
		handler: async (_args, ctx) => {
			await withConfiguredJournalModel(pi, ctx, async () => {
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

	pi.registerCommand("journal-reconcile", {
		description: "Rewrite a day's full journal by reconciling all sessions and existing entries. Optional: /journal-reconcile YYYY-MM-DD",
		handler: async (args, ctx) => {
			await withConfiguredJournalModel(pi, ctx, async () => {
				const argDate = args.trim();
				const todayDate = argDate && isIsoDateString(argDate) ? argDate : getTodayDateString();
				const { vaultDir, filePath } = resolveDatedFile(ctx.cwd, todayDate);
				if (!(await ensureVaultDir(ctx, vaultDir))) return;
			const project = getProjectName(ctx.cwd);
			const dailyLink = getDailyLink(todayDate);
			const originSessionFile = ctx.sessionManager.getSessionFile();
			const { messages, scannedSessionCount, contributingSessionCount } = collectMessagesAcrossAllSessions(todayDate);
			const transcript = buildSessionTranscript(messages, 240);
			const existingContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";

			if (!existingContent.trim() && messages.length === 0) {
				ctx.ui.notify(`No journal content or session activity found for ${todayDate}.`, "warning");
				return;
			}

			const segments = splitIntoWorkSegments(messages, 90);
			const segmentsText = formatSegmentsForPrompt(segments);
			const instruction = buildReconcileInstruction({
				project,
				cwd: ctx.cwd,
				filePath,
				existingContent,
				dailyLink,
				todayDate,
				sessionCount: scannedSessionCount,
				contributingSessionCount,
				segmentsText,
				transcript,
			});

				await ctx.newSession({
					parentSession: originSessionFile,
					withSession: async (newCtx) => {
						await newCtx.sendUserMessage(instruction);
						await newCtx.waitForIdle();
						const draft = getLatestAssistantTextFromBranch(newCtx).trim();

						if (!originSessionFile) {
							await reviewAndRewriteDailyFileLoop(newCtx, draft, todayDate);
							return;
						}

						await newCtx.switchSession(originSessionFile, {
							withSession: async (originCtx) => {
								await reviewAndRewriteDailyFileLoop(originCtx, draft, todayDate);
								originCtx.ui.notify("Journal reconcile draft was generated in an isolated session", "info");
							},
						});
					},
				});
			});
		},
	});

	pi.registerCommand("journal-eod", {
		description: "Generate an EOD note with only missing follow-ups/loose ends not already in journal",
		handler: async (_args, ctx) => {
			await withConfiguredJournalModel(pi, ctx, async () => {
				const { vaultDir, filePath, fileExists } = resolveDailyFile(ctx.cwd);
				if (!(await ensureVaultDir(ctx, vaultDir))) return;

			const todayDate = getTodayDateString();
			const project = getProjectName(ctx.cwd);
			const dailyLink = getTodayDailyLink();
			const originSessionFile = ctx.sessionManager.getSessionFile();
			const { messages, scannedSessionCount, contributingSessionCount } = collectMessagesAcrossAllSessions(todayDate);
			const transcript = buildSessionTranscript(messages, 180);
			const existingContent = fileExists ? readFileSync(filePath, "utf-8") : "";

			if (!existingContent.trim() && messages.length === 0) {
				ctx.ui.notify("No journal content or session activity found for today.", "warning");
				return;
			}

			const instruction = buildEodMissingInstruction({
				project,
				cwd: ctx.cwd,
				filePath,
				fileExists,
				existingContent,
				dailyLink,
				todayDate,
				sessionCount: scannedSessionCount,
				contributingSessionCount,
				transcript,
			});

				await ctx.newSession({
					parentSession: originSessionFile,
					withSession: async (newCtx) => {
						await newCtx.sendUserMessage(instruction);
						await newCtx.waitForIdle();
						const draft = getLatestAssistantTextFromBranch(newCtx).trim();

						if (!originSessionFile) {
							await reviewAndWriteLoop(newCtx, draft, undefined);
							return;
						}

						await newCtx.switchSession(originSessionFile, {
							withSession: async (originCtx) => {
								await reviewAndWriteLoop(originCtx, draft, undefined);
								originCtx.ui.notify("EOD missing-items draft was generated in an isolated session", "info");
							},
						});
					},
				});
			});
		},
	});

	pi.registerCommand("journal-date", {
		description: "Run reconcile + EOD-missing for a specific date (YYYY-MM-DD)",
		handler: async (args, ctx) => {
			const targetDate = args.trim();
			if (!targetDate || !isIsoDateString(targetDate)) {
				ctx.ui.notify("Usage: /journal-date YYYY-MM-DD", "warning");
				return;
			}
			await runReconcileAndEodForDate({
				pi,
				ctx,
				targetDate,
				noActivityMessage: `No journal content or session activity found for ${targetDate}.`,
				completionMessage: `${targetDate} reconcile + EOD drafts generated in an isolated session`,
			});
		},
	});

	pi.registerCommand("journal-yesterday", {
		description: "Run yesterday reconcile + EOD-missing in one flow",
		handler: async (_args, ctx) => {
			const targetDate = getDateString(-1);
			await runReconcileAndEodForDate({
				pi,
				ctx,
				targetDate,
				noActivityMessage: "No journal content or session activity found for yesterday.",
				completionMessage: "Yesterday reconcile + EOD drafts generated in an isolated session",
			});
		},
	});

	pi.registerCommand("journal-weekly-review", {
		description: "Generate a weekly review (highlights/lowlights/uncompleted) for the week containing an optional date",
		handler: async (args, ctx) => {
			await withConfiguredJournalModel(pi, ctx, async () => {
				const argDate = args.trim();
				if (argDate && !isIsoDateString(argDate)) {
					ctx.ui.notify("Usage: /journal-weekly-review [YYYY-MM-DD]", "warning");
					return;
				}
				const referenceDate = argDate || getTodayDateString();
				const { startDate, endDate } = getWeekRangeForDate(referenceDate);
				const { vaultDir, filePath, fileExists } = resolveWeeklyReviewFile(ctx.cwd, startDate, endDate);
				if (!(await ensureVaultDir(ctx, vaultDir))) return;

				const project = getProjectName(ctx.cwd);
				const originSessionFile = ctx.sessionManager.getSessionFile();

				ctx.ui.notify(`Ensuring daily worklogs exist for ${startDate} → ${endDate}...`, "info");
				const reconciliation = await ensureWeekWorklogs({
					ctx,
					originSessionFile,
					startDate,
					endDate,
				});

				if (reconciliation.createdDates.length > 0) {
					ctx.ui.notify(`Auto-reconciled missing worklogs: ${reconciliation.createdDates.join(", ")}`, "info");
				}
				if (reconciliation.noActivityDates.length > 0) {
					ctx.ui.notify(`Created no-activity worklogs: ${reconciliation.noActivityDates.join(", ")}`, "info");
				}
				if (reconciliation.failedDates.length > 0) {
					ctx.ui.notify(
						`Could not reconcile all missing worklogs (${reconciliation.failedDates.join(", ")}). Weekly review aborted.`,
						"error",
					);
					return;
				}

				const existingDailyJournals = collectExistingJournalContentInRange(ctx.cwd, startDate, endDate);
				const existingWeeklyReviewContent = fileExists ? readFileSync(filePath, "utf-8") : "";
				const weekDays = getDateStringsInRange(startDate, endDate);
				const dailyLinks = weekDays.map((d) => getDailyLink(d)).join(" ");
				const worklogDayCount = weekDays.length - getMissingDailyWorklogDates(ctx.cwd, startDate, endDate).length;

				if (!existingDailyJournals.trim() && !existingWeeklyReviewContent.trim()) {
					ctx.ui.notify(`No worklog content found for week ${startDate} → ${endDate}.`, "warning");
					return;
				}

				const instruction = buildWeeklyReviewInstruction({
					project,
					cwd: ctx.cwd,
					filePath,
					startDate,
					endDate,
					worklogDayCount,
					dailyLinks,
					existingWeeklyReviewContent,
					existingDailyJournals,
				});

				await ctx.newSession({
					parentSession: originSessionFile,
					withSession: async (newCtx) => {
						await newCtx.sendUserMessage(instruction);
						await newCtx.waitForIdle();
						const draft = getLatestAssistantTextFromBranch(newCtx).trim();

						if (!originSessionFile) {
							await reviewAndWriteWeeklyReviewLoop(newCtx, draft, startDate, endDate);
							return;
						}

						await newCtx.switchSession(originSessionFile, {
							withSession: async (originCtx) => {
								await reviewAndWriteWeeklyReviewLoop(originCtx, draft, startDate, endDate);
								originCtx.ui.notify("Weekly review draft was generated in an isolated session", "info");
							},
						});
					},
				});
			});
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
				`  Provider:      ${config.provider ?? "(default/current)"}`,
				`  Model:         ${config.model ?? "(default/current)"}`,
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
