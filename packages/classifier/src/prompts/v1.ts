// Prompt v1 — inlined as a TS const so the package ships with no asset-
// copy build step. The source-of-truth English text is duplicated in
// `src/prompts/v1.md` for human review / dashboard rendering; this
// constant is the version compiled into the bundle.
//
// Any edit must change BOTH files (the .md is the diffable form for
// reviewers; this is what runs). A future asset-bundling story can
// collapse the duplication; for now the .md stays for spec §4.4
// "the file path is the version identifier" intent.

export const PROMPT_V1 = `You classify durable memories for a personal memory store. For each
memory, decide two booleans:

- requires_approval: true if the memory contains identity facts,
  relationship facts, or anything an owner would want to review
  before it becomes active. False otherwise.
- is_global: true if the memory should bypass per-conversation domain
  filtering and be available everywhere (identity, relationships,
  preferences). False if it's contextual to a specific domain (tools,
  projects, lessons, environment).

Think as long as you need. When ready, output a single line:
{"requires_approval": <bool>, "is_global": <bool>}

The parser reads only the last JSON object on stdout; reasoning before
that line is ignored.

Few-shot examples:

TITLE: User's name is Jim
BODY: User goes by Jim. Pronouns he/him.
TAGS: identity
{"requires_approval": true, "is_global": true}

TITLE: Married to Sara
BODY: Sara is Jim's wife. They live together in London.
TAGS: relationship
{"requires_approval": true, "is_global": true}

TITLE: Prefers dark mode
BODY: User keeps their editor and terminal in dark mode everywhere.
TAGS: preference
{"requires_approval": false, "is_global": true}

TITLE: Project the-librarian uses pnpm
BODY: The-librarian monorepo uses pnpm workspaces, not npm or yarn.
TAGS: tooling, project:the-librarian
{"requires_approval": false, "is_global": false}

TITLE: Bug in dashboard auth flow on iOS Safari
BODY: Login redirects loop on iOS Safari when localStorage is sandboxed; needs to fall back to sessionStorage.
TAGS: bug, dashboard, ios-safari, project:the-librarian
{"requires_approval": false, "is_global": false}

TITLE: SSH key for prod box at ~/.ssh/prod_ed25519
BODY: Production server SSH key lives at ~/.ssh/prod_ed25519. Passphrase in 1Password under "prod ssh".
TAGS: secret, environment
{"requires_approval": true, "is_global": false}

Now classify:
TITLE: {{title}}
BODY: {{body}}
TAGS: {{tags}}
`;
