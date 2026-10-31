import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import worker from './src/worker.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const required = ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_D1_DATABASE_ID','CLOUDFLARE_API_TOKEN','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn(`Missing configuration: ${missing.join(', ')}`);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key,value,encoding) => createHmac('sha256',key).update(value).digest(encoding);
const awsEncode = value => encodeURIComponent(value).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const awsPath = value => value.split('/').map(awsEncode).join('/');
function signingKey(secret,date,region='auto',service='s3') { const d=hmac(`AWS4${secret}`,date);const r=hmac(d,region);const s=hmac(r,service);return hmac(s,'aws4_request'); }
function r2Config(){return {account:process.env.R2_ACCOUNT_ID,access:process.env.R2_ACCESS_KEY_ID,secret:process.env.R2_SECRET_ACCESS_KEY,bucket:process.env.R2_BUCKET,host:`${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`};}
async function putR2(key,body,options={}) {
  const c=r2Config(),now=new Date(),amz=now.toISOString().replace(/[:-]|\.\d{3}/g,''),date=amz.slice(0,8),payload=Buffer.from(body),hash=sha256(payload),uri=`/${awsEncode(c.bucket)}/${awsPath(key)}`;
  const headers={'content-type':options.httpMetadata?.contentType||'application/octet-stream','host':c.host,'x-amz-content-sha256':hash,'x-amz-date':amz,'x-amz-meta-ownerid':options.customMetadata?.ownerId||'','x-amz-meta-originalname':awsEncode(options.customMetadata?.originalName||'')};
  const names=Object.keys(headers).sort(),canonicalHeaders=names.map(n=>`${n}:${String(headers[n]).trim()}\n`).join(''),signed=names.join(';');
  const canonical=`PUT\n${uri}\n\n${canonicalHeaders}\n${signed}\n${hash}`;
  const scope=`${date}/auto/s3/aws4_request`,toSign=`AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(canonical)}`,signature=hmac(signingKey(c.secret,date),toSign,'hex');
  const authorization=`AWS4-HMAC-SHA256 Credential=${c.access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  const response=await fetch(`https://${c.host}${uri}`,{method:'PUT',headers:{...headers,Authorization:authorization},body:payload});
  if(!response.ok) throw new Error(`R2 upload failed (${response.status}): ${await response.text()}`);
}
function signedR2Url(key,expires=300) {
  const c=r2Config(),now=new Date(),amz=now.toISOString().replace(/[:-]|\.\d{3}/g,''),date=amz.slice(0,8),scope=`${date}/auto/s3/aws4_request`,uri=`/${awsEncode(c.bucket)}/${awsPath(key)}`;
  const params={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':`${c.access}/${scope}`,'X-Amz-Date':amz,'X-Amz-Expires':String(expires),'X-Amz-SignedHeaders':'host'};
  const query=Object.keys(params).sort().map(k=>`${awsEncode(k)}=${awsEncode(params[k])}`).join('&');
  const canonical=`GET\n${uri}\n${query}\nhost:${c.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const toSign=`AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(canonical)}`,signature=hmac(signingKey(c.secret,date),toSign,'hex');
  return `https://${c.host}${uri}?${query}&X-Amz-Signature=${signature}`;
}

class D1Statement {
  constructor(db, sql, values=[]) { this.db=db; this.sql=sql; this.values=values; }
  bind(...values) { return new D1Statement(this.db,this.sql,values); }
  async execute() { return this.db.query(this.sql,this.values); }
  async first() { const r=await this.execute(); return r.results?.[0] ?? null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
class CloudflareD1 {
  constructor() { this.endpoint=`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.CLOUDFLARE_D1_DATABASE_ID}/query`; }
  prepare(sql) { return new D1Statement(this,sql); }
  async query(sql, params=[]) {
    const res=await fetch(this.endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
    const payload=await res.json().catch(()=>({}));
    if(!res.ok || payload.success===false) throw new Error(payload.errors?.map(e=>e.message).join('; ') || `Cloudflare D1 request failed (${res.status})`);
    const item=payload.result?.[0] || {};
    return { success:true, results:item.results || [], meta:item.meta || {}, ...item };
  }
}
const env = {
  DB:new CloudflareD1(),
  R2:{put:putR2,signedUrl:signedR2Url},
  RESEND_API_KEY:process.env.RESEND_API_KEY,
  RESEND_FROM:process.env.RESEND_FROM,
  ADMIN_EMAIL:process.env.ADMIN_EMAIL,
  APP_ORIGIN:process.env.APP_ORIGIN
};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      const chunks=[]; for await (const c of req) chunks.push(c); const body=Buffer.concat(chunks);
      const headers=new Headers(req.headers);
      const request=new Request(`https://${req.headers.host || 'localhost'}${req.url}`,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body});
      const response=await worker.fetch(request,env);
      res.writeHead(response.status,Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const publicRoot=path.resolve(root,'public');
    let file=path.resolve(publicRoot,`.${decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)}`);
    if(file!==publicRoot && !file.startsWith(publicRoot+path.sep)) { res.writeHead(403);res.end('Forbidden');return; }
    try { const info=await stat(file); if(info.isDirectory()) file=path.join(file,'index.html'); const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data); }
    catch { res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found'); }
  } catch(err) { console.error(err);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Internal server error'})); }
});
const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>console.log(`Mid-Ama Promo portal listening on ${port}`));
