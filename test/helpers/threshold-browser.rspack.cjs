const path = require('node:path');
const { rspack } = require('@rspack/core');
const mode =
  process.env.THRESHOLD_BROWSER_MODE === 'production'
    ? 'production'
    : 'development';
module.exports = {
  mode,
  target: 'web',
  devtool: false,
  experiments: { css: true },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.json'],
    tsConfig: {
      configFile: path.resolve(__dirname, '../../tsconfig.app.json'),
    },
    alias: { '@': path.resolve(__dirname, '../../client/src') },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'builtin:swc-loader',
            options: {
              jsc: {
                parser: { syntax: 'typescript', tsx: true },
                transform: { react: { runtime: 'automatic' } },
              },
            },
          },
        ],
      },
      {
        test: /\.css$/,
        type: 'css',
        use: [
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                config: false,
                plugins: [
                  [
                    'postcss-import',
                    {
                      resolve: (id, basedir) =>
                        id === '@/inspector.dev.css'
                          ? path.join(basedir, 'inspector.dev.css')
                          : id,
                    },
                  ],
                  [
                    '@tailwindcss/postcss',
                    { base: path.resolve(__dirname, '../../client/src') },
                  ],
                  ['autoprefixer', {}],
                ],
              },
            },
          },
        ],
      },
      { test: /\.(png|jpe?g|svg|woff2?)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      'process.env': JSON.stringify({
        NODE_ENV: mode,
        CLIENT_BASE_PATH: '',
      }),
      window: 'globalThis',
    }),
    new rspack.HtmlRspackPlugin({
      templateContent:
        '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  ],
  entry: { main: path.resolve(__dirname, 'threshold-browser-entry.tsx') },
  output: {
    path: path.resolve(
      process.env.TEMP,
      process.env.THRESHOLD_STATIC_VALIDATION === '1'
        ? 'nt-threshold-client-hvac-static'
        : 'nt-threshold-client-validation',
    ),
    clean: true,
  },
  devServer: {
    hot: mode !== 'production',
    historyApiFallback: true,
    static: { directory: path.resolve(__dirname, '../../client/public') },
    host: '127.0.0.1',
    port: 4190,
    proxy: [
      { context: ['/api', '/__innerapi__'], target: 'http://127.0.0.1:4191' },
    ],
  },
};
