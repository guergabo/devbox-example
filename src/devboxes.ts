/**
 * Runs Amp agents on devboxes in a customer's tenant.
 *
 *   npm run devbox -- create acme ["Build a to-do app with Vite"]
 *   npm run devbox -- list acme
 *   npm run devbox -- delete acme [<devbox>]
 *
 * Run `npm run add-customer -- acme` once first.
 */
import { createDevboxClient, type Devbox, type DevboxClient } from "@namespacelabs/sdk";
import { blueprintName, customer, platformName } from "./platform.js";

const projectDir = "/workspace/project";
// Every devbox this platform creates carries these labels, so list and delete
// can find a customer's devboxes (in your own workspace too, without tenants).
const labels = (customerId: string) => ({ app: platformName, customer: customerId });

async function create(client: DevboxClient, customerId: string, task?: string) {
	// The blueprint fixes the image, size, Amp token, and network policy. The
	// name doubles as the Amp runner ID, which must be a valid hostname and
	// unique across all your customers.
	const devbox = await client.devboxes.create({
		name: `${customerId}-${Date.now().toString(36)}`,
		blueprint: blueprintName,
		labels: labels(customerId),
	});
	console.log(`created devbox ${devbox.name}`);

	// A supervised Amp runner: it starts again whenever the devbox boots and
	// restarts if it fails. Threads started on it run in the project.
	await devbox.services
		.create({
			name: "amp-runner",
			command: "amp",
			args: ["--no-tui", "--runner-id", devbox.name],
			cwd: projectDir,
		})
		// A just-booted devbox can drop the connection after saving the
		// service; carry on if the service exists.
		.catch((error) => devbox.services.get("amp-runner").catch(() => Promise.reject(error)));
	console.log(`started amp-runner: start threads on runner "${devbox.name}" from ampcode.com`);

	if (task) console.log(`Amp thread: ${await sendTask(devbox, task)}`);
}

// Starts an Amp thread on the devbox's runner. The Amp CLI on the devbox
// creates it, so this machine needs no Amp CLI. `amp -x` with a runner
// executor prints the thread URL and exits while the agent works.
async function sendTask(devbox: Devbox, task: string): Promise<string> {
	const deadline = Date.now() + 3 * 60_000;
	for (;;) {
		let failure = "";
		const result = await devbox
			.exec(["amp", "-x", task, "--executor", `runner:${devbox.name}`], { cwd: projectDir })
			// Connections to a just-booted devbox can drop; retry those.
			.catch((error) => void (failure = String(error)));
		if (result) {
			const url = result.stdout.match(/https:\/\/\S+\/threads\/T-[\w-]+/)?.[0];
			if (result.exitCode === 0 && url) return url;
			failure = result.stderr.trim() || result.stdout.trim();
			// Until the runner registers, amp fails fast without creating a thread.
			if (!failure.includes("No connected runner")) throw new Error(`${devbox.name}: amp -x failed: ${failure}`);
		}
		if (Date.now() > deadline) throw new Error(`${devbox.name}: gave up sending the task: ${failure}`);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
}

async function list(client: DevboxClient, customerId: string) {
	const devboxes = await customerDevboxes(client, customerId);
	if (!devboxes.length) return console.log("no devboxes; start one with `npm run devbox -- create <customer>`");

	const rows = await Promise.all(
		devboxes.map(async (devbox) => {
			const [runner, changes] = await Promise.all([
				devbox.services.get("amp-runner").catch(() => undefined),
				devbox.exec(["git", "status", "--porcelain"], { cwd: projectDir }),
			]);
			return {
				devbox: devbox.name,
				"amp-runner": runner?.process?.state ?? "missing",
				"changed files": changes.stdout.split("\n").filter(Boolean).length,
			};
		}),
	);
	console.table(rows);
}

async function remove(client: DevboxClient, customerId: string, name?: string) {
	const devboxes = (await customerDevboxes(client, customerId)).filter((devbox) => !name || devbox.name === name);
	await Promise.all(devboxes.map((devbox) => devbox.delete()));
	console.log(`deleted ${devboxes.length} devbox(es)`);
}

async function customerDevboxes(client: DevboxClient, customerId: string): Promise<Devbox[]> {
	const labelFilters = Object.entries(labels(customerId)).map(([name, value]) => ({ name, value }));
	const devboxes: Devbox[] = [];
	for await (const devbox of client.devboxes.iterate({ labelFilters })) devboxes.push(devbox);
	return devboxes.sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
	const [command, customerId, arg] = process.argv.slice(2);
	if (!command || !customerId) throw new Error("usage: devboxes.ts create|list|delete <customer-id> [...]");

	// Every call below acts inside this customer's tenant only.
	const { tokenSource } = await customer(customerId);
	const client = createDevboxClient({ tokenSource });
	try {
		if (command === "create") await create(client, customerId, arg);
		else if (command === "list") await list(client, customerId);
		else if (command === "delete") await remove(client, customerId, arg);
		else throw new Error("usage: devboxes.ts create|list|delete <customer-id> [...]");
	} finally {
		client.close();
	}
}

main().catch((error) => {
	console.error("failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
