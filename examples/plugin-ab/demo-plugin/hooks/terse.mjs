// SessionStart hook: adds a short-reply style rule to the session's context.
const RULES = `TERSE STYLE ON.
Write every reply to the user as short as it can be while staying exact.
- Lead with the answer or the change. No preamble, no recap of the request, no closing offer.
- Drop filler words and hedges. Keep every fact, number, name, path and command.
- Use short sentences or a flat list. Code, commands and error text stay exactly as they are.
- If something needs a decision from the user, say so in one line.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RULES } }));
