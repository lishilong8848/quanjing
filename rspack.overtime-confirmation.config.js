const path = require('path');
const {
  CssExtractRspackPlugin,
  HtmlRspackPlugin,
} = require('@rspack/core');

const isProduction = process.env.NODE_ENV === 'production';
const clientBasePath = normalizeBasePath(process.env.CLIENT_BASE_PATH || '');

function normalizeBasePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

module.exports = {
  mode: isProduction ? 'production' : 'development',
  devtool: false,
  target: ['web', 'es2020'],
  entry: {
    main: './client/src/overtime-confirmation-entry.tsx',
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    tsConfig: {
      configFile: path.resolve(__dirname, './tsconfig.app.json'),
    },
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: {
                syntax: 'typescript',
                tsx: true,
              },
              transform: {
                react: {
                  runtime: 'automatic',
                },
              },
            },
          },
        },
      },
      {
        test: /\.css$/,
        use: [
          CssExtractRspackPlugin.loader,
          'css-loader',
          'postcss-loader',
        ],
      },
      {
        test: /\.(png|jpe?g|gif|svg|webp)$/i,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new CssExtractRspackPlugin({ filename: '[name].css' }),
    new HtmlRspackPlugin({
      template: './client/overtime-confirmation.html',
      filename: 'index.html',
      inject: 'body',
    }),
  ],
  output: {
    path: path.resolve(__dirname, 'dist/client/overtime-confirmation'),
    publicPath: `${clientBasePath}/overtime-confirmation/`,
    clean: true,
    filename: '[name].js',
    chunkFilename: 'chunks/[name].[contenthash:8].js',
  },
  optimization: {
    minimize: isProduction,
    splitChunks: false,
  },
  performance: {
    hints: isProduction ? 'warning' : false,
  },
};
