const path = require('node:path');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../../..');
const stub = path.join(__dirname, 'stubs.tsx');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const zero = { todayEvents: 0, pendingEvents: 0, priorPendingEvents: 0, closedTodayEvents: 0, keyEvents: 0, todayChanges: 0, activeChanges: 0, priorActiveChanges: 0, keyChanges: 0, todayInspections: 0, activeInspections: 0, todayMaintenance: 0, activeMaintenance: 0 };
const rack = {
  usageRate: 75.9, online: 4037, total: 5322, poweredOnThisWeek: 0, poweredOffThisWeek: 0, poweredOnWeekDelta: 0, poweredOffWeekDelta: 0,
  weekStartDate: '2026-09-28', capacityDate: date, loadDate: date,
  buildingLoads: ['A楼','B楼','C楼','D楼','E楼'].map((building, i) => ({ building, value: [65.3,68.7,68.8,37.4,15.3][i] })),
  buildingUsages: ['A楼','B楼','C楼','D楼','E楼'].map((building, i) => ({ building, online: [970,1022,970,673,402][i], total: [988,1076,998,988,1272][i], usageRate: [98.2,95,97.2,68.1,31.6][i] })),
};
module.exports = {
  context: root, mode: 'development', devtool: false,
  entry: path.join(__dirname, 'entry.tsx'),
  output: { path: path.join(root, 'output/panorama-read-recovery-dev'), filename: 'fixture.js', cssFilename: 'fixture.css', publicPath: '/' },
  resolve: { extensions: ['.tsx','.ts','.js'], alias: {
    '@/api$': stub, '@/access/AccessProvider$': stub,
    '@/components/NantongAssistantHost$': stub, '@/components/attendance/use-today-attendance$': stub,
    '@lark-apaas/client-toolkit/logger$': stub, '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': stub,
    '@': path.join(root, 'client/src'), '@shared': path.join(root, 'shared'),
  } },
  plugins: [new rspack.NormalModuleReplacementPlugin(/^\.\/(OperationsPanels|OnDutyPeopleDialog)$/, stub)],
  module: { rules: [
    { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } } } },
    { test: /\.css$/, type: 'css/auto' },
  ] }, experiments: { css: true },
  devServer: {
    host: '127.0.0.1', port: 39892, hot: false, liveReload: false,
    static: { directory: path.join(root, 'dist/client'), publicPath: '/fixture-base', watch: false },
    setupMiddlewares(middlewares, server) {
      server.app.get('/fixture/overview', (_req,res) => res.json({ businessDate: date, sourceStatus: 'fresh', syncedAt: new Date().toISOString(), rackSummary: rack, operations: zero, details: { events: [], changes: [], inspections: [], maintenance: [] }, focusDetails: { pendingEvents: [], activeChanges: [] }, sourceStates: Object.fromEntries(['events','changes','inspections','maintenance'].map(k => [k, {status:'fresh', errorCode:null, errorMessage:null}])) }));
      server.app.get('/fixture/sealing', (req,res) => {
        if (req.query.mode === 'offline') return res.status(503).json({ message: 'Fixture offline' });
        const item = { id:'fixture-sealing', bitableRecordId:'fixture-sealing', sealingCode:'TEST-RECOVERY', sealingName:'测试封网安排（浏览器夹具）', startDate:`${date}T08:00:00+08:00`, endDate:`${date}T21:00:00+08:00`, sealingType:'强管控', autoNumber:null, isToday:true, createdAt:`${date}T00:00:00+08:00`, updatedAt:`${date}T00:00:00+08:00` };
        return res.json({ sealings:[item], total:1, sourceStatus:req.query.mode === 'stale' ? 'stale':'fresh' });
      });
      server.app.get('/', (_req,res) => res.type('html').send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture-base/main.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'));
      return middlewares;
    },
  },
};
