import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { crc32 } from './zip.mjs';

const password='A-long-test-password-2026';
const workerToken='test-worker-secret-12345678901234567890';
const dataDir=mkdtempSync(join(tmpdir(),'publisher-exit-test-'));
let app,url,operator,customer,projectId,otherProject;
async function request(path,{method='GET',body,auth,headers={}}={}){
  if(auth){headers.Cookie=auth.cookie;headers['X-CSRF-Token']=auth.csrf;}
  if(body!==undefined&&!Buffer.isBuffer(body)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
  const response=await fetch(url+path,{method,headers,body});const type=response.headers.get('content-type')||'';
  const value=type.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,value,headers:response.headers};
}
async function login(){const r=await request('/api/login',{method:'POST',body:{password}});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.value.csrf};}
async function post(path,body={},auth=operator){return request(path,{method:'POST',body,auth});}
async function detail(id=projectId,auth=operator){const r=await request('/api/projects/'+id,{auth});assert.equal(r.status,200);return r.value;}
async function worker(action,body={},extra={}){return request('/api/worker/'+action,{method:'POST',body,headers:{'X-Worker-Token':workerToken,...extra}});}
before(async()=>{app=createApp({dataDir,password,workerToken});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;operator=await login();});
after(async()=>{await new Promise(r=>app.server.close(r));rmSync(dataDir,{recursive:true,force:true});});

test('unauthenticated requests, CSRF, and cross-origin writes are rejected',async()=>{
  assert.equal((await request('/api/projects')).status,401);
  assert.equal((await request('/api/projects',{method:'POST',body:{},headers:{Cookie:operator.cookie}})).status,403);
  assert.equal((await request('/api/projects',{method:'POST',body:{},auth:operator,headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await request('/data/publisher-exit.sqlite')).status,401);
});
test('projects persist and single-use invites isolate customer access',async()=>{
  const a=await post('/api/projects',{name:'Example Church',contact:'Pat',deadline:'2026-10-04',referral:'Test fixture'});assert.equal(a.status,201);projectId=a.value.id;
  const b=await post('/api/projects',{name:'Other school',contact:'Morgan'});otherProject=b.value.id;
  const invite=await post(`/api/projects/${projectId}/invite`);
  const access=await post('/api/access',{token:invite.value.token},null);assert.equal(access.status,200);customer={cookie:access.headers.get('set-cookie').split(';')[0],csrf:access.value.csrf};
  assert.equal((await post('/api/access',{token:invite.value.token},null)).status,401);
  const list=await request('/api/projects',{auth:customer});assert.equal(list.value.length,1);assert.equal(list.value[0].id,projectId);
  assert.equal((await request('/api/projects/'+otherProject,{auth:customer})).status,404);
  assert.equal((await post(`/api/projects/${otherProject}/invite`,{},customer)).status,404);
  assert.equal((await post('/api/projects',{name:'Unwanted',contact:'Test'},customer)).status,403);
});
test('inventory keeps relative paths and hashes, maps duplicates, and rejects traversal',async()=>{
  const bytes=Buffer.from('representative source fixture');
  const upload=(name,content=bytes,id=projectId,auth=customer)=>request(`/api/projects/${id}/files`,{method:'POST',auth,body:content,headers:{'X-File-Name':encodeURIComponent(name)}});
  assert.equal((await upload('../outside.pub')).status,400);
  assert.equal((await upload('wrong.exe')).status,400);
  assert.equal((await upload('bulletins/week.pub',Buffer.alloc(0))).status,400);
  assert.equal((await upload('bulletins/week.pub')).status,201);
  assert.equal((await upload('bulletins/week.pub')).value.alreadyUploaded,true);
  assert.equal((await upload('archive/week.pub')).value.duplicate,true);
  assert.equal((await upload('new/week.pub',Buffer.from('different source'))).status,201);
  assert.equal((await upload('other.pub',bytes,otherProject)).status,404);
  const d=await detail();assert.equal(d.files.length,3);assert.equal(new Set(d.files.map(f=>f.job_id)).size,2);
  const f=app.db.prepare('SELECT * FROM files WHERE duplicate_of IS NULL LIMIT 1').get();assert.deepEqual(readFileSync(join(dataDir,'files',f.path)),bytes);
});
test('worker leases are exclusive; stale workers cannot overwrite results; retries are bounded',async()=>{
  assert.equal((await post('/api/worker/claim',{},null)).status,401);
  const claims=await Promise.all([worker('claim'),worker('claim'),worker('claim')]);const jobs=claims.map(c=>c.value.job).filter(Boolean);assert.equal(jobs.length,2);assert.notEqual(jobs[0].id,jobs[1].id);
  const first=jobs[0];assert.equal((await worker(`jobs/${first.id}/heartbeat`,{}, {'X-Job-Lease':'wrong'})).status,409);
  app.db.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').run(first.id);
  const reclaimed=(await worker('claim')).value.job;assert.equal(reclaimed.id,first.id);assert.notEqual(reclaimed.lease,first.lease);
  assert.equal((await worker(`jobs/${first.id}/fail`,{error:'stale'},{'X-Job-Lease':first.lease})).status,409);
  app.db.prepare('UPDATE jobs SET attempts=3,lease_until=0 WHERE id=?').run(first.id);
  assert.equal((await worker('claim')).value.job,null);
  assert.equal(app.db.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status,'failed');
  await worker(`jobs/${jobs[1].id}/fail`,{error:'Missing font or blocked export'},{'X-Job-Lease':jobs[1].lease});
  assert.equal((await post(`/api/projects/${projectId}/jobs/${first.id}/retry`)).status,200);
});
test('exported output requires review and exceptions require explicit customer acceptance',async()=>{
  const job=(await worker('claim')).value.job;
  assert.equal((await worker(`jobs/${job.id}/result`,Buffer.from('not a PDF'),{'X-Job-Lease':job.lease,'X-Page-Count':'1'})).status,400);
  // Structural PDF envelope is checked here; real Publisher fidelity requires operator review.
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
  assert.equal((await worker(`jobs/${job.id}/result`,pdf,{'X-Job-Lease':job.lease,'X-Page-Count':'1'})).status,200);
  let d=await detail();const exported=d.files.find(f=>f.job_id===job.id);assert.equal(exported.status,'exported');assert.equal(exported.qa,0);
  assert.equal((await post(`/api/projects/${projectId}/jobs/${job.id}/review`,{},customer)).status,403);
  assert.equal((await post(`/api/projects/${projectId}/jobs/${job.id}/review`)).status,200);
  d=await detail();const failed=d.files.find(f=>f.status==='failed');assert.ok(failed);
  assert.equal((await post(`/api/projects/${projectId}/jobs/${failed.job_id}/exception`,{reason:'Corrupt source; customer will retain original.'})).status,200);
  const download=await request(`/api/projects/${projectId}/files/${exported.id}/pdf`,{auth:customer});assert.equal(download.status,200);assert.deepEqual(download.value,pdf);
  assert.equal((await request(`/api/projects/${otherProject}/files/${exported.id}/pdf`,{auth:customer})).status,404);
});
test('quote versions cannot be accepted after superseding and accepted scope is immutable',async()=>{
  const scope={cents:400000,template_count:1,file_limit:800,page_limit:1000,revisions:2,scope:'PDF archive, one bulletin template, and 60-minute training. Audit fee additional.',due:'2026-10-10'};
  assert.equal((await post(`/api/projects/${projectId}/quotes`,{...scope,cents:-1})).status,400);
  await post(`/api/projects/${projectId}/quotes`,scope);const old=(await detail()).quotes[0];await post(`/api/projects/${projectId}/quotes`,{...scope,cents:350000});
  assert.equal((await post(`/api/projects/${projectId}/quotes/${old.id}/accept`,{},customer)).status,409);
  const newest=(await detail()).quotes[0];assert.equal(newest.version,2);
  assert.equal((await post(`/api/projects/${projectId}/quotes/${newest.id}/accept`)).status,403);
  assert.equal((await post(`/api/projects/${projectId}/quotes/${newest.id}/accept`,{},customer)).status,200);
  assert.equal((await post(`/api/projects/${projectId}/quotes`,scope)).status,409);
  assert.equal((await post(`/api/projects/${projectId}/complete`,{accept_exceptions:true},customer)).status,409);
});
test('template approvals are tied to the reviewed version and verified ownership',async()=>{
  await post(`/api/projects/${projectId}/templates`,{name:'Sunday bulletin'});let t=(await detail()).templates[0];
  const update=body=>request(`/api/projects/${projectId}/templates/${t.id}`,{method:'PATCH',auth:operator,body});
  assert.equal((await update({url:'javascript:alert(1)'})).status,400);
  await update({url:'https://www.canva.com/',ownership:false,print_checked:true});t=(await detail()).templates[0];
  const review=body=>post(`/api/projects/${projectId}/templates/${t.id}/review`,body,customer);
  assert.equal((await review({version:t.version,accept:true,comment:'Approved'})).status,409);
  await update({url:'https://www.canva.com/',ownership:true,print_checked:true});
  assert.equal((await review({version:t.version,accept:true,comment:'Old version'})).status,409);
  t=(await detail()).templates[0];assert.equal((await review({version:t.version,accept:false,comment:'Please increase the footer size.'})).status,200);
  await update({url:'https://www.canva.com/',ownership:true,print_checked:true,notes:'Footer enlarged; print test passed.'});t=(await detail()).templates[0];
  assert.equal((await review({version:t.version,accept:true,comment:'I can edit and print this template.'})).status,200);
});
test('handoff requires training and exception consent, then locks migration changes',async()=>{
  await request(`/api/projects/${projectId}`,{method:'PATCH',auth:operator,body:{next_action:'Final acceptance',audit_paid:true,source_complete:true,training_at:'2026-10-08',trainee:'Pat',training_passed:true}});
  assert.equal((await post(`/api/projects/${projectId}/complete`,{accept_exceptions:false},customer)).status,409);
  assert.equal((await post(`/api/projects/${projectId}/complete`,{accept_exceptions:true},customer)).status,200);
  assert.equal((await detail()).project.stage,'complete');
  assert.equal((await post(`/api/projects/${projectId}/templates`,{name:'Late scope'})).status,409);
  assert.equal((await request(`/api/projects/${projectId}/files`,{method:'POST',auth:customer,body:Buffer.from('late'),headers:{'X-File-Name':'late.pub'}})).status,409);
  const manifest=await request(`/api/projects/${projectId}/manifest`,{auth:customer});assert.equal(manifest.value.stage,'complete');assert.equal(manifest.value.files.length,3);
});
test('archive ZIP contains a valid central directory and unique per-source PDF paths',async()=>{
  const r=await request(`/api/projects/${projectId}/archive`,{auth:customer});assert.equal(r.status,200);const zip=r.value;assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
  const count=zip.readUInt16LE(zip.length-12);let position=zip.readUInt32LE(zip.length-6);const names=[];
  for(let i=0;i<count;i++){assert.equal(zip.readUInt32LE(position),0x02014b50);const length=zip.readUInt16LE(position+28);const name=zip.subarray(position+46,position+46+length).toString();names.push(name);const local=zip.readUInt32LE(position+42);const start=local+30+zip.readUInt16LE(local+26);const size=zip.readUInt32LE(position+24);assert.equal(crc32(zip.subarray(start,start+size)),zip.readUInt32LE(position+16));position+=46+length;}
  assert.equal(names[0],'manifest.json');assert.equal(names.length,new Set(names).size);assert.ok(names.length>=2);
});
test('care requests remain available after delivery and customer cannot resolve them',async()=>{
  await post(`/api/projects/${projectId}/care`,{title:'Contact update',body:'Change the office phone number.'},customer);const c=(await detail()).care[0];
  assert.equal((await post(`/api/projects/${projectId}/care/${c.id}/resolve`,{},customer)).status,403);
  assert.equal((await post(`/api/projects/${projectId}/care/${c.id}/resolve`)).status,200);
  assert.equal((await detail()).care[0].status,'resolved');
});
test('rotating customer invitation revokes the old session',async()=>{
  await post(`/api/projects/${projectId}/invite`);assert.equal((await request('/api/me',{auth:customer})).status,401);
});
test('database and source artifacts survive restarting the application',async()=>{
  await new Promise(r=>app.server.close(r));
  app=createApp({dataDir,password:'This-does-not-reset-the-existing-password',workerToken});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;
  operator=await login();const d=await detail();assert.equal(d.project.stage,'complete');assert.equal(d.files.length,3);assert.equal(d.quotes.find(q=>q.status==='accepted').cents,350000);
  const f=d.files.find(f=>f.has_pdf);assert.equal((await request(`/api/projects/${projectId}/files/${f.id}/pdf`,{auth:operator})).status,200);
});
