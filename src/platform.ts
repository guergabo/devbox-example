/**
 * Your platform's Namespace identity.
 *
 * Each of your customers gets their own Namespace tenant. `customer(id)`
 * finds or creates that tenant and returns a token source that acts only
 * inside it: everything created with it belongs to that customer and is
 * invisible to every other customer.
 *
 * Partner credentials (NAMESPACE_PARTNER_* in .env) let your platform manage
 * tenants. Today the Namespace team issues them (support@namespace.so); this
 * step may change once partner access is self-service. Without them, every
 * command runs in your own workspace (your `devbox login`), with no tenants.
 */
import { spawn } from "node:child_process";
import { sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";
import { cachingTokenSource, loadDefaults, type TokenSource } from "@namespacelabs/sdk/auth";

// Names every resource this platform creates.
export const platformName = "my-platform-devbox";
// Image names containing "/" are treated as full image references by the SDK.
export const imageName = `${platformName}-agent`;
export const blueprintName = `${platformName}-agent`;

const { NAMESPACE_PARTNER_ID, NAMESPACE_PARTNER_ISSUER, NAMESPACE_PARTNER_KEY_ID, NAMESPACE_PARTNER_KEY_FILE } = process.env;
export const multiTenant = Boolean(NAMESPACE_PARTNER_ID);

// A short-lived ES256 JWT signed with your partner key. The private key never
// leaves this machine; Namespace verifies it with your registered public key.
const partnerTokens: TokenSource = {
	async issueToken() {
		const key = await readFile(NAMESPACE_PARTNER_KEY_FILE!.replace(/^~(?=\/)/, homedir()));
		const now = Math.floor(Date.now() / 1000);
		const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const header = encode({ alg: "ES256", typ: "JWT", kid: NAMESPACE_PARTNER_KEY_ID });
		const claims = encode({ iss: NAMESPACE_PARTNER_ISSUER, sub: NAMESPACE_PARTNER_ID, aud: "namespace.so", iat: now, exp: now + 20 * 60 });
		const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
		return `oidc_${header}.${claims}.${signature.toString("base64url")}`;
	},
};

const partner = createIAMClient({ tokenSource: partnerTokens });

/**
 * Finds or creates a customer's tenant. Namespace stores the mapping: there is
 * at most one tenant per external account ID, so this returns the same tenant
 * every time.
 */
export async function customer(customerId: string): Promise<{ tenantId: string; tokenSource: TokenSource }> {
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(customerId)) {
		throw new Error(`customer ID "${customerId}" must be lowercase letters, digits, and hyphens`);
	}
	if (!multiTenant) return { tenantId: "your workspace", tokenSource: await loadDefaults() };

	const { tenant } = await partner.tenants.ensureTenantForExternalAccount({
		externalAccountId: `${platformName}:${customerId}`,
		visibleName: customerId,
		labels: [{ name: "app", value: platformName }],
	});
	const tenantId = tenant!.id;

	// Tenant tokens last minutes; the SDK asks for a new one before it expires.
	const tokenSource = cachingTokenSource({
		async issueToken() {
			const { bearerToken } = await partner.tenants.issueTenantToken({ tenantId, actorId: platformName, durationSecs: 30n * 60n });
			return bearerToken;
		},
	});
	return { tenantId, tokenSource };
}

/** Deletes a customer's tenant and everything in it. Irreversible. */
export async function removeCustomer(customerId: string) {
	const { tenants } = await partner.tenants.listTenants({ externalAccountId: `${platformName}:${customerId}` });
	for (const tenant of tenants) await partner.tenants.removeTenant({ tenantId: tenant.id });
	return tenants.length;
}

/**
 * Runs the devbox CLI inside a customer's tenant: it reads a tenant token from
 * the file NSC_TOKEN_FILE names, valid for at least 25 minutes.
 */
export async function devboxCli(tokenSource: TokenSource, args: string[]) {
	const dir = await mkdtemp(join(tmpdir(), `${platformName}-`));
	try {
		let env = process.env;
		if (multiTenant) {
			const tokenFile = join(dir, "token.json");
			await writeFile(tokenFile, JSON.stringify({ bearer_token: await tokenSource.issueToken(25 * 60_000) }), { mode: 0o600 });
			env = { ...env, NSC_TOKEN_FILE: tokenFile };
		}
		const code = await new Promise<number | null>((resolve, reject) => {
			spawn("devbox", args, { stdio: "inherit", env }).on("error", reject).on("exit", resolve);
		});
		if (code !== 0) throw new Error(`devbox ${args[0]} exited with code ${code}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
