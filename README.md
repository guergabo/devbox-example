# my-platform-devbox

A starting point for building a platform on [Namespace](https://namespace.so): every customer of your platform gets their own isolated Namespace tenant, and inside it, devboxes that run an [Amp](https://ampcode.com) coding agent.

It uses the [Namespace TypeScript SDK](https://github.com/namespacelabs/typescript-sdk) and shows:

- **Multi-tenancy**: [`src/platform.ts`](src/platform.ts) signs partner tokens with your platform's key, finds or creates a tenant per customer, and gets short-lived tokens that act only inside it.
- **Custom images**: [`image/Dockerfile`](image/Dockerfile) defines the agent's environment (Node 22, git, the Amp CLI, an empty project). Each customer's tenant builds it into its own registry.
- **Vault secrets**: the Amp token is stored in each customer's Vault, so devboxes get it without it appearing anywhere else.
- **Blueprints**: [`src/customers.ts`](src/customers.ts) defines the devbox once (image, size, token, network policy) and applies it to each customer's tenant.
- **Services**: [`src/devboxes.ts`](src/devboxes.ts) runs an [Amp runner](https://ampcode.com/docs/cli/runners) (`amp --no-tui`) on each devbox as a supervised service and can start a first thread on it.

## Set up

You need Node 22, the [Devbox CLI](https://namespace.so/docs/devbox) logged in (`devbox auth check`), and an Amp access token (starts with `sgamp_`; create one under [Settings](https://ampcode.com/settings)).

```bash
npm install
cp .env.example .env    # then fill it in
```

In `.env`:

- `AMP_API_KEY`: your Amp token. In this template every customer's agent uses it, so their threads run on your Amp account; a real platform would store each customer's own token.
- `NAMESPACE_PARTNER_*`: your partner ID, issuer, key ID, and the path to your private key. They let your platform create tenants. Today the Namespace team issues them ([support@namespace.so](mailto:support@namespace.so)); this step may change once partner access is self-service. Leave them empty to run everything in your own workspace, without tenants.

## Run it

```bash
# Onboard a customer: their tenant, image, Amp token, and blueprint.
# Takes a few minutes the first time, while the image builds.
npm run add-customer -- acme

# Start an agent for them, optionally with a first task.
npm run devbox -- create acme "Build a to-do app with Vite"

npm run devbox -- list acme                 # each devbox, its runner, and changed files
npm run devbox -- delete acme [<devbox>]    # delete their devboxes

npm run remove-customer -- acme             # delete their tenant and everything in it
```

`acme` is any ID your platform uses for a customer, such as a user or organization ID from your own database (lowercase letters, digits, and hyphens).

## How it works

- **Tenants.** `customer("acme")` asks Namespace for the tenant with external account ID `my-platform-devbox:acme`, creating it the first time. Namespace keeps that mapping and allows at most one tenant per ID, so nothing has to stay running to remember it. Calls made with that tenant's token can only see and change that tenant: Namespace enforces the isolation.
- **Onboarding.** `add-customer` builds `image/Dockerfile` with the Devbox CLI inside the customer's tenant (it hands the CLI a tenant token through `NSC_TOKEN_FILE`), stores the Amp token in the tenant's Vault, and creates the `my-platform-devbox-agent` blueprint there. Rerun it after changing the Dockerfile or the blueprint to roll the change out.
- **Agents.** `devbox create` creates a devbox from the blueprint, starts `amp --no-tui --runner-id <devbox>` as the `amp-runner` service in `/workspace/project`, and, given a task, runs `amp -x "<task>" --executor runner:<devbox>` on the devbox, which prints the new thread's URL. You can also start threads on the runner from ampcode.com. The project is a git repository with an empty first commit, so Amp's Changes tab shows everything the agent writes.
- **In a real platform**, your backend would make these same calls when customers sign up, start an agent, or leave.
