# my-platform-devbox

Gives two customers their own [Namespace](https://namespace.so) tenant, runs an [Amp](https://ampcode.com) agent for each on a Devbox inside it, and deletes everything when the agents finish. Built with the [Namespace TypeScript SDK](https://github.com/namespacelabs/typescript-sdk).

```bash
npm install
cp .env.example .env   # Amp token and partner credentials
npm start
```

[`src/multitenant-agent.ts`](src/multitenant-agent.ts) runs these steps and logs each one:

1. Signs a partner token with your partner key.
2. Removes any tenants a previous run left behind, so every run starts clean.
3. For `acme` and `globex`, in parallel:
   1. Creates the customer's tenant and issues a tenant token for it.
   2. Stores the Amp token in the tenant's Vault.
   3. Creates a blueprint in the tenant: built-in image, the Amp token from the Vault, and a network policy that allows Amp and npm.
   4. Creates a Devbox from the blueprint.
   5. Installs the Amp CLI on it with `devbox.exec` and creates an empty git project.
   6. Starts `amp --no-tui` as the `amp-runner` service.
   7. Sends the agent a task, waits for it to finish, and prints the Amp thread URL and the result.
4. Removes both tenants and everything in them.

Tenants, Vault secrets, blueprints, and Devboxes all belong to one tenant, so each customer gets their own copy and can't see the other's.

Partner credentials are issued by the Namespace team today ([support@namespace.so](mailto:support@namespace.so)); this may change once partner access is self-service. Both customers' agents use your Amp token here; a real platform would store each customer's own.
