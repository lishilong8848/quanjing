const path = require('path');
const { BannerPlugin, util } = require('@rspack/core');
const preset = require('@lark-apaas/fullstack-rspack-preset/preset.config.js');

// Raw JavaScript banners corrupt the first CSS rule during minification.
const safePreset = {
  ...preset,
  plugins: preset.plugins.map((plugin) =>
    plugin instanceof BannerPlugin
      ? new BannerPlugin({
          banner: `window.__RELEASE_COMMIT_ID__ = ${JSON.stringify(process.env.RELEASE_ID || new Date().toISOString())};`,
          raw: true,
          test: /\.[cm]?js$/i,
        })
      : plugin,
  ),
};

const isDev = process.env.NODE_ENV !== 'production';
const clientBasePath = normalizeBasePath(process.env.CLIENT_BASE_PATH || '');
const serverPort = process.env.SERVER_PORT || '3000';
const serverProtocol =
  process.env.HTTPS_CERT_PATH && process.env.HTTPS_KEY_PATH ? 'https' : 'http';
const serverTarget = `${serverProtocol}://localhost:${serverPort}`;

function normalizeBasePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

module.exports = util.cleverMerge(safePreset, {
  entry: {
    main: './client/src/index.tsx',
  },
  resolve: {
    tsConfig: {
      configFile: path.resolve(__dirname, './tsconfig.app.json'),
    },
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
  output: {
    clean: true,
    filename: '[name].js', // main.js 保持原名
    chunkFilename: 'chunks/[name].[contenthash:8].js', // 动态 chunk 放入 chunks 目录，带 hash
  },
  devServer: isDev
    ? {
        proxy: [
          {
            context: [`${clientBasePath}/api`],
            target: serverTarget,
            changeOrigin: true,
            secure: false,
          },
          {
            context: [`${clientBasePath}/__innerapi__`],
            target: serverTarget,
            changeOrigin: true,
            secure: false,
          },
        ],
      }
    : undefined,
  optimization: isDev
    ? {}
    : {
        splitChunks: {
          chunks: 'async', // 只对动态 import 进行分割
          minSize: 20000, // 最小 20KB 才分割
          cacheGroups: {
            // 将动态 import 的 node_modules 单独打包
            asyncVendors: {
              test: /[\\/]node_modules[\\/]/,
              chunks: 'async',
              name: false,
              priority: 10,
              maxAsyncSize: 350000,
              reuseExistingChunk: true,
            },
          },
        },
      },
});
