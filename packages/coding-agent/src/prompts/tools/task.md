Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (workers) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

## Available Agents

{{#list agents prefix="- " join="\n"}}
{{name}}: {{description}} (Tools: {{default (join tools ", ") "All tools"}})
{{/list}}
{{#if moreAgents}}
  ...and {{moreAgents}} more agents
{{/if}}

## When NOT to Use

- Reading a specific file path → Use Read tool instead
- Finding files by pattern/name → Use Find tool instead
- Searching for a specific class/function definition → Use Grep tool instead
- Searching code within 2-3 specific files → Use Read tool instead
- Tasks unrelated to the agent descriptions above

## Usage Notes

- Always include a short description of the task in the task parameter
- **Plan-then-execute**: Put shared constraints in `context`, keep each task focused, specify acceptance criteria; use `output` when you need structured output
- **Minimize tool chatter**: Avoid repeating large context; use Output tool with output ids for full logs
- **Structured completion**: If `output` is provided, subagents must call `complete` to finish
- **Parallelize**: Launch multiple agents concurrently whenever possible
- **Results are intermediate data**: Agent findings provide context for YOU to perform actual work. Do not treat agent reports as "task complete" signals.
- **Stateless invocations**: Each agent runs autonomously and returns a single final message. Include all necessary context and specify exactly what information to return.
- **Trust outputs**: Agent results should generally be trusted
- **Clarify intent**: Tell the agent whether you expect code changes or just research (search, file reads, web fetches)
- **Proactive use**: If an agent description says to use it proactively, do so without waiting for explicit user request

## Parameters

- `agent`: Agent type to use for all tasks
- `context`: Shared context string prepended to all task prompts
- `model`: (optional) Model override (fuzzy matching, e.g., "sonnet", "opus")
- `tasks`: Array of `{id, task, description}` - tasks to run in parallel (max {{MAX_PARALLEL_TASKS}}, {{MAX_CONCURRENCY}} concurrent)
  - `id`: Short CamelCase identifier for display (max 20 chars, e.g., "SessionStore", "LspRefactor")
  - `task`: The task prompt for the agent
  - `description`: Short human-readable description of what the task does
- `output`: (optional) JTD schema for structured subagent output (used by the complete tool)

## Example

<example>
user: "Extract all hardcoded strings for i18n"
assistant: I'll scan UI components and return structured string locations for internationalization.
assistant: Uses the Task tool:
{
  "agent": "explore",
  "context": "Find hardcoded user-facing strings (labels, messages, errors). Ignore logs, comments, and internal identifiers.",
  "output": {
    "properties": {
      "strings": {
        "elements": {
          "properties": {
            "file": { "type": "string" },
            "line": { "type": "uint32" },
            "text": { "type": "string" },
            "suggestedKey": { "type": "string" }
          }
        }
      }
    }
  },
  "tasks": [
    { "id": "Forms", "task": "Scan src/components/forms/", "description": "Extract form strings" },
    { "id": "Modals", "task": "Scan src/components/modals/", "description": "Extract modal strings" },
    { "id": "Pages", "task": "Scan src/pages/", "description": "Extract page strings" }
  ]
}
</example>
