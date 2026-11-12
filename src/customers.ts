/**
 * Onboards and offboards your platform's customers.
 *
 *   npm run add-customer -- acme      # tenant, image, Amp token, blueprint
 *   npm run remove-customer -- acme   # deletes the tenant and everything in it
 *
 * Rerun add-customer after changing image/Dockerfile or the blueprint below to
 * roll the change out to that customer.
 */
import { createDevboxClient, type BlueprintDefinition } from "@namespacelabs/sdk";
import { createVaultClient } from "@namespacelabs/sdk/api/vault";
import type { TokenSource } from "@namespacelabs/sdk/auth";
import { blueprintName, customer, devboxCli, imageName, multiTenant, platformName, removeCustomer } from "./platform.js";

async function addCustomer(customerId: string) {
	const ampToken = process.env.AMP_API_KEY;
	if (!ampToken) throw new Error("set AMP_API_KEY in .env to your Amp access token");

	const { tenantId, tokenSource } = await customer(customerId);
	console.log(`customer ${customerId}: tenant ${tenantId}`);

	// Images live in each tenant's own registry, so build one per customer
	// from the same Dockerfile.
	console.log(`building image ${imageName}...`);
	await devboxCli(tokenSource, ["image", "build", "image", "--name", imageName, "--workspace_dir", "/workspace"]);

	const secretId = await storeAmpToken(tokenSource, ampToken);

	const definition: BlueprintDefinition = {
		image: imageName,
		size: "m",
		description: "An Amp agent and an empty project",
		// The devbox resolves the secret when a process starts, so the token
		// never appears in the blueprint.
		environment: { AMP_API_KEY: { secretId } },
		// Amp talks to ampcode.com (and static.ampcode.com for updates); npm
		// lets the agent install packages for what it builds.
		networkPolicy: { allowedDomains: ["ampcode.com", "*.ampcode.com", "registry.npmjs.org"] },
		// A tmux session started on every boot, for poking around by hand.
		sessions: [{ name: "shell", command: "cd /workspace/project && exec bash -l" }],
	};
	const devboxes = createDevboxClient({ tokenSource });
	try {
		let exists = false;
		for await (const blueprint of devboxes.blueprints.iterate()) {
			if (blueprint.name === blueprintName) exists = true;
		}
		const blueprint = exists
			? await devboxes.blueprints.update(blueprintName, definition)
			: await devboxes.blueprints.create(blueprintName, definition);
		console.log(`${exists ? "updated" : "created"} blueprint ${blueprint.name} (version ${blueprint.version})`);
	} finally {
		devboxes.close();
	}
	console.log(`ready: npm run devbox -- create ${customerId} "<task>"`);
}

// Stores the token in the customer's Vault, or adds a new version on reruns.
// Not revealable: devboxes resolve it, but nobody can read it back.
//
// This template gives every customer your platform's Amp token, so their
// threads run on your Amp account. A real platform would store each
// customer's own token here.
async function storeAmpToken(tokenSource: TokenSource, ampToken: string) {
	const { vault } = createVaultClient({ tokenSource });
	const { objects } = await vault.listObjects({});
	const existing = objects.find((object) => object.labels.some((label) => label.name === "app" && label.value === platformName));
	if (existing) {
		await vault.updateObject({ objectId: existing.objectId, newValue: ampToken });
		console.log(`updated Vault secret ${existing.objectId}`);
		return existing.objectId;
	}
	const created = await vault.createObject({
		description: "Amp access token",
		value: ampToken,
		revealable: false,
		labels: [{ name: "app", value: platformName }],
	});
	console.log(`created Vault secret ${created.objectId}`);
	return created.objectId;
}

async function main() {
	const [command, customerId] = process.argv.slice(2);
	if (command === "add" && customerId) return addCustomer(customerId);
	if (command === "remove" && customerId) {
		if (!multiTenant) throw new Error("remove needs partner credentials: without them there are no tenants to remove");
		console.log(`removed ${await removeCustomer(customerId)} tenant(s) for ${customerId}`);
		return;
	}
	throw new Error("usage: customers.ts add|remove <customer-id>");
}

main().catch((error) => {
	console.error("failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
