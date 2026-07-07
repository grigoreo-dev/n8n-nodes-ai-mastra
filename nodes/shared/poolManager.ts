import { Pool, type PoolConfig } from 'pg';

import { poolKey, resolveSsl, type PostgresCredential } from './pgCredentials';

/**
 * Singleton pg.Pool manager (locked design, Findings 2 & 4).
 *
 * Why this exists: Mastra's PostgresStore accepts a pre-configured `pg.Pool` and
 * will NOT close a pool it did not create. n8n calls `supplyData` once per item,
 * and a memory sub-node can be executed by many workflow runs over a long Dokploy
 * uptime. Creating a pool per call would leak connections until Postgres refuses
 * new ones. So we keep ONE pool per connection target (keyed by host+port+db+
 * user+schema+ssl+password-hash), reference-count borrowers, and idle-evict pools
 * that nobody is using so a credential change doesn't strand an old pool forever.
 *
 * The manager is a module-level singleton so every node instance in the same
 * Node.js worker shares it — mirroring how the stock Postgres node shares one
 * ConnectionPoolManager per process.
 */

interface PoolEntry {
	pool: Pool;
	/** How many live borrowers currently hold this pool (incremented on acquire, decremented on release). */
	refCount: number;
	/** Timestamp (ms) when refCount last dropped to 0. Used by the idle sweeper. */
	idleSince: number | null;
	/** Set once we start ending the pool so late releases don't double-end. */
	ending: boolean;
}

/** Close a pool that has had zero borrowers for at least this long. */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** How often the sweeper checks for idle pools. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
/** Our conservative default pool cap (Finding 6) — safe for shared PG on Dokploy. */
export const DEFAULT_MAX_CONNECTIONS = 5;

export class PgPoolManager {
	private readonly pools = new Map<string, PoolEntry>();
	private sweeper: NodeJS.Timeout | null = null;

	constructor(
		private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
		private readonly sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
	) {}

	/**
	 * Get (or lazily create) the shared pool for a credential + schema, and
	 * increment its ref count. Callers MUST call the returned `release()` exactly
	 * once when done (n8n's `closeFunction` is the natural place).
	 */
	acquire(
		cred: PostgresCredential,
		schema: string,
		maxConnections: number = DEFAULT_MAX_CONNECTIONS,
	): { pool: Pool; key: string; release: () => void } {
		const key = poolKey(cred, schema);
		let entry = this.pools.get(key);

		if (entry && entry.ending) {
			// A pool by this key is mid-teardown; drop it and build a fresh one.
			this.pools.delete(key);
			entry = undefined;
		}

		if (!entry) {
			entry = {
				pool: new Pool(this.buildPoolConfig(cred, maxConnections)),
				refCount: 0,
				idleSince: null,
				ending: false,
			};
			// A pool with no error handler crashes the whole worker on a backend
			// disconnect. Swallow-and-log at the pool level; per-query errors still
			// surface to the caller.
			entry.pool.on('error', () => {
				// Intentionally quiet: transient idle-client errors are expected on
				// long-lived pools. Real query failures reject their own promise.
			});
			this.pools.set(key, entry);
		}

		entry.refCount += 1;
		entry.idleSince = null;
		this.ensureSweeper();

		let released = false;
		const release = () => {
			if (released) return; // idempotent — double release must not underflow
			released = true;
			this.release(key);
		};

		return { pool: entry.pool, key, release };
	}

	private release(key: string): void {
		const entry = this.pools.get(key);
		if (!entry) return;
		entry.refCount = Math.max(0, entry.refCount - 1);
		if (entry.refCount === 0) {
			entry.idleSince = Date.now();
		}
	}

	private buildPoolConfig(cred: PostgresCredential, maxConnections: number): PoolConfig {
		return {
			host: cred.host,
			port: cred.port,
			database: cred.database,
			user: cred.user,
			password: cred.password,
			ssl: resolveSsl(cred),
			max: maxConnections,
			// Keep TCP alive so idle pooled clients survive NAT/proxy timeouts on Dokploy.
			keepAlive: true,
		};
	}

	private ensureSweeper(): void {
		if (this.sweeper) return;
		this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
		// Never keep the Node process alive just for the sweeper.
		if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
	}

	/** Close pools that have been idle (refCount 0) longer than the TTL. */
	sweep(now: number = Date.now()): void {
		for (const [key, entry] of this.pools) {
			if (entry.ending) continue;
			if (entry.refCount > 0 || entry.idleSince === null) continue;
			if (now - entry.idleSince >= this.idleTtlMs) {
				this.evict(key, entry);
			}
		}
		if (this.pools.size === 0 && this.sweeper) {
			clearInterval(this.sweeper);
			this.sweeper = null;
		}
	}

	private evict(key: string, entry: PoolEntry): void {
		entry.ending = true;
		this.pools.delete(key);
		// Fire-and-forget: end() drains the pool. Errors here are non-fatal.
		void entry.pool.end().catch(() => {});
	}

	/** Test/observability helper: current tracked pool count. */
	get size(): number {
		return this.pools.size;
	}

	/** Test/observability helper: ref count for a given key (0 if unknown). */
	refCountFor(key: string): number {
		return this.pools.get(key)?.refCount ?? 0;
	}

	/** Close every pool immediately. Used for graceful shutdown / tests. */
	async closeAll(): Promise<void> {
		const entries = [...this.pools.values()];
		this.pools.clear();
		if (this.sweeper) {
			clearInterval(this.sweeper);
			this.sweeper = null;
		}
		await Promise.all(
			entries.map((e) => {
				e.ending = true;
				return e.pool.end().catch(() => {});
			}),
		);
	}
}

/**
 * Process-wide singleton. Every node in this worker shares it, so two memory
 * sub-nodes pointing at the same DB reuse one pool.
 */
export const pgPoolManager = new PgPoolManager();
