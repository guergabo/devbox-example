/**
 * Gives two customers their own Namespace tenant, runs an Amp agent for each
 * on a Devbox inside it, waits for both agents to finish, and deletes
 * everything it created. Safe to rerun: it starts by removing anything a
 * previous run left behind.
 *
 *   cp .env.example .env   # Amp token and partner credentials
 *   npm start
 */
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createDevboxClient } from "@namespacelabs/sdk";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";
import { createVaultClient } from "@namespacelabs/sdk/api/vault";
import { cachingTokenSource, type TokenSource } from "@namespacelabs/sdk/auth";

const platform = "my-platform-devbox";
const customers = ["acme", "globex"];
const platformLabel = { name: "app", value: platform };

const env = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name} in .env`);
	return value;
};

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

	try {
		await Promise.all(
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
				try {
					const blueprint = await client.blueprints.create(`${platform}-agent`, {
						image: "builtin:default",
						size: "m",
						environment: { AMP_API_KEY: { secretId } },
						networkPolicy: { allowedDomains: ["ampcode.com", "*.ampcode.com", "registry.npmjs.org"] },
					});
					log(`created blueprint ${blueprint.name}`);

					const devbox = await client.devboxes.create({ name: `${platform}-${customerId}`, blueprint: blueprint.name });
					log(`created devbox ${devbox.name}: ${devbox.info.state}`);

					const projectDir = `${devbox.info.workspaceDir}/project`;
					const install = await devbox.shell(
						`curl -fsSL https://ampcode.com/install.sh | bash && sudo ln -sf ~/.amp/bin/amp /usr/local/bin/amp && mkdir -p ${projectDir} && git -C ${projectDir} init -q && git -C ${projectDir} -c user.name=${platform} -c user.email=${platform}@example.com commit -q --allow-empty -m "Empty project"`,
					);
					if (install.exitCode !== 0) throw new Error(`installing Amp failed: ${install.stderr || install.stdout}`);
					log(`installed Amp and created ${projectDir}`);

					const service = await devbox.services
						.create({ name: "amp-runner", command: "amp", args: ["--no-tui", "--runner-id", devbox.name], cwd: projectDir })
						.catch((error) => devbox.services.get("amp-runner").catch(() => Promise.reject(error)));
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
					log(`agent said: ${outcome.result?.trim().split("\n")[0]}`);

					const output = await devbox.exec(["node", "hello.js"], { cwd: projectDir });
					log(`node hello.js -> ${output.stdout.trim() || output.stderr.trim()}`);
				} finally {
					client.close();
				}
			}),
		);
	} finally {
		await removeTenants();
	}
}

main().catch((error) => {
	console.error("failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
