# Privacy

lot-map is a mod for Claude Code that draws a map of the work in a pane beside the chat. It runs inside Claude Code on your computer. There is no lot-map service, no account and no server: nothing the mod sees leaves your machine through it.

This page describes version 0.6.0. It changes only together with the code, and the [changelog](CHANGELOG.md) says when it did.

## What the mod is handed

Claude Code passes a mod that follows tool calls the whole input of every call: command lines, file paths, web addresses, the text written to files, the prompts of subagents. It also passes the text that your settings hooks add to a session or a message. Any of that can hold personal data, such as a name in a path or an address in a file.

The mod does not look for personal data and has no use for it. It takes a name for the row it draws and drops the rest:

- a file: the last two parts of its path;
- a web address: the host alone, without a login, password, path or query;
- a shell command: the short description Claude wrote for it, or the command's name, never the command line;
- a memory call: the tool's name and a record number or short identifier, never the text or the query;
- a subagent: the short description it was started with;
- a background task's report: that it ended and whether it failed;
- a hook's refusal: the name of the tool it stopped, and its first line only if you turn `hookReasons` on;
- context a hook added: that it was added, and record numbers only if you turn `hookRecords` on.

## What it keeps

- **During a session:** the rows of the map, the counters under the stations and the last model step, in Claude Code's state for the session. They are gone when the session ends.
- **Between sessions:** one value per folder, the name of the model last used there, so that the map can show a change of model. It is stored under the folder's full path in Claude Code's own store for the plugin, on your computer. A folder's path usually contains your account name.
- **Your options** (language, colours, memory servers and the rest) are kept by Claude Code in your settings, as for any plugin.

To remove what it keeps, uninstall the plugin.

## What it does not do

- It makes no network requests and has no telemetry, analytics or crash reports.
- It reads no files and runs no processes.
- It calls no model and adds nothing to the conversation.
- In a terminal that shows pictures it paints the map's picture itself, from the same rows, and hands it to Claude Code to draw in the pane. The picture holds nothing the map does not show.
- It changes no tool call, result, prompt or context. It sees what your settings hooks decide about a call, hands that decision on as it was, and decides nothing about permissions itself.

The code that takes names from a call is `classify` in [`hooks/map.ts`](hooks/map.ts); the hooks are in [`hooks/register.tsx`](hooks/register.tsx).

## Where the code comes from

Installed from this repository, the mod follows its `main` branch, so an update brings whatever is there. Read the diff before updating if that matters to you. Claude Code, the model and any catalogue you installed the mod from have their own terms, and this page does not speak for them.

## Questions

Open an issue: <https://github.com/alexeyw/lot-map/issues>.
