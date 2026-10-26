const path=require('node:path');
const base=require('./multi-building-browser.rspack.cjs');
module.exports={...base,entry:{main:path.join(__dirname,'readonly-refresh-browser-entry.tsx')},output:{...base.output,path:path.join(process.env.TEMP,'nt-readonly-refresh-client-validation')}};
