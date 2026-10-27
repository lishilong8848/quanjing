const path = require('node:path');
const express = require('express');
const root = path.resolve(__dirname, '../../..');
const stub = path.join(__dirname, 'stubs.tsx');
const tasks = new Map();
let submits = 0;
let writes = 0;
module.exports = {
  context: root, mode: 'development', devtool: false,
  entry: path.join(__dirname, 'entry.tsx'),
  output: { path: path.join(root, 'output/alarm-human-review-dev'), filename: 'fixture.js', cssFilename: 'fixture.css', publicPath: '/' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@/api$': stub, '@/access/AccessProvider$': stub, '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': stub, '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared') } },
  module: { rules: [
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
    { test: /\.css$/, type: 'css/auto' },
  ] }, experiments: { css: true },
  devServer: { host: '127.0.0.1', port: 39893, hot: false, liveReload: false,
    static: { directory: path.join(root, 'dist/client'), publicPath: '/fixture-base', watch: false },
    setupMiddlewares(middlewares, server) {
      server.app.use(express.json());
      const api = '/api/bitable/alarm-human-reviews';
      server.app.get(`${api}/people`, (_req, res) => res.json([{ recordId: 'recPersonA', name: '测试责任人甲', position: '工程师', buildings: ['A'] }, { recordId: 'recPersonB', name: '测试责任人乙', position: '值班长', buildings: ['B'] }]));
      server.app.get(`${api}/mutation/:id`, (req, res) => res.json(tasks.get(req.params.id) || null));
      server.app.post(api, (req, res) => {
        submits++;
        let task = tasks.get(req.body.clientMutationId);
        if (!task) { writes++; task = { ...req.body, id: `fixture-${writes}`, responsibleName: '测试责任人甲', items: req.body.recordIds.map(recordId => ({ recordId, state: 'pending', message: '' })), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), polls: 0 }; tasks.set(req.body.clientMutationId, task); }
        if (req.headers['x-fixture-response-lost'] === '1') return res.status(503).json({ message: '提交响应丢失（测试）' });
        res.json(task);
      });
      server.app.post(`${api}/:id/retry`, (req, res) => { const task = [...tasks.values()].find(t => t.id === req.params.id); task.retried = true; task.items.forEach(item => { if (item.state === 'error') item.state = 'pending'; }); res.json(task); });
      server.app.get(`${api}/:id`, (req, res) => {
        const task = [...tasks.values()].find(t => t.id === req.params.id);
        if (!task) return res.status(404).json({ message: '测试任务不存在' });
        task.polls++;
        if (task.polls >= 2 || task.retried) task.items.forEach((item, i) => { item.state = i === 1 && !task.retried ? 'error' : 'success'; item.message = item.state === 'error' ? '测试外部系统不可用，请重试' : ''; if (item.state === 'success') item.review = { outcome: task.outcome, customReply: task.customReply, responsibleName: task.responsibleName, version: 'a'.repeat(64) }; });
        res.json(task);
      });
      server.app.get('/fixture/state', (_req, res) => res.json({ submits, writes, tasks: [...tasks.values()] }));
      server.app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture-base/main.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'));
      return middlewares;
    },
  },
};
