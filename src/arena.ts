/**
 * Agent Arena: give one task to N devboxes in parallel, each running a coding
 * agent on the same sample app with its own live preview URL.
 *
 *   npx tsx src/arena.ts run 3 "Add a dark mode toggle"
 *   npx tsx src/arena.ts run 3 --agent demo "Add a dark mode toggle"
 *   npx tsx src/arena.ts status
 *   npx tsx src/arena.ts cleanup
 *
 * Run src/setup.ts once first. `--agent` picks the agent (claude or demo);
 * without it, each devbox uses claude when the blueprint has credentials and
 * demo otherwise.
 */
import { createDevboxClient, type Devbox, type DevboxClient } from "@namespacelabs/sdk";

const blueprintName = "agent-arena";
const appDir = "/workspace/app";
const previewPort = 5173;
// Every arena devbox carries this label, so status and cleanup can find them.
const label = { name: "example", value: "agent-arena" };

async function run(client: DevboxClient, args: string[]) {
	let agent: string | undefined;
	const agentFlag = args.indexOf("--agent");
	if (agentFlag !== -1) [, agent] = args.splice(agentFlag, 2);
	const [count, ...words] = args;
	const contestants = Number(count);
	const task = words.join(" ");
	if (!Number.isInteger(contestants) || contestants < 1 || !task) {
		throw new Error('usage: arena.ts run <count> [--agent claude|demo] "<task>"');
	}

	const runId = Date.now().toString(36);
	console.log(`starting ${contestants} devboxes from blueprint ${blueprintName}...`);

	const results = await Promise.all(
		Array.from({ length: contestants }, async (_, i) => {
			// The blueprint fixes the image, size, network policy, and the
			// "agent" session; devboxes created from it cannot override them.
			const devbox = await client.devboxes.create({
				name: `arena-${runId}-${i + 1}`,
				blueprint: blueprintName,
				labels: { [label.name]: label.value },
			});

			// The agent session is already waiting for TASK.md. Write the
			// agent choice first, since the session reads it once the task lands.
			if (agent) await devbox.fs.writeFile("/workspace/AGENT", `${agent}\n`);
			await devbox.fs.writeFile("/workspace/TASK.md", `${task}\n`);

			// A supervised dev server: it restarts if it crashes and starts
			// again whenever the devbox boots. Vite reloads the page as the
			// agent edits files.
			await devbox.services.create({
				name: "preview",
				command: "npm",
				args: ["run", "dev"],
				cwd: appDir,
				environment: { ARENA_PREVIEW: "1" },
				restartPolicy: "always",
			});
			const port = await devbox.exposedPorts.create({ name: "preview", number: previewPort });

			return { devbox: devbox.name, preview: port.url, attach: attachCommand(devbox) };
		}),
	);

	console.table(results);
	console.log("Check tests with `npx tsx src/arena.ts status`; delete everything with `npx tsx src/arena.ts cleanup`.");
}

async function status(client: DevboxClient) {
	const devboxes = await arenaDevboxes(client);
	if (!devboxes.length) return console.log("no arena devboxes; start some with `arena.ts run`");

	const rows = await Promise.all(
		devboxes.map(async (devbox) => {
			const [tests, changes, port] = await Promise.all([
				devbox.exec(["npm", "test"], { cwd: appDir }),
				devbox.exec(["git", "status", "--porcelain"], { cwd: appDir }),
				devbox.exposedPorts.get({ name: "preview" }).catch(() => undefined),
			]);
			return {
				devbox: devbox.name,
				tests: tests.exitCode === 0 ? "pass" : "FAIL",
				"changed files": changes.stdout.split("\n").filter(Boolean).length,
				preview: port?.url ?? "-",
				attach: attachCommand(devbox),
			};
		}),
	);
	console.table(rows);
}

async function cleanup(client: DevboxClient) {
	const devboxes = await arenaDevboxes(client);
	await Promise.all(devboxes.map((devbox) => devbox.delete()));
	console.log(`deleted ${devboxes.length} arena devboxes`);
}

async function arenaDevboxes(client: DevboxClient): Promise<Devbox[]> {
	const devboxes: Devbox[] = [];
	for await (const devbox of client.devboxes.iterate({ labelFilters: [label] })) devboxes.push(devbox);
	return devboxes.sort((a, b) => a.name.localeCompare(b.name));
}

function attachCommand(devbox: Devbox) {
	return `devbox session connect ${devbox.name} --session agent`;
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const client = createDevboxClient();
	try {
		if (command === "run") await run(client, args);
		else if (command === "status") await status(client);
		else if (command === "cleanup") await cleanup(client);
		else throw new Error("usage: arena.ts run|status|cleanup");
	} finally {
		client.close();
	}
}

main().catch((error) => {
	console.error("arena failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
