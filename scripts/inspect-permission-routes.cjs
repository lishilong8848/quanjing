'use strict';
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function values(expression){
  if(!expression)return [''];
  if(ts.isStringLiteralLike(expression))return [expression.text];
  if(ts.isArrayLiteralExpression(expression))return expression.elements.flatMap(values);
  throw Error('Dynamic route declaration needs explicit review: '+expression.getText());
}
function decorators(node){return (ts.getDecorators(node)||[]).map(item=>item.expression).filter(ts.isCallExpression).map(call=>({name:call.expression.getText(),arguments:call.arguments}));}
function inspect(root){
  const routes=[];
  function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())walk(file);
    else if(entry.name.endsWith('.ts')&&!entry.name.endsWith('.spec.ts')){
      const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
      for(const node of source.statements){
        if(!ts.isClassDeclaration(node))continue;
        const tags=decorators(node),controller=tags.find(item=>item.name==='Controller');if(!controller)continue;
        for(const member of node.members){if(!ts.isMethodDeclaration(member))continue;
          const marks=decorators(member),route=marks.find(item=>['Get','Post','Put','Patch','Delete','Head','Options','All'].includes(item.name));if(!route)continue;
          for(const prefix of values(controller.arguments[0]))for(const suffix of values(route.arguments[0]))routes.push({method:route.name.toUpperCase(),path:('/'+prefix+'/'+suffix).replace(/\/+/g,'/').replace(/\/$/,'')||'/',file:path.relative(root,file).replace(/\\/g,'/'),handler:member.name.getText(),classTags:tags.map(item=>item.name),tags:marks.map(item=>item.name)});
        }
      }
    }
  }}walk(path.join(root,'server'));return routes;
}
if(require.main===module){const root=path.resolve(__dirname,'..'),routes=inspect(root);if(routes.length<100)throw Error('Incomplete route scan');const output=process.argv[2];if(output)fs.writeFileSync(path.resolve(output),JSON.stringify(routes,null,2));console.log(JSON.stringify({routes:routes.length,controllers:new Set(routes.map(row=>row.file)).size}));}
module.exports={inspect};
