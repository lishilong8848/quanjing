const path = require('path');
const { CopyRspackPlugin } = require('@rspack/core');
const {
  createFullstackRspackConfig,
} = require('@lark-apaas/fullstack-rspack-preset');

const baseConfig = require('./rspack.config.js');
const { extends: _ignoredExtends, ...baseOverrides } = baseConfig;

const outputPath = process.env.HOTFIX_CLIENT_OUTPUT_PATH;
const purchaseSnapshotRoot = process.env.HOTFIX_PURCHASE_SNAPSHOT_ROOT;

if (!outputPath) {
  throw new Error('HOTFIX_CLIENT_OUTPUT_PATH is required');
}

const normalizedOutputPath = path.resolve(outputPath);
const normalizedPurchaseSnapshotRoot = purchaseSnapshotRoot
  ? path.resolve(purchaseSnapshotRoot)
  : null;
const purchaseSourceRoot = path.resolve(
  __dirname,
  'client/src/pages/PurchaseInventoryManagement',
);

const hotfixConfig = createFullstackRspackConfig({
  ...baseOverrides,
  resolve: {
    ...baseOverrides.resolve,
    modules: ['node_modules', path.resolve(__dirname, 'node_modules')],
    alias: {
      ...(baseOverrides.resolve?.alias || {}),
      ...(normalizedPurchaseSnapshotRoot
        ? { [purchaseSourceRoot]: normalizedPurchaseSnapshotRoot }
        : {}),
    },
  },
  output: {
    ...baseOverrides.output,
    path: normalizedOutputPath,
    clean: true,
  },
  devtool: false,
  plugins: [...(baseOverrides.plugins || [])],
});

hotfixConfig.plugins = [
  ...(hotfixConfig.plugins || []).filter(
    (plugin) => plugin?.constructor?.name !== 'CopyRspackPlugin',
  ),
  new CopyRspackPlugin({
    patterns: [
      {
        from: path.resolve(__dirname, 'client/public'),
        to: '.',
      },
    ],
  }),
];

module.exports = hotfixConfig;
