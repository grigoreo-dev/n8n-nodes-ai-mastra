import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `pg` so `new Pool()` never opens a real connection. Each Pool instance
// records whether end() was called so we can assert eviction behaviour.
const createdPools: Array<{ ended: boolean; config: unknown }> = [];

vi.mock('pg', () => {
	class FakePool {
		ended = false;
		constructor(public config: unknown) {
			createdPools.push(this);
		}
		on() {
			return this;
		}
		async end() {
			this.ended = true;
		}
	}
	return { Pool: FakePool };
});

import { PgPoolManager } from '../nodes/shared/poolManager';
import type { PostgresCredential } from '../nodes/shared/pgCredentials';

const cred = (over: Partial<PostgresCredential> = {}): PostgresCredential => ({
	host: 'db.internal',
	port: 5432,
	database: 'app',
	user: 'app',
	password: 'secret',
	ssl: 'disable',
	...over,
});

describe('PgPoolManager', () => {
	beforeEach(() => {
		createdPools.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates one pool on first acquire (MISS) and reuses it on the second (HIT)', () => {
		const mgr = new PgPoolManager();
		const a = mgr.acquire(cred(), 'public');
		const b = mgr.acquire(cred(), 'public');

		expect(createdPools).toHaveLength(1);
		expect(a.pool).toBe(b.pool);
		expect(a.key).toBe(b.key);
		expect(mgr.size).toBe(1);
		expect(mgr.refCountFor(a.key)).toBe(2);
	});

	it('creates separate pools for different targets (schema, db, user, password)', () => {
		const mgr = new PgPoolManager();
		mgr.acquire(cred(), 'public');
		mgr.acquire(cred(), 'other_schema');
		mgr.acquire(cred({ database: 'other_db' }), 'public');
		mgr.acquire(cred({ user: 'ro' }), 'public');
		mgr.acquire(cred({ password: 'rotated' }), 'public');

		expect(createdPools).toHaveLength(5);
		expect(mgr.size).toBe(5);
	});

	it('release is idempotent and never underflows the ref count', () => {
		const mgr = new PgPoolManager();
		const a = mgr.acquire(cred(), 'public');
		expect(mgr.refCountFor(a.key)).toBe(1);
		a.release();
		a.release(); // double release must be a no-op
		expect(mgr.refCountFor(a.key)).toBe(0);
	});

	it('evicts (ends) a pool only after it has been idle past the TTL', () => {
		vi.useFakeTimers();
		const idleTtl = 1000;
		const mgr = new PgPoolManager(idleTtl, 100);

		const a = mgr.acquire(cred(), 'public');
		const pool = createdPools[0];

		// Still referenced -> sweep must NOT evict.
		mgr.sweep(Date.now());
		expect(pool.ended).toBe(false);

		a.release();
		// Idle but TTL not elapsed yet.
		mgr.sweep(Date.now() + idleTtl - 1);
		expect(pool.ended).toBe(false);
		expect(mgr.size).toBe(1);

		// TTL elapsed -> evicted and ended.
		mgr.sweep(Date.now() + idleTtl + 1);
		expect(pool.ended).toBe(true);
		expect(mgr.size).toBe(0);
	});

	it('does not evict a pool that was re-acquired before the TTL (creds change resilience)', () => {
		const idleTtl = 1000;
		const mgr = new PgPoolManager(idleTtl, 100);
		const base = Date.now();

		const a = mgr.acquire(cred(), 'public');
		a.release();
		// Someone else grabs the same target before eviction.
		const b = mgr.acquire(cred(), 'public');

		mgr.sweep(base + idleTtl + 1);
		expect(createdPools[0].ended).toBe(false);
		expect(mgr.size).toBe(1);
		expect(b.pool).toBe(a.pool);
	});

	it('closeAll ends every tracked pool', async () => {
		const mgr = new PgPoolManager();
		mgr.acquire(cred(), 'public');
		mgr.acquire(cred(), 'schema2');
		expect(mgr.size).toBe(2);

		await mgr.closeAll();
		expect(mgr.size).toBe(0);
		expect(createdPools.every((p) => p.ended)).toBe(true);
	});
});
