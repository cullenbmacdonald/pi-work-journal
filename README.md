# pi-work-journal

A standalone [Pi](https://pi.dev) extension package for maintaining a daily work journal in a local vault (for example, Obsidian).

It supports:

- quick in-session journaling (`/journal`)
- full-day reconstruction (`/journal-reconcile`)
- end-of-day missing-item checks (`/journal-eod`)
- catch-up runs for missed days (`/journal-yesterday`, `/journal-date YYYY-MM-DD`)
- end-of-week summaries (`/journal-weekly-review [YYYY-MM-DD]`)

---

## How it works

The extension writes to a date-based markdown file in your configured `vaultPath`.

If configured, journal generation commands can also switch to a specific provider/model for drafting (`provider` + `model`).

### Privacy and data flow

This extension is local-first for file storage, but generation commands send selected context to your active/configured Pi model provider so the model can draft journal text.

- `/journal` uses the current branch/session context only.
- `/journal-reconcile`, `/journal-eod`, `/journal-yesterday`, `/journal-date`, and `/journal-weekly-review` scan Pi session files for the requested date/range and include transcript excerpts in model prompts.
- Session scans intentionally skip internal journal-generation sessions created by this extension, so previous generated prompts and embedded transcript excerpts are not recursively re-sent in later journal runs.
- Config files can include local paths and model preferences. Keep personal config out of git; `.pi/` and `work-journal.json` are gitignored here.
- Project-local config (`<cwd>/.pi/work-journal.json`) overrides global config. Review it before running journal commands in an untrusted repo.

### Session scanning

Reconcile and EOD commands scan **all** Pi session directories — not just the current project. This means activity across every project you worked on that day is captured in one journal file.

Session files are stored under `~/.pi/agent/sessions/<project-slug>/` as `.jsonl` files. The global scan walks every project subdirectory and filters messages by the target date.

### Entry format

For normal entries, it writes headings like:

```md
### HH:MM or HH:MM–HH:MM — <project>: <title>
```

and separates appended entries with:

```md
---
```

### Generation flow

For generation commands, it:

1. gathers session/journal context,
2. generates a draft in an isolated Pi session,
3. returns you to your original session,
4. opens a review overlay (**Write / Edit / Cancel**),
5. writes the result to the target day file.

---

## Commands

### `/journal`
Drafts a journal entry from the **current branch/session context** and appends it to today's file.

Use this during the day when you remember to log progress.

> Note: This is the only command that scans only the current project session — it's about capturing what you're working on right now.

### `/journal-write <markdown>`
Manually append an entry. The extension still applies heading/timestamp/project formatting automatically.

### `/journal-reconcile [YYYY-MM-DD]`
Performs a **full reconcile** for a given date (defaults to today):

- scans **all** Pi session directories for activity on that date,
- reads the current journal file for that date,
- detects major work segments from message time gaps,
- generates a reconstructed full-day file,
- **rewrites the day file** so it reads like you journaled at key moments.

Examples:

```bash
/journal-reconcile            # reconcile today
/journal-reconcile 2026-05-20 # reconcile a specific date
```

### `/journal-eod`
Performs an **EOD missing-only pass for today**:

- compares **all** session activity from today vs today's full journal,
- appends only missing follow-ups/loose ends/TODOs,
- avoids re-listing things already captured.

### `/journal-yesterday`
Runs yesterday catch-up in one command:

1. reconcile yesterday's full log,
2. append yesterday's missing-only EOD note.

### `/journal-date YYYY-MM-DD`
Same as `/journal-yesterday`, but for any explicit date. Runs reconcile + EOD in one flow.

Example:

```bash
/journal-date 2026-05-21
```

### `/journal-weekly-review [YYYY-MM-DD]`
Generates a weekly review file for the week containing the provided date (defaults to current week).

Before generating the weekly review, it ensures there is a daily worklog for every day in that week:

1. checks for missing daily worklogs,
2. auto-runs reconcile for missing days (or writes a "no recorded work" placeholder when there is no Pi activity),
3. then generates the weekly review from the full set of daily worklogs.

Weekly output includes:

- highlights
- lowlights
- uncompleted work (`- [ ]` checkboxes)
- Monday restart context

Output file path pattern:

```text
<vaultPath>/<week-start>_to_<week-end>-weekly-review.md
```

Example:

```bash
/journal-weekly-review
/journal-weekly-review 2026-05-22
```

### `/journal-config`
Shows resolved config and target file details.

---

## Recommended workflow

Typical daily flow:

1. Use `/journal` a few times during the day when possible.
2. Run `/journal-reconcile` later (afternoon/evening) to rebuild missing structure.
3. Run `/journal-eod` at end of day to capture only missing loose ends/follow-ups.

If you forgot end-of-day:

- run `/journal-yesterday` the next morning (or `/journal-date YYYY-MM-DD`).

End of week:

- run `/journal-weekly-review` to generate a full-week summary for Monday context reset.

---

## Install

From git:

```bash
pi install git:github.com/cullenbmacdonald/pi-work-journal
```

From local path:

```bash
pi install /Users/you/dev/pi-work-journal
```

---

## Configuration

Config files are merged (project overrides global):

- `~/.pi/agent/work-journal.json`
- `<cwd>/.pi/work-journal.json`

Example:

```json
{
  "vaultPath": "~/Documents/worklogs",
  "filePattern": "{{date}}-worklog.md",
  "provider": "your-provider-id",
  "model": "your-model-id"
}
```

Supported filename placeholders:

- `{{date}}` → `YYYY-MM-DD`
- `{{timestamp}}` → ISO timestamp (filesystem-safe)

Optional model selection keys:

- `provider` — model provider id
- `model` — model id

Notes:

- `provider` and `model` must be set together.
- When set, generation commands (`/journal`, `/journal-reconcile`, `/journal-eod`, `/journal-yesterday`, `/journal-date`) use that model for drafting and then restore your previous model afterward.
