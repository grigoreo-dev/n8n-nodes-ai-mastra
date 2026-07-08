import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Bundle each node into a single self-contained CJS file with all runtime deps
 * (Mastra, pg, and their ESM-only transitives like pkce-challenge) inlined.
 *
 * Why bundle: n8n's CustomDirectoryLoader globs `**​/*.node.js` across the whole
 * package dir INCLUDING node_modules, and loads each hit as a node class via a
 * synchronous `new (require(file).Class)()` in a VM. Several legit deps ship
 * files literally named `*.node.js` (pkce-challenge/dist/index.node.js,
 * posthog-node/…/index.node.js) meaning "Node.js build", not "n8n node" — n8n
 * tries to instantiate them and crashes. Bundling removes the node_modules tree
 * next to our nodes, so only our real *.node.js files exist. esbuild also
 * transpiles the ESM deps to CJS, so the require()-ESM interop bug disappears.
 */
export default defineConfig({
	entry: {
		'nodes/MastraAgent/MastraAgent.node': 'nodes/MastraAgent/MastraAgent.node.ts',
		'nodes/MemoryPostgresMastra/MemoryPostgresMastra.node':
			'nodes/MemoryPostgresMastra/MemoryPostgresMastra.node.ts',
		'nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node':
			'nodes/ModelOpenAiCompatibleMastra/ModelOpenAiCompatibleMastra.node.ts',
		'credentials/MastraOpenAiCompatibleApi.credentials':
			'credentials/MastraOpenAiCompatibleApi.credentials.ts',
	},
	outDir: 'dist',
	format: ['cjs'],
	target: 'node20',
	platform: 'node',
	// Inline everything...
	noExternal: [/@mastra\/.*/, 'pg', 'zod'],
	// ...except what n8n itself provides at runtime.
	external: ['n8n-workflow'],
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	// Preserve each node class as a named CJS export (n8n does require(file).ClassName).
	cjsInterop: true,
	keepNames: true,
	onSuccess: async () => {
		const icons: Array<[string, string]> = [
			['nodes/MastraAgent/mastra.svg', 'dist/nodes/MastraAgent/mastra.svg'],
			['nodes/MemoryPostgresMastra/postgres.svg', 'dist/nodes/MemoryPostgresMastra/postgres.svg'],
			[
				'nodes/ModelOpenAiCompatibleMastra/model.svg',
				'dist/nodes/ModelOpenAiCompatibleMastra/model.svg',
			],
		];
		for (const [src, dest] of icons) {
			mkdirSync(dest.substring(0, dest.lastIndexOf('/')), { recursive: true });
			cpSync(src, dest);
		}
		console.log('icons copied');
	},
});
