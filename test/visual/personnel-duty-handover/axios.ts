export async function axiosForBackend({url,method,data}:{url:string;method:string;data?:unknown}) {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const payload=await response.json();
  if(!response.ok)throw {response:{status:response.status,data:payload}};
  return {status:response.status,data:payload};
}
