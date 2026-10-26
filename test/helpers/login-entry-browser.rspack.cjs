const path=require('node:path');
const base=require('./multi-building-browser.rspack.cjs');
module.exports={...base,entry:{main:path.join(__dirname,'login-entry-browser-entry.tsx')},output:{...base.output,path:path.join(process.env.TEMP,'nt-login-entry-client-validation')}};
