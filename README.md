# pi-work-journal

A standalone [Pi](https://pi.dev) extension package for writing daily work journal entries to a local vault (e.g. Obsidian).

## Features

- `/journal` — summarize the current session into a structured worklog entry.
- `/journal-write <markdown>` — manually append/write an entry.
- `/journal-config` — show resolved configuration and today's target file.

## Install

From git:

```bash
pi install git:github.com/cullenbmacdonald/pi-work-journal
```

From local path:

```bash
pi install /Users/you/dev/pi-work-journal
```

## Configuration

Config files are merged (project overrides global):

- `~/.pi/agent/work-journal.json`
- `<cwd>/.pi/work-journal.json`

Example:

```json
{
  "vaultPath": "~/Documents/Obsidian/MyVault/work-journal",
  "filePattern": "{{date}}.md"
}
```

Supported filename placeholders:

- `{{date}}` → `YYYY-MM-DD`
- `{{timestamp}}` → ISO timestamp (filesystem-safe)
