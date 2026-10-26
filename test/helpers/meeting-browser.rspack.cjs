const path = require('node:path');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const mode =
  process.env.MEETING_BROWSER_MODE === 'production'
    ? 'production'
    : 'development';

module.exports = {
  mode,
  target: 'web',
  devtool: false,
  experiments: { css: true },
  entry: { main: path.join(__dirname, 'meeting-browser-entry.tsx') },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.json'],
    tsConfig: { configFile: path.join(root, 'tsconfig.app.json') },
    alias: { '@': path.join(root, 'client/src') },
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
                    { base: path.join(root, 'client/src') },
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
  output: {
    path: path.resolve(process.env.TEMP, 'nt-meeting-client-validation'),
    publicPath: '/',
    clean: true,
  },
  devServer: {
    host: '127.0.0.1',
    port: 4200,
    historyApiFallback: true,
    static: { directory: path.join(root, 'client/public') },
    proxy: [
      { context: ['/api', '/__innerapi__'], target: 'http://127.0.0.1:4201' },
    ],
  },
};
