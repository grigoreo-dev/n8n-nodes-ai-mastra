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
// Dev watch is driven by TSUP_WATCH=1 (not the tsup --watch CLI flag). The CLI
// flag is a boolean that forces tsup to watch the whole cwd and overrides any
// config `watch` value, so it can't be scoped. Setting `watch` to an array in
// config is the only way to narrow what triggers a rebuild.
const watchScope = process.env.TSUP_WATCH === '1' ? ['nodes', 'credentials'] : false;

export default defineConfig(() => ({
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
	target: 'node22',
	platform: 'node',
	// Narrow the watch to our TypeScript source dirs (see watchScope above).
	// Otherwise tsup watches the whole cwd and rebuilds on unrelated changes
	// (opencode.json, docs, tests, compose/config files, editor scratch), which
	// with N8N_DEV_RELOAD restarts n8n on every keystroke/tool write. `false`
	// keeps a plain build a one-off that exits.
	watch: watchScope,
	// Inline everything...
	noExternal: [/@mastra\/.*/, 'pg', 'zod'],
	// ...except what n8n itself provides at runtime.
	external: ['n8n-workflow'],
	splitting: false,
	// Minify the bundle. Because we inline all of Mastra (noExternal), the
	// unminified output is huge (~9 MB Agent / ~13 MB Memory). Minifying roughly
	// halves that (~4 MB / ~6 MB), which also makes n8n's dist hot-reload watcher
	// far more reliable — the large unminified bundle intermittently triggers
	// "Hot reload failed". esbuild already tree-shakes on bundle, so minify is
	// the main remaining size win. Source maps keep the output debuggable.
	minify: true,
	sourcemap: true,
	// Don't clean in watch mode: `clean` wipes dist on every rebuild, and n8n's
	// hot-reload watcher (which watches dist) fires on each intermediate
	// add/remove — turning one rebuild into a burst of reloads plus races
	// ("Hot reload failed"). A one-off build still cleans.
	clean: !watchScope,
	dts: false,
	// Preserve each node class as a named CJS export (n8n does require(file).ClassName).
	cjsInterop: true,
	keepNames: true,
	onSuccess: async () => {
		const icons: Array<[string, string]> = [
			['nodes/MastraAgent/mastra-agent.svg', 'dist/nodes/MastraAgent/mastra-agent.svg'],
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
}));
