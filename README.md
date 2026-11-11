# Agent Arena

Give one task, such as "Add a dark mode toggle", to several coding agents at once. Each agent works on its own copy of a small to-do app in its own Namespace Devbox, and each devbox serves a live preview URL, so you can watch the results side by side and keep the best one.

It is built with the [Namespace Devbox TypeScript SDK](https://github.com/namespacelabs/typescript-sdk) and shows:

- **Custom images**: [`image/Dockerfile`](image/Dockerfile) bakes Node 22, git, Claude Code, and the sample app into one image.
- **Blueprints**: [`src/setup.ts`](src/setup.ts) defines every contestant once: image, size, an API key from the Namespace Vault, and a network policy that only allows the Anthropic API and npm.
- **Sessions**: the blueprint starts a tmux session named `agent` on every devbox. It runs [`image/arena-agent`](image/arena-agent), which waits for the task and runs the agent where you can attach, watch, or take over.
- **Services**: [`src/arena.ts`](src/arena.ts) starts the app's dev server as a supervised service and exposes it on a `devbox.so` URL.

## Agents

| Agent | Needs | What it does |
| --- | --- | --- |
| `claude` | An Anthropic API key, or a Claude subscription token from `claude setup-token`, in the Namespace Vault | Runs Claude Code interactively on the task |
| `demo` | Nothing | Types out its progress and applies a canned dark-mode change, so you can try the arena without a key |

Without `--agent`, each devbox uses `claude` when the blueprint has credentials and `demo` otherwise. To add another agent, such as Codex, install it in the image and add a case to `arena-agent`.

## Run it

You need the [Devbox CLI](https://namespace.so/docs/devbox), logged in (`devbox auth check`), and Node 22.

```bash
npm install

# 1. Build the image. The repository root is the build context, so the image
#    can include the sample app.
devbox image build . --name arena-runner -f image/Dockerfile --workspace_dir /workspace

# 2. Create the blueprint. Skip the variable to use the demo agent.
ANTHROPIC_SECRET_ID=sec_... npx tsx src/setup.ts

# 3. Start three contestants.
npx tsx src/arena.ts run 3 "Add a dark mode toggle"
```

`run` prints each devbox with its preview URL and the command to watch its agent:

```bash
devbox session connect arena-<id>-1 --session agent
```

Then:

```bash
npx tsx src/arena.ts status    # runs npm test on every devbox
npx tsx src/arena.ts cleanup   # deletes the arena devboxes
```

`nsc vault list` shows your Vault secret IDs. For a subscription token instead of an API key, set `CLAUDE_OAUTH_SECRET_ID`.

## How it fits together

1. `arena.ts run` creates N devboxes from the `agent-arena` blueprint. Each boots with the sample app in `/workspace/app` and the `agent` session waiting.
2. It writes the task to `/workspace/TASK.md` with `devbox.fs`. The task goes through a file because devboxes created from a blueprint cannot override its environment, and a file the session waits for cannot race with the session starting.
3. It starts `npm run dev` as the `preview` service and exposes port 5173. Vite's `server.allowedHosts` accepts `.devbox.so`, and hot reload goes through port 443, so the preview updates as the agent edits.
4. `status` runs `npm test` and `git status` on each devbox through `devbox.exec`.

## The sample app

[`sample-app/`](sample-app) is a Vite to-do app with three Vitest tests. Run it locally with `npm install && npm run dev` in that folder.
