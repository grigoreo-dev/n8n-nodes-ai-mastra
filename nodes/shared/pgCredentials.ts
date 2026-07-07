import { createHash } from 'node:crypto';

/**
 * Fields we read off n8n's native `postgres` credential. We deliberately read
 * the credential directly and build our own `pg.Pool` instead of importing
 * `configurePostgres` from `n8n-nodes-base/dist/...` — that is an internal deep
 * import with no stability guarantee across n8n versions, and it routes through
 * `pg-promise` + n8n's own ConnectionPoolManager, which we do not want because
 * Mastra's PostgresStore wants a raw `pg.Pool` under OUR lifecycle control.
 */
export interface PostgresCredential {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	/** 'disable' | 'allow' | 'require' — mirrors the native credential's SSL dropdown. */
	ssl?: string;
	/** "Ignore SSL Issues (Insecure)" on the native credential. */
	allowUnauthorizedCerts?: boolean;
	/** Native credential caps this at the DB's max_connections; we cap our pool separately. */
	maxConnections?: number;
	/** SSH tunnelling is NOT supported by this node (see README). Present so we can detect + reject. */
	sshTunnel?: boolean;
}

export interface PoolSslConfig {
	rejectUnauthorized: boolean;
}

/**
 * Translate the native credential's SSL fields into a `pg` pool `ssl` option.
 * Returns `false` when SSL is disabled (the credential default), matching the
 * behaviour of the stock Postgres node's `getPostgresConfig`.
 */
export function resolveSsl(cred: PostgresCredential): PoolSslConfig | boolean {
	if (cred.allowUnauthorizedCerts === true) {
		return { rejectUnauthorized: false };
	}
	const mode = cred.ssl ?? 'disable';
	return mode !== 'disable';
}

/**
 * Stable pool key: identifies a unique connection target. Same host+port+db+user
 * +schema (+ssl posture) → one shared pool. Password is hashed in (not stored)
 * so a credential rotation forces a new pool rather than silently reusing a pool
 * authenticated with stale creds. Schema is part of the key because Mastra
 * scopes tables per schema.
 */
export function poolKey(cred: PostgresCredential, schema: string): string {
	const ssl = resolveSsl(cred);
	const material = JSON.stringify({
		host: cred.host,
		port: cred.port,
		database: cred.database,
		user: cred.user,
		// hash the password so it never sits in a Map key in memory as plaintext
		pw: createHash('sha256').update(cred.password ?? '').digest('hex'),
		schema,
		ssl,
	});
	return createHash('sha256').update(material).digest('hex');
}
