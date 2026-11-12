/**
 * Gives two customers their own Namespace tenant and runs, on a Devbox inside
 * each, an Amp agent and a small web app. The web apps open through a local
 * proxy at http://localhost:4100; clicking "Destroy devbox and tenant" on a
 * page removes that customer's tenant, and once both are destroyed the program
 * cleans up and exits. Safe to rerun: it starts by removing anything a
 * previous run left behind.
 *
 *   cp .env.example .env   # Amp token and partner credentials
 *   npm start
 */
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { createDevboxClient } from "@namespacelabs/sdk";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";
import { createVaultClient } from "@namespacelabs/sdk/api/vault";
import { cachingTokenSource, type TokenSource } from "@namespacelabs/sdk/auth";

const platform = "my-platform-devbox";
const customers = ["customer-1", "customer-2"];
const platformLabel = { name: "app", value: platform };
const proxyPort = 4100;
const webPort = 3000;

const env = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name} in .env`);
	return value;
};

const retry = async <T>(log: (message: string) => void, step: () => Promise<T>): Promise<T> => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await step();
		} catch (error) {
			if (attempt === 5 || !/Premature close|connection is closed|ECONNRESET|socket hang up/i.test(String(error))) throw error;
			log(`connection to the devbox dropped (${error instanceof Error ? error.message : error}), retrying`);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #F6F7FC; color: #171C2B; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
	main { width: min(92vw, 480px); background: #fff; border: 1px solid #EAECF2; border-radius: 12px; padding: 40px; box-shadow: 0 1px 2px rgba(23, 28, 43, 0.04); }
	.brand { color: #60689F; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 24px; }
	h1 { font-size: 32px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 28px; }
	dl { margin: 0 0 32px; display: grid; gap: 16px; }
	dt { color: #8B91B9; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
	dd { margin: 0; font-family: "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; background: #F1F2F6; border-radius: 6px; padding: 10px 12px; }
	button { width: 100%; border: 0; border-radius: 9999px; padding: 14px 20px; background: #1C32FF; color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
	button:hover { background: #1426d6; }
	p { color: #60689F; margin: 0; }
</style>
</head>
<body><main><p class="brand">Namespace</p>${body}</main></body>
</html>`;

async function main() {
	const ampToken = env("AMP_API_KEY");
	const partnerKey = await readFile(env("NAMESPACE_PARTNER_KEY_FILE").replace(/^~(?=\/)/, homedir()));

	const partnerTokens: TokenSource = {
		async issueToken() {
			const now = Math.floor(Date.now() / 1000);
			const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
			const header = encode({ alg: "ES256", typ: "JWT", kid: env("NAMESPACE_PARTNER_KEY_ID") });
			const claims = encode({
				iss: env("NAMESPACE_PARTNER_ISSUER"),
				sub: env("NAMESPACE_PARTNER_ID"),
				aud: "namespace.so",
				iat: now,
				exp: now + 20 * 60,
			});
			const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: partnerKey, dsaEncoding: "ieee-p1363" });
			return `oidc_${header}.${claims}.${signature.toString("base64url")}`;
		},
	};
	const partner = createIAMClient({ tokenSource: partnerTokens });
	console.log("signed partner token");

	const removeTenants = async () => {
		const { tenants } = await partner.tenants.listTenants({ limit: 100 });
		const ours = tenants.filter((tenant) => tenant.labels.some((label) => label.name === platformLabel.name && label.value === platformLabel.value));
		for (const tenant of ours) {
			await partner.tenants.removeTenant({ tenantId: tenant.id });
			console.log(`removed tenant ${tenant.id} (${tenant.visibleName}) and everything in it`);
		}
		return ours.length;
	};

	if (!(await removeTenants())) console.log("nothing left over from a previous run");
	process.once("SIGINT", () => {
		console.log("interrupted, cleaning up");
		removeTenants().finally(() => process.exit(130));
	});

	const sites = new Map<string, { url: string; tenantTokens: TokenSource; destroy: () => Promise<void> }>();
	const proxy = createServer(async (request, response) => {
		const [, customerId, action] = (request.url ?? "/").split("/");
		const site = sites.get(customerId);
		if (!site) return response.writeHead(404).end(page("Not found", `<h1>Not found</h1><p>No running devbox for "${customerId}".</p>`));
		if (action === undefined) return response.writeHead(302, { location: `/${customerId}/` }).end();
		try {
			if (request.method === "POST" && action === "destroy") {
				await site.destroy();
				return response.writeHead(200, { "content-type": "text/html" }).end(page("Destroyed", `<h1>Destroyed</h1><p>The devbox and tenant for ${customerId} are gone.</p>`));
			}
			const upstream = await fetch(site.url, { headers: { "x-nsc-ingress-auth": `Bearer ${await site.tenantTokens.issueToken(60_000)}` } });
			response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/html" }).end(await upstream.text());
		} catch (error) {
			response.writeHead(502).end(String(error));
		}
	});
	await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
	console.log(`local proxy listening on http://localhost:${proxyPort}`);

	try {
		const run = Promise.all(
			customers.map(async (customerId) => {
				const log = (message: string) => console.log(`[${customerId}] ${message}`);

				const { tenant } = await partner.tenants.ensureTenantForExternalAccount({
					externalAccountId: `${platform}:${customerId}`,
					visibleName: customerId,
					labels: [platformLabel],
				});
				const tenantId = tenant!.id;
				log(`created tenant ${tenantId}`);

				const tenantTokens = cachingTokenSource({
					async issueToken() {
						const { bearerToken } = await partner.tenants.issueTenantToken({ tenantId, actorId: platform, durationSecs: 30n * 60n });
						return bearerToken;
					},
				});
				log("issued tenant token");

				const { vault } = createVaultClient({ tokenSource: tenantTokens });
				const { objectId: secretId } = await vault.createObject({ description: "Amp access token", value: ampToken, revealable: false, labels: [platformLabel] });
				log(`stored Amp token in Vault secret ${secretId}`);

				const client = createDevboxClient({ tokenSource: tenantTokens });
				let url: string;
				try {
					const blueprint = await client.blueprints.create(`${platform}-agent`, {
						image: "builtin:default",
						size: "m",
						environment: { AMP_API_KEY: { secretId } },
						networkPolicy: { allowedDomains: ["ampcode.com", "*.ampcode.com", "registry.npmjs.org"] },
					});
					log(`created blueprint ${blueprint.name}`);

					const devbox = await client.devboxes.create({ name: `${platform}-${customerId}`, blueprint: blueprint.name });
					log(`created devbox ${devbox.name} (${devbox.id}): ${devbox.info.state}`);

					const projectDir = `${devbox.info.workspaceDir}/project`;
					const webDir = `${devbox.info.workspaceDir}/web`;
					const install = await retry(log, () => devbox.shell(
						`curl -fsSL https://ampcode.com/install.sh | bash && sudo ln -sf ~/.amp/bin/amp /usr/local/bin/amp && mkdir -p ${projectDir} ${webDir} && git -C ${projectDir} init -q && git -C ${projectDir} -c user.name=${platform} -c user.email=${platform}@example.com commit -q --allow-empty -m "Empty project"`,
					));
					if (install.exitCode !== 0) throw new Error(`installing Amp failed: ${install.stderr || install.stdout}`);
					log(`installed Amp and created ${projectDir}`);

					await retry(log, () => devbox.fs.writeFile(
						`${webDir}/index.html`,
						page(
							`Hello from ${customerId}`,
							`<h1>Hello from ${customerId}</h1>
<dl><div><dt>Tenant ID</dt><dd>${tenantId}</dd></div><div><dt>Devbox ID</dt><dd>${devbox.id}</dd></div></dl>
<form method="post" action="destroy"><button type="submit">Destroy devbox and tenant</button></form>`,
						),
					));
					await retry(log, () => devbox.services
						.create({
							name: "web",
							command: "node",
							args: ["-e", `require("http").createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(require("fs").readFileSync("index.html")); }).listen(${webPort})`],
							cwd: webDir,
							restartPolicy: "always",
						})
						.catch(() => devbox.services.get("web")));
					const port = await retry(log, () => devbox.exposedPorts
						.create({ name: "web", number: webPort })
						.catch(() => devbox.exposedPorts.get({ number: webPort })));
					url = port.url;
					log(`started service web and exposed it at ${url}`);

					const service = await retry(log, () => devbox.services
						.create({ name: "amp-runner", command: "amp", args: ["--no-tui", "--runner-id", devbox.name], cwd: projectDir })
						.catch(() => devbox.services.get("amp-runner")));
					log(`started service ${service.name}: ${service.process?.state}`);

					const task = `Create hello.js that prints "Hello from ${customerId}", run it with node, and commit it.`;
					const deadline = Date.now() + 3 * 60_000;
					let events: { type: string; session_id?: string; result?: string; is_error?: boolean }[] = [];
					while (!events.some((event) => event.type === "result")) {
						const result = await devbox
							.exec(["amp", "-x", task, "--executor", `runner:${devbox.name}`, "--stream-json"], { cwd: projectDir })
							.catch(() => undefined);
						if (result?.exitCode === 0) {
							events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
						} else if (result && !result.stderr.includes("No connected runner")) {
							throw new Error(`amp -x failed: ${result.stderr}`);
						} else if (Date.now() > deadline) {
							throw new Error("the Amp runner did not connect within 3 minutes");
						} else {
							await new Promise((resolve) => setTimeout(resolve, 3_000));
						}
					}
					const outcome = events.find((event) => event.type === "result")!;
					log(`agent finished (${outcome.is_error ? "error" : "success"}): https://ampcode.com/threads/${outcome.session_id}`);

					const output = await retry(log, () => devbox.exec(["node", "hello.js"], { cwd: projectDir }));
					log(`node hello.js -> ${output.stdout.trim() || output.stderr.trim()}`);
				} finally {
					client.close();
				}

				await new Promise<void>((resolve) => {
					sites.set(customerId, {
						url,
						tenantTokens,
						destroy: async () => {
							sites.delete(customerId);
							await partner.tenants.removeTenant({ tenantId });
							log(`destroy clicked: removed tenant ${tenantId} and its devbox`);
							resolve();
						},
					});
					log(`open http://localhost:${proxyPort}/${customerId}/`);
				});
			}),
		);
		await Promise.race([
			run.then(() => console.log("both devboxes and tenants destroyed")),
			new Promise((resolve) => setTimeout(resolve, 30 * 60_000).unref()).then(() => console.log("no clicks for 30 minutes")),
		]);
	} finally {
		proxy.close();
		proxy.closeAllConnections();
		await removeTenants();
		console.log("cleaned up");
	}
}

main().catch((error) => {
	console.error("failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
