import svelte from 'rollup-plugin-svelte';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';
import babel from 'rollup-plugin-babel';
import css from 'rollup-plugin-css-only';
import multiInput from 'rollup-plugin-multi-input';
import replace from '@rollup/plugin-replace';
import json from '@rollup/plugin-json';
import glob from 'glob';
import path from 'path';
import fs from 'fs-extra';
import del from 'del';
import defaultsDeep from 'lodash.defaultsdeep';
import { getElderConfig, partialHydration } from '../index';
import { getDefaultRollup } from './validations';
import { SettingsOptions } from './types';

const production = process.env.NODE_ENV === 'production' || !process.env.ROLLUP_WATCH;
const elderJsDir = path.resolve(process.cwd(), './node_modules/@elderjs/elderjs/');

const babelIE11 = babel({
  cwd: elderJsDir,
  extensions: ['.js', '.mjs', '.html', '.svelte'],
  runtimeHelpers: true,
  exclude: ['node_modules/@babel/**', 'node_modules/core-js/**'],
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          browsers: ['> 0.25%', 'not dead', 'IE 11'],
        },
        useBuiltIns: 'usage',
        forceAllTransforms: false,
        corejs: {
          version: 3.6,
          proposals: true,
        },
      },
    ],
  ],
  plugins: [
    // [
    //   '@babel/plugin-transform-runtime',
    //   {
    //     corejs: {
    //       version: 3,
    //       proposals: true,
    //     },
    //     regenerator: true,
    //     useESModules: false,
    //     absoluteRuntime: path.resolve(process.cwd(), './node_modules/@elderjs/elderjs/node_modules/'),
    //   },
    // ],
  ],
});

export function createBrowserConfig({
  input,
  output,
  multiInputConfig,
  svelteConfig,
  replacements = {},
  ie11 = false as boolean,
}) {
  const toReplace = {
    'process.env.componentType': "'browser'",
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    ...replacements,
  };

  const config = {
    cache: true,
    treeshake: production,
    input,
    output,
    plugins: [
      replace(toReplace),
      json(),
      svelte({
        ...svelteConfig,
        dev: !production,
        immutable: true,
        hydratable: true,
        css: false,
      }),
      nodeResolve({
        browser: true,
        dedupe: ['svelte'],
        preferBuiltins: true,
      }),
      commonjs({ sourceMap: !production }),
    ],
  };

  // bundle splitting.
  if (multiInputConfig) {
    config.plugins.unshift(multiInputConfig);
  }

  // ie11 babel
  if (ie11) {
    config.plugins.push(babelIE11);
  }

  // if is production let's babelify everything and minify it.
  if (production) {
    // don't babel if it has been done
    if (!ie11) {
      config.plugins.push(
        babel({
          extensions: ['.js', '.mjs', '.cjs', '.html', '.svelte'],
          include: ['node_modules/**', 'src/**'],
          exclude: ['node_modules/@babel/**'],
          runtimeHelpers: true,
        }),
      );
    }

    // terser on prod
    config.plugins.push(terser());
  }

  return config;
}

export function createSSRConfig({ input, output, svelteConfig, replacements = {}, multiInputConfig }) {
  const toReplace = {
    'process.env.componentType': "'server'",
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    ...replacements,
  };

  const config = {
    cache: true,
    treeshake: production,
    input,
    output,
    plugins: [
      replace(toReplace),
      json(),
      svelte({
        ...svelteConfig,
        dev: !production,
        hydratable: true,
        generate: 'ssr',
        css: true,
        extensions: '.svelte',
        preprocess: [...svelteConfig.preprocess, partialHydration],
      }),

      nodeResolve({
        browser: false,
        dedupe: ['svelte'],
      }),
      commonjs({ sourceMap: true }),
      css({
        ignore: true,
      }),
      production && terser(),
    ],
  };
  // if we are bundle splitting include them.
  if (multiInputConfig) {
    config.plugins.unshift(multiInputConfig);
  }

  return config;
}

export function getPluginPaths(elderConfig: SettingsOptions) {
  const pluginNames = Object.keys(elderConfig.plugins);

  return pluginNames.reduce((out, pluginName) => {
    const pluginPath = path.resolve(elderConfig.srcDir, `./plugins/${pluginName}`);
    const nmPluginPath = path.resolve(elderConfig.rootDir, `./node_modules/${pluginName}`);
    if (fs.existsSync(`${pluginPath}/index.js`)) {
      const svelteFiles = glob.sync(`${pluginPath}/*.svelte`);
      if (svelteFiles.length > 0) {
        out.push(`${pluginPath}/`);
      }
    } else if (fs.existsSync(`${nmPluginPath}/package.json`)) {
      if (glob.sync(`${nmPluginPath}/*.svelte`).length > 0) {
        out.push(`${nmPluginPath}/`);
      }
    }
    return out;
  }, []);
}

export default function getRollupConfig(options) {
  const defaultOptions = getDefaultRollup();
  const { svelteConfig, replacements, dev } = defaultsDeep(options, defaultOptions);
  const elderConfig = getElderConfig();
  const { $$internal, distDir, srcDir, rootDir, legacy } = elderConfig;
  const { ssrComponents, clientComponents } = $$internal;
  const relSrcDir = srcDir.replace(rootDir, '').substr(1);

  console.log(`Elder.js using rollup in ${production ? 'production' : 'development'} mode.`);

  let configs = [];

  // clear out components so there are no conflicts due to hashing.
  del.sync([`${ssrComponents}*`, `${clientComponents}*`]);
  // Add ElderJs Peer deps to public if they exist.
  [['./node_modules/intersection-observer/intersection-observer.js', './static/intersection-observer.js']].forEach(
    (dep) => {
      if (!fs.existsSync(path.resolve(rootDir, dep[0]))) {
        throw new Error(`Elder.js peer dependency not found at ${dep[0]}`);
      }
      configs.push({
        input: dep[0],
        output: [
          {
            file: path.resolve(distDir, dep[1]),
            format: 'iife',
            name: dep[1],
            plugins: [terser()],
          },
        ],
      });
    },
  );

  // SSR /routes/ Svelte files.
  const routesAndLayouts = createSSRConfig({
    input: [`${relSrcDir}/layouts/*.svelte`, `${relSrcDir}/routes/*/*.svelte`],
    output: {
      dir: ssrComponents,
      format: 'cjs',
      exports: 'auto',
    },
    multiInputConfig: multiInput({
      relative: `${relSrcDir}/`,
      transformOutputPath: (output) => `${path.basename(output)}`,
    }),
    svelteConfig,
    replacements,
  });

  const pluginPaths = getPluginPaths(elderConfig);

  configs = [...configs, routesAndLayouts];

  if (!production && dev && dev.splitComponents) {
    // watch/dev build bundles each component individually for faster reload times during dev.
    // we don't need iifes on dev.
    console.log(
      `NOTE: Splitting components into separate rollup objects, this breaks some svelte features such as stores.`,
    );
    if (fs.existsSync(path.resolve(srcDir, `./components/`))) {
      const srcComponentsNested = glob.sync(path.resolve(srcDir, './components/*/*.svelte'));
      const srcComponents = glob.sync(path.resolve(srcDir, './components/*.svelte'));
      [...new Set([...srcComponentsNested, ...srcComponents])].forEach((cv) => {
        const file = cv.replace(`${rootDir}/`, '');
        configs.push(
          createBrowserConfig({
            input: file,
            output: [
              {
                dir: clientComponents,
                entryFileNames: 'entry[name]-[hash].js',
                sourcemap: !production,
                format: 'esm',
              },
            ],
            svelteConfig,
            replacements,
            multiInputConfig: false,
          }),
        );

        configs.push(
          createSSRConfig({
            input: file,
            output: {
              dir: ssrComponents,
              format: 'cjs',
              exports: 'auto',
            },
            svelteConfig,
            replacements,
            multiInputConfig: false,
          }),
        );
      });
    }
  } else {
    configs.push(
      createBrowserConfig({
        input: [`${relSrcDir}/components/*/*.svelte`, `${relSrcDir}/components/*.svelte`],
        output: [
          {
            dir: clientComponents,
            entryFileNames: 'entry[name]-[hash].mjs',
            sourcemap: !production,
            format: 'esm',
          },
        ],
        multiInputConfig: multiInput({
          relative: `${relSrcDir}/components`,
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        replacements,
      }),
    );

    configs.push(
      createSSRConfig({
        input: [`${relSrcDir}/components/*/*.svelte`, `${relSrcDir}/components/*.svelte`],
        output: {
          dir: ssrComponents,
          format: 'cjs',
          exports: 'auto',
        },
        multiInputConfig: multiInput({
          relative: `${relSrcDir}/components`,
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        replacements,
      }),
    );

    // legacy is only done on production or not split modes.
    if (legacy) {
      if (fs.existsSync(path.resolve(srcDir, `./components/`))) {
        const srcComponentsNested = glob.sync(path.resolve(srcDir, './components/*/*.svelte'));
        const srcComponents = glob.sync(path.resolve(srcDir, './components/*.svelte'));
        [...new Set([...srcComponentsNested, ...srcComponents])].forEach((cv) => {
          const file = cv.replace(`${rootDir}/`, '');
          const parsed = path.parse(cv);
          configs.push(
            createBrowserConfig({
              input: file,
              output: [
                {
                  name: `___elderjs_${parsed.name}`,
                  dir: clientComponents,
                  entryFileNames: 'iife[name]-[hash].js',
                  sourcemap: !production,
                  format: 'iife',
                },
              ],
              svelteConfig,
              replacements,
              multiInputConfig: false,
              ie11: true,
            }),
          );
        });
      }
    }
  }

  pluginPaths.forEach((pluginPath) => {
    configs.push(
      createBrowserConfig({
        input: [`${pluginPath}*.svelte`],
        output: [
          {
            dir: clientComponents,
            entryFileNames: 'entry[name]-[hash].js',
            sourcemap: !production,
            format: 'esm',
          },
        ],
        multiInputConfig: multiInput({
          relative: pluginPath.replace(elderConfig.distDir, '').substr(1),
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        replacements,
      }),
    );

    configs.push(
      createSSRConfig({
        input: [`${pluginPath}*.svelte`],
        output: {
          dir: ssrComponents,
          format: 'cjs',
          exports: 'auto',
        },
        multiInputConfig: multiInput({
          relative: pluginPath.replace(elderConfig.distDir, '').substr(1),
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        replacements,
      }),
    );

    if (legacy) {
      const legacyPluginFiles = glob.sync(`${pluginPath}*.svelte`);
      legacyPluginFiles.forEach((cv) => {
        const file = cv.replace(`${rootDir}/`, '');
        const parsed = path.parse(cv);
        configs.push(
          createBrowserConfig({
            input: file,
            output: [
              {
                name: `___elderjs_${parsed.name}`,
                dir: clientComponents,
                entryFileNames: 'iife[name]-[hash].js',
                sourcemap: !production,
                format: 'iife',
              },
            ],
            svelteConfig,
            replacements,
            multiInputConfig: false,
            ie11: true,
          }),
        );
      });
    }
  });

  return configs;
}
