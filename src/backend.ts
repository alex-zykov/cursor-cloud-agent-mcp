import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v3";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { apiRequest, repositoriesTimeout } from "./api-client.js";
import { detectGitContext } from "./git-utils.js";
import type {
  Agent,
  CreateAgentResponse,
  CreateRunResponse,
  IdResponse,
  ListAgentsResponse,
  ListModelsResponse,
  ListRepositoriesResponse,
  ListRunsResponse,
  MeResponse,
  Run,
} from "./types.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("Error: CURSOR_API_KEY environment variable is required");
  console.error("Get your API key from https://cursor.com/settings");
  process.exit(1);
}

// ============================================================================
// HELPERS
// ============================================================================

function toolResult(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
    isError: true as const,
  };
}

function matchesRegex(text: string, pattern: string): boolean {
  try {
    const regex = new RegExp(pattern, "i");
    return regex.test(text);
  } catch (error) {
    console.error(`Invalid regex pattern: ${pattern}`, error);
    return false;
  }
}

function parseRepoUrl(url: string): { owner: string; name: string; repository: string } {
  const normalized = url.replace(/\.git$/, "");
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (match) {
    return {
      owner: match[1],
      name: match[2],
      repository: `https://github.com/${match[1]}/${match[2]}`,
    };
  }
  return { owner: "", name: "", repository: normalized };
}

function agentSearchString(agent: Agent, run?: Run): string {
  const branches = run?.git?.branches ?? [];
  return [
    agent.id,
    agent.name,
    agent.status,
    agent.url ?? "",
    agent.createdAt,
    agent.latestRunId ?? "",
    ...(agent.repos ?? []).flatMap((r) => [r.url, r.startingRef ?? "", r.prUrl ?? ""]),
    run?.status ?? "",
    run?.result ?? "",
    ...branches.flatMap((b) => [b.repoUrl, b.branch ?? "", b.prUrl ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
}

async function getLatestRun(agent: Agent): Promise<Run | undefined> {
  if (!agent.latestRunId) return undefined;
  try {
    return await apiRequest<Run>(
      "GET",
      `/v1/agents/${agent.id}/runs/${agent.latestRunId}`
    );
  } catch {
    return undefined;
  }
}

function enrichAgent(agent: Agent, run?: Run) {
  const primaryBranch = run?.git?.branches?.[0];
  return {
    ...agent,
    latestRun: run
      ? {
          id: run.id,
          status: run.status,
          result: run.result,
          durationMs: run.durationMs,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        }
      : undefined,
    branch: primaryBranch?.branch,
    prUrl: primaryBranch?.prUrl,
    git: run?.git,
  };
}

// ============================================================================
// SETUP SERVER
// ============================================================================

export function setupServer(server: McpServer): void {
  // --------------------------------------------------------------------------
  // TOOLS: CONTEXT & DISCOVERY
  // --------------------------------------------------------------------------

  server.registerTool(
    "get_repos",
    {
      title: "Get Repositories",
      description: `Get available repositories. First checks if you are in a git directory and returns that repo as "current". Then optionally lists other accessible repos from the API. Call this FIRST before creating agents to get the repository URL.

**Usage Examples:**
- Basic: Get current repo only: \`get_repos()\`
- Fetch all repos with filter (REQUIRED): \`get_repos({ include_all: true, regex_patterns: ["^my-.*"] })\`
- Filter with multiple patterns (OR): \`get_repos({ include_all: true, regex_patterns: [".*api.*", ".*backend.*"] })\`

**Important:** When using \`include_all: true\`, you MUST provide \`regex_patterns\` to filter the results. This prevents returning too many repositories. The repositories endpoint is rate limited (1/min, 30/hour) and can take tens of seconds.

**Workflow:** Use this tool first to discover repositories, then use the repository URL with \`create_agent\` to start working on a repo.`,
      inputSchema: {
        include_all: z
          .boolean()
          .optional()
          .describe(
            "Also fetch all accessible repos from API (rate limited: 1/min, 30/hour). Default: false, only returns current git repo if available."
          ),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Directory to check for git repo (defaults to current working directory)"
          ),
        regex_patterns: z
          .array(z.string())
          .optional()
          .describe(
            'Array of regex patterns to filter repositories. Matches repository name, owner, or full URL. Patterns are OR conditions (match if any pattern matches). REQUIRED when include_all is true. Example: ["^my-.*", ".*api.*"]'
          ),
      },
    },
    async (args) => {
      try {
        const cwd = args.working_directory || process.cwd();
        const gitContext = await detectGitContext(cwd);

        const result: {
          current?: {
            repository: string;
            branch?: string;
            has_uncommitted_changes?: boolean;
          };
          available?: Array<{
            owner: string;
            name: string;
            repository: string;
          }>;
          message?: string;
          filtered_count?: number;
          total_count?: number;
        } = {};

        let currentRepo:
          | {
              repository: string;
              branch?: string;
              has_uncommitted_changes?: boolean;
            }
          | undefined;
        if (gitContext.is_git_repo && gitContext.repository) {
          currentRepo = {
            repository: gitContext.repository,
            branch: gitContext.branch,
            has_uncommitted_changes: gitContext.has_uncommitted_changes,
          };
        }

        let allRepos:
          | Array<{ owner: string; name: string; repository: string }>
          | undefined;
        if (args.include_all) {
          if (!args.regex_patterns || args.regex_patterns.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Error: You have to add a filter. When using include_all: true, you must provide regex_patterns to filter the results. Example: get_repos({ include_all: true, regex_patterns: ["^my-.*"] })',
                },
              ],
              isError: true,
            };
          }
          try {
            const data = await apiRequest<ListRepositoriesResponse>(
              "GET",
              "/v1/repositories",
              undefined,
              repositoriesTimeout()
            );
            allRepos = data.items.map((item) => parseRepoUrl(item.url));
            result.total_count = allRepos.length;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            result.message = `Could not fetch repo list: ${errorMessage}`;
          }
        }

        if (args.regex_patterns && args.regex_patterns.length > 0) {
          if (currentRepo) {
            const repoString = `${currentRepo.repository} ${
              currentRepo.branch || ""
            }`.toLowerCase();
            const matches = args.regex_patterns.some((pattern) =>
              matchesRegex(repoString, pattern)
            );
            if (matches) {
              result.current = currentRepo;
            }
          }

          if (allRepos) {
            const filtered = allRepos.filter((repo) => {
              const repoString =
                `${repo.repository} ${repo.owner} ${repo.name}`.toLowerCase();
              return args.regex_patterns!.some((pattern) =>
                matchesRegex(repoString, pattern)
              );
            });
            result.available = filtered;
            result.filtered_count = filtered.length;
          }
        } else {
          if (currentRepo) {
            result.current = currentRepo;
          }
          if (allRepos) {
            result.available = allRepos;
          }
        }

        if (!result.current && !result.available) {
          result.message =
            "Not in a git repository. Call again with include_all: true to list accessible repos (rate limited).";
        }

        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_me",
    {
      title: "Get Current User",
      description: `Get API key information including name, creation date, and user email. Use this to verify authentication is working correctly.

**Usage Example:** \`get_me()\`

**Workflow:** Call this first to verify your API key is valid before using other tools.`,
      inputSchema: {},
    },
    async () => {
      try {
        const data = await apiRequest<MeResponse>("GET", "/v1/me");
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_models",
    {
      title: "Get Available Models",
      description: `List recommended LLM models for cloud agents (API v1). Each item includes id, displayName, parameters, and variants. Pass \`model.id\` to \`create_agent\`. If you omit the model parameter, Cursor uses the configured default.

**Usage Example:** \`get_models()\`

**Workflow:** Use this to see available models, then optionally specify one in \`create_agent\`. For most cases, omitting the model parameter (auto-selection) is recommended.`,
      inputSchema: {},
    },
    async () => {
      try {
        const data = await apiRequest<ListModelsResponse>("GET", "/v1/models");
        const result = {
          items: data.items,
          models: data.items.map((m) => m.id),
        };
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOLS: AGENT LIFECYCLE (v1: durable agent + per-prompt runs)
  // --------------------------------------------------------------------------

  server.registerTool(
    "create_agent",
    {
      title: "Create Cloud Agent",
      description: `Launch a new cloud agent (API v1). Creates a durable agent and immediately enqueues its initial run. Returns both \`agent\` and \`run\` objects.

**Usage Examples:**
- Basic: \`create_agent({ prompt: "Add README.md", repository: "https://github.com/owner/repo" })\`
- With branch: \`create_agent({ prompt: "Fix bug", repository: "https://github.com/owner/repo", ref: "main" })\`
- Auto-create PR: \`create_agent({ prompt: "Add feature", repository: "https://github.com/owner/repo", auto_pr: true })\`
- Plan mode: \`create_agent({ prompt: "Design auth", repository: "https://github.com/owner/repo", mode: "plan" })\`
- With plan file: \`create_agent({ prompt: "Implement features", repository: "https://github.com/owner/repo", plan_file: "./plan.md" })\`

**Workflow:**
1. Use \`get_repos\` to discover repository URLs
2. Call \`create_agent\` with your prompt
3. Use \`get_agent\` / \`get_run\` to monitor progress (agent status: ACTIVE|IDLE|ARCHIVED; run status: CREATING|RUNNING|FINISHED|ERROR|CANCELLED|EXPIRED)
4. Use \`create_run\` to send follow-up instructions when the agent is IDLE`,
      inputSchema: {
        prompt: z.string().min(1).describe("Task instructions"),
        repository: z
          .string()
          .url()
          .optional()
          .describe(
            "GitHub repository URL (e.g., https://github.com/owner/repo). Omit for a no-repo agent."
          ),
        ref: z
          .string()
          .optional()
          .describe("Git branch, tag, or commit to work from (startingRef)"),
        pr_url: z
          .string()
          .url()
          .optional()
          .describe(
            "GitHub PR URL — agent works on that PR's branches; startingRef is ignored"
          ),
        auto_pr: z
          .boolean()
          .optional()
          .describe("Auto-create a PR when done (default: false)"),
        work_on_current_branch: z
          .boolean()
          .optional()
          .describe(
            "Push directly to startingRef instead of creating a cursor/... branch (default: false)"
          ),
        skip_reviewer_request: z
          .boolean()
          .optional()
          .describe(
            "Skip requesting the user as reviewer when auto_pr is true"
          ),
        model: z
          .string()
          .optional()
          .describe("LLM model id from get_models (omit for default)"),
        name: z
          .string()
          .max(100)
          .optional()
          .describe("Display name for the agent (auto-derived if omitted)"),
        mode: z
          .enum(["agent", "plan"])
          .optional()
          .describe(
            "Initial conversation mode: agent (implement) or plan (draft a plan first)"
          ),
        plan_file: z
          .string()
          .optional()
          .describe(
            "Path to a plan file to include in the prompt (relative or absolute path)"
          ),
      },
    },
    async (args) => {
      try {
        let promptText = args.prompt;

        if (args.plan_file) {
          try {
            const planPath = resolve(args.plan_file);
            const planContent = await readFile(planPath, "utf-8");
            promptText = `${args.prompt}\n\n## Plan File\n\n${planContent}`;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Error reading plan file: ${errorMessage}`,
                },
              ],
              isError: true,
            };
          }
        }

        const requestBody: Record<string, unknown> = {
          prompt: { text: promptText },
        };

        if (args.repository || args.pr_url) {
          if (args.pr_url && !args.repository) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: repository is required when pr_url is set (API v1 requires repos[].url alongside prUrl).",
                },
              ],
              isError: true,
            };
          }
          const repo: Record<string, unknown> = {
            url: args.repository!,
          };
          if (args.pr_url) {
            repo.prUrl = args.pr_url;
          }
          if (args.ref && !args.pr_url) {
            repo.startingRef = args.ref;
          }
          requestBody.repos = [repo];
        }

        if (args.auto_pr !== undefined) {
          requestBody.autoCreatePR = args.auto_pr;
        }
        if (args.work_on_current_branch !== undefined) {
          requestBody.workOnCurrentBranch = args.work_on_current_branch;
        }
        if (args.skip_reviewer_request !== undefined) {
          requestBody.skipReviewerRequest = args.skip_reviewer_request;
        }
        if (args.model) {
          requestBody.model = { id: args.model };
        }
        if (args.name) {
          requestBody.name = args.name;
        }
        if (args.mode) {
          requestBody.mode = args.mode;
        }

        const data = await apiRequest<CreateAgentResponse>(
          "POST",
          "/v1/agents",
          requestBody
        );

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // Backwards-compatible alias
  server.registerTool(
    "create_task",
    {
      title: "Create Cloud Task (alias)",
      description:
        "Alias for `create_agent`. Prefer `create_agent` — Cloud Agents API v1 uses durable agents plus per-prompt runs.",
      inputSchema: {
        prompt: z.string().min(1).describe("Task instructions"),
        repository: z
          .string()
          .url()
          .describe(
            "GitHub repository URL (e.g., https://github.com/owner/repo)"
          ),
        ref: z
          .string()
          .optional()
          .describe("Git branch, tag, or commit to work from"),
        auto_pr: z
          .boolean()
          .optional()
          .describe("Auto-create a PR when done (default: false)"),
        model: z
          .string()
          .optional()
          .describe("LLM model to use (omit for auto-selection)"),
        plan_file: z
          .string()
          .optional()
          .describe(
            "Path to a plan file to include in the prompt (relative or absolute path)"
          ),
      },
    },
    async (args) => {
      // Delegate by reusing create_agent logic via direct API call path —
      // invoke the same handler body by calling create_agent's endpoint.
      try {
        let promptText = args.prompt;
        if (args.plan_file) {
          const planPath = resolve(args.plan_file);
          const planContent = await readFile(planPath, "utf-8");
          promptText = `${args.prompt}\n\n## Plan File\n\n${planContent}`;
        }

        const requestBody: Record<string, unknown> = {
          prompt: { text: promptText },
          repos: [
            {
              url: args.repository,
              ...(args.ref ? { startingRef: args.ref } : {}),
            },
          ],
        };
        if (args.auto_pr !== undefined) {
          requestBody.autoCreatePR = args.auto_pr;
        }
        if (args.model) {
          requestBody.model = { id: args.model };
        }

        const data = await apiRequest<CreateAgentResponse>(
          "POST",
          "/v1/agents",
          requestBody
        );

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_agents",
    {
      title: "List Cloud Agents",
      description: `List cloud agents for the authenticated user (API v1), newest first. List items are lean — call \`get_agent\` for full details including repos and latest run status.

**Usage Examples:**
- Basic listing: \`list_agents()\`
- Filter by status: \`list_agents({ filter: "ACTIVE|IDLE" })\`
- Filter by repository: \`list_agents({ filter: ".*my-repo.*" })\`
- Include only non-archived: \`list_agents({ include_archived: false })\`
- Filter by PR: \`list_agents({ pr_url: "https://github.com/org/repo/pull/1" })\`

**Agent status:** ACTIVE (turn running), IDLE (accepts follow-ups), ARCHIVED.
**Run status** lives on runs — use \`get_agent\` or \`get_run\`.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        pr_url: z
          .string()
          .url()
          .optional()
          .describe("Filter agents by GitHub pull request URL"),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived agents (default: true)"),
        filter: z
          .string()
          .optional()
          .describe(
            'Regex pattern to filter agents across id, name, status, url, etc. Example: "ACTIVE|IDLE" or ".*my-repo.*"'
          ),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.limit) params.append("limit", args.limit.toString());
        if (args.cursor) params.append("cursor", args.cursor);
        if (args.pr_url) params.append("prUrl", args.pr_url);
        if (args.include_archived !== undefined) {
          params.append("includeArchived", String(args.include_archived));
        }

        const path = `/v1/agents${params.toString() ? `?${params}` : ""}`;
        const data = await apiRequest<ListAgentsResponse>("GET", path);

        let filtered = data.items;
        const totalCount = data.items.length;

        if (args.filter) {
          filtered = data.items.filter((agent) =>
            matchesRegex(agentSearchString(agent), args.filter!)
          );
        }

        const result = {
          agents: filtered,
          nextCursor: data.nextCursor,
          ...(args.filter
            ? {
                filtered_count: filtered.length,
                total_count: totalCount,
              }
            : {}),
        };

        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Cloud Tasks (alias)",
      description:
        "Alias for `list_agents`. Prefer `list_agents` — Cloud Agents API v1 uses agents, not tasks.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        filter: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.limit) params.append("limit", args.limit.toString());
        if (args.cursor) params.append("cursor", args.cursor);
        const path = `/v1/agents${params.toString() ? `?${params}` : ""}`;
        const data = await apiRequest<ListAgentsResponse>("GET", path);

        let filtered = data.items;
        if (args.filter) {
          filtered = data.items.filter((agent) =>
            matchesRegex(agentSearchString(agent), args.filter!)
          );
        }

        const result = {
          agents: filtered,
          tasks: filtered,
          nextCursor: data.nextCursor,
        };

        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get Agent Status",
      description: `Get durable metadata for a cloud agent, plus its latest run (execution status, result, branches, PR URL).

**Usage Example:** \`get_agent({ id: "bc-..." })\`

**Agent status:** ACTIVE | IDLE | ARCHIVED
**Run status:** CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED

**Workflow:** After \`create_agent\` or \`list_agents\`, use this to monitor. When status is IDLE, send follow-ups with \`create_run\`.`,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID (e.g., bc-...)"),
      },
    },
    async (args) => {
      try {
        const agent = await apiRequest<Agent>(
          "GET",
          `/v1/agents/${args.id}`
        );
        const run = await getLatestRun(agent);
        const data = enrichAgent(agent, run);

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task Status (alias)",
      description:
        "Alias for `get_agent`. Prefer `get_agent` — Cloud Agents API v1 uses agents, not tasks.",
      inputSchema: {
        id: z.string().min(1).describe("Agent ID (e.g., bc-...)"),
      },
    },
    async (args) => {
      try {
        const agent = await apiRequest<Agent>(
          "GET",
          `/v1/agents/${args.id}`
        );
        const run = await getLatestRun(agent);
        const data = enrichAgent(agent, run);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "create_run",
    {
      title: "Create Follow-up Run",
      description: `Send a follow-up prompt to an existing agent (API v1). Creates a new run on the agent's conversation and workspace. Only one run can be active per agent — wait until IDLE / terminal run status, or cancel the active run first.

**Usage Example:** \`create_run({ id: "bc-...", prompt: "Also add a troubleshooting section" })\`

**Workflow:**
1. Create an agent with \`create_agent\`
2. Monitor with \`get_agent\` until agent is IDLE (or latest run is FINISHED/ERROR/CANCELLED)
3. Send follow-ups with \`create_run\`
4. Continue monitoring`,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        prompt: z.string().min(1).describe("Follow-up instructions"),
        mode: z
          .enum(["agent", "plan"])
          .optional()
          .describe("Override conversation mode for this run"),
      },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          prompt: { text: args.prompt },
        };
        if (args.mode) {
          body.mode = args.mode;
        }

        const data = await apiRequest<CreateRunResponse>(
          "POST",
          `/v1/agents/${args.id}/runs`,
          body
        );

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "add_followup",
    {
      title: "Add Follow-up (alias)",
      description:
        "Alias for `create_run`. Prefer `create_run` — in API v1 follow-ups are new runs on the agent.",
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        prompt: z.string().min(1).describe("Follow-up instructions"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<CreateRunResponse>(
          "POST",
          `/v1/agents/${args.id}/runs`,
          { prompt: { text: args.prompt } }
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_runs",
    {
      title: "List Agent Runs",
      description: `List runs for an agent, newest first. Each run is one prompt submission (initial create or follow-up).

**Usage Example:** \`list_runs({ id: "bc-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.limit) params.append("limit", args.limit.toString());
        if (args.cursor) params.append("cursor", args.cursor);
        const qs = params.toString() ? `?${params}` : "";
        const data = await apiRequest<ListRunsResponse>(
          "GET",
          `/v1/agents/${args.id}/runs${qs}`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_run",
    {
      title: "Get Run Status",
      description: `Get status, timestamps, and (for terminal runs) the final result, duration, and pushed branches/PRs for a specific run.

**Usage Example:** \`get_run({ id: "bc-...", run_id: "run-..." })\`

**Run status:** CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED`,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        run_id: z.string().min(1).describe("Run ID"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<Run>(
          "GET",
          `/v1/agents/${args.id}/runs/${args.run_id}`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel Run",
      description: `Cancel the active run for an agent. Cancellation is terminal — the run becomes CANCELLED. To continue, create a new run with \`create_run\`.

**Usage Example:** \`cancel_run({ id: "bc-...", run_id: "run-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        run_id: z.string().min(1).describe("Run ID to cancel"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<IdResponse>(
          "POST",
          `/v1/agents/${args.id}/runs/${args.run_id}/cancel`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get Agent Run Summaries",
      description: `Approximate conversation history by listing runs and their terminal \`result\` text (API v1 has no dedicated /conversation endpoint — that was v0-only).

Returns runs newest-first with status and result when available. For live streaming, use the Cursor dashboard or the SSE stream endpoint.

**Usage Example:** \`get_conversation({ id: "bc-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max runs to include (default: 20)"),
      },
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const listed = await apiRequest<ListRunsResponse>(
          "GET",
          `/v1/agents/${args.id}/runs?limit=${limit}`
        );

        const messages: Array<{
          id: string;
          type: string;
          text: string;
          status: string;
          createdAt: string;
        }> = [];

        for (const item of listed.items) {
          let run = item;
          if (
            !run.result &&
            ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(run.status)
          ) {
            try {
              run = await apiRequest<Run>(
                "GET",
                `/v1/agents/${args.id}/runs/${item.id}`
              );
            } catch {
              // keep list item
            }
          }

          messages.push({
            id: run.id,
            type: "run_result",
            text: run.result ?? `(run ${run.status}, no result text yet)`,
            status: run.status,
            createdAt: run.createdAt,
          });
        }

        const data = {
          id: args.id,
          note: "v1 API has no conversation endpoint; this lists run results instead of full user/assistant turns.",
          messages,
          nextCursor: listed.nextCursor,
        };

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "archive_agent",
    {
      title: "Archive Agent",
      description: `Soft-delete an agent. Archived agents remain readable but cannot accept new runs until unarchived. Prefer this over permanent delete.

**Usage Example:** \`archive_agent({ id: "bc-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID to archive"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<IdResponse>(
          "POST",
          `/v1/agents/${args.id}/archive`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "unarchive_agent",
    {
      title: "Unarchive Agent",
      description: `Unarchive an agent so it can accept new runs again.

**Usage Example:** \`unarchive_agent({ id: "bc-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID to unarchive"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<IdResponse>(
          "POST",
          `/v1/agents/${args.id}/unarchive`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "delete_agent",
    {
      title: "Delete Agent Permanently",
      description: `Permanently delete a cloud agent. Irreversible. Prefer \`archive_agent\` for reversible removal.

**Usage Example:** \`delete_agent({ id: "bc-..." })\``,
      inputSchema: {
        id: z.string().min(1).describe("Agent ID to delete"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<IdResponse>(
          "DELETE",
          `/v1/agents/${args.id}`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task (alias)",
      description:
        "Alias for `delete_agent`. Prefer `delete_agent` or `archive_agent`.",
      inputSchema: {
        id: z.string().min(1).describe("Agent ID to delete"),
      },
    },
    async (args) => {
      try {
        const data = await apiRequest<IdResponse>(
          "DELETE",
          `/v1/agents/${args.id}`
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // --------------------------------------------------------------------------
  // PROMPTS
  // --------------------------------------------------------------------------

  server.registerPrompt(
    "plan-parallel-tasks",
    {
      title: "Plan Parallel Agents",
      description:
        "Break down a project into parallelizable work for multiple cloud agents. Auto-detects repository context and creates a phased execution plan.",
      argsSchema: {
        project_description: z
          .string()
          .describe("What you want to build or change"),
        repository: z
          .string()
          .optional()
          .describe("Repository URL (auto-detected if omitted)"),
        branch: z
          .string()
          .optional()
          .describe("Base branch (auto-detected if omitted)"),
      },
    },
    ({ project_description, repository, branch }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Plan parallel cloud agents for this project:

${project_description}

${
  repository
    ? `Repository: ${repository}`
    : "**Step 1**: Call get_repos to detect the current repository"
}
${branch ? `Branch: ${branch}` : ""}

## Instructions

1. **Detect Context**: Use get_repos to find the repository URL and current branch
2. **Analyze**: Break the project into independent tasks
3. **Plan Phases**: Group tasks by dependencies

## Parallelization Rules

**CAN be parallel**: Tasks that modify completely different files
**CANNOT be parallel**: Tasks that modify the same file or depend on each other's output

## Output Format

For each task provide:
- **Task Name**: Short name
- **Files**: List of files to create/modify
- **Dependencies**: Tasks that must complete first (or "None")
- **Prompt**: Exact text for create_agent

Group into phases:
- **Phase 1**: No dependencies (run all in parallel)
- **Phase 2**: Depends on Phase 1 (run in parallel after Phase 1)
- **Phase 3**: Integration (sequential, touches shared files)

After approval, use create_agent for each Phase 1 task, then monitor with list_agents / get_agent.`,
          },
        },
      ],
    })
  );
}
