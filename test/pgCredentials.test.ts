import { describe, expect, it } from 'vitest';

import { poolKey, resolveSsl, type PostgresCredential } from '../nodes/shared/pgCredentials';

const cred = (over: Partial<PostgresCredential> = {}): PostgresCredential => ({
	host: 'db.internal',
	port: 5432,
	database: 'app',
	user: 'app',
	password: 'secret',
	ssl: 'disable',
	...over,
});

describe('resolveSsl', () => {
	it('returns false when SSL is disabled (default)', () => {
		expect(resolveSsl(cred({ ssl: 'disable' }))).toBe(false);
	});

	it('returns true when SSL mode is require/allow', () => {
		expect(resolveSsl(cred({ ssl: 'require' }))).toBe(true);
		expect(resolveSsl(cred({ ssl: 'allow' }))).toBe(true);
	});

	it('returns rejectUnauthorized:false when allowUnauthorizedCerts is set', () => {
		expect(resolveSsl(cred({ ssl: 'require', allowUnauthorizedCerts: true }))).toEqual({
			rejectUnauthorized: false,
		});
	});
});

describe('poolKey', () => {
	it('is stable for identical credentials + schema', () => {
		expect(poolKey(cred(), 'public')).toBe(poolKey(cred(), 'public'));
	});

	it('changes when any identifying field changes', () => {
		const base = poolKey(cred(), 'public');
		expect(poolKey(cred({ host: 'other' }), 'public')).not.toBe(base);
		expect(poolKey(cred({ port: 5433 }), 'public')).not.toBe(base);
		expect(poolKey(cred({ database: 'other' }), 'public')).not.toBe(base);
		expect(poolKey(cred({ user: 'other' }), 'public')).not.toBe(base);
		expect(poolKey(cred({ password: 'rotated' }), 'public')).not.toBe(base);
		expect(poolKey(cred(), 'other_schema')).not.toBe(base);
		expect(poolKey(cred({ ssl: 'require' }), 'public')).not.toBe(base);
	});

	it('does not leak the plaintext password into the key', () => {
		const key = poolKey(cred({ password: 'super-secret-pw' }), 'public');
		expect(key).not.toContain('super-secret-pw');
	});
});
