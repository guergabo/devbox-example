/**
 * One-time setup: creates (or updates) the "agent-arena" blueprint that every
 * arena devbox starts from.
 *
 * Build the image first (the SDK can register and optimize images, but not
 * build them):
 *
 *   devbox image build . --name arena-runner -f image/Dockerfile --workspace_dir /workspace
 *
 * Then run:
 *
 *   ANTHROPIC_SECRET_ID=sec_... npx tsx src/setup.ts
 *
 * ANTHROPIC_SECRET_ID is the Namespace Vault secret holding an Anthropic API
 * key (`nsc vault list` shows IDs). CLAUDE_OAUTH_SECRET_ID can instead point
 * at a Claude subscription token from `claude setup-token`. With neither, the
 * arena runs the scripted "demo" agent.
 */
import { createDevboxClient, type EnvironmentVariables } from "@namespacelabs/sdk";

// Image names containing "/" are treated as full image references, so the
// image is named "arena-runner" rather than "arena/runner".
const imageName = "arena-runner";
const blueprintName = "agent-arena";

async function main() {
	const client = createDevboxClient();

	try {
		await client.images.get({ name: imageName }).catch(() => {
			throw new Error(
				`image "${imageName}" not found; build it first with ` +
				`devbox image build . --name ${imageName} -f image/Dockerfile --workspace_dir /workspace`,
			);
		});

		// Secrets stay in the Vault: the devbox resolves them when a process
		// starts, so the key never passes through this script.
		const environment: EnvironmentVariables = {};
		if (process.env.ANTHROPIC_SECRET_ID) {
			environment.ANTHROPIC_API_KEY = { secretId: process.env.ANTHROPIC_SECRET_ID };
		}
		if (process.env.CLAUDE_OAUTH_SECRET_ID) {
			environment.CLAUDE_CODE_OAUTH_TOKEN = { secretId: process.env.CLAUDE_OAUTH_SECRET_ID };
		}

		const definition = {
			image: imageName,
			size: "m",
			description: "Agent Arena contestant: Claude Code and a sample app",
			environment,
			// Contestants run agents without permission prompts, so the devbox
			// itself limits what they can reach: the Anthropic API (and its
			// sign-in check) and npm.
			networkPolicy: {
				allowedDomains: [
					"api.anthropic.com",
					"platform.claude.com",
					"claude.ai",
					"registry.npmjs.org",
				],
			},
			// A tmux session started on every boot. arena-agent waits for the
			// task, then runs the agent where you can attach and watch.
			sessions: [{ name: "agent", command: "arena-agent" }],
		};

		let exists = false;
		for await (const blueprint of client.blueprints.iterate()) {
			if (blueprint.name === blueprintName) exists = true;
		}

		const blueprint = exists
			? await client.blueprints.update(blueprintName, definition)
			: await client.blueprints.create(blueprintName, definition);
		console.log(`${exists ? "updated" : "created"} blueprint ${blueprint.name} (version ${blueprint.version})`);
		console.log(
			Object.keys(environment).length
				? `agent credentials: ${Object.keys(environment).join(", ")}`
				: "no agent credentials configured: arena devboxes will run the demo agent",
		);
	} finally {
		client.close();
	}
}

main().catch((error) => {
	console.error("setup failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
