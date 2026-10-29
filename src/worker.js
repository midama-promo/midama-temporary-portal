const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const STATUS = ['Submitted', 'Approved', 'Denied', 'Delivered', 'Corrections required'];
const uuid = () => crypto.randomUUID();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const sha = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, '0')).join('');
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const readCookie = (request, name) => (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
const body = async (request) => { try { return await request.json(); } catch { return {}; } };
const emailValid = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 255;
async function sendOtp(env, email, code) {
  if (!env.RESEND_API_KEY) throw new Error('Email delivery is not configured yet.');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.RESEND_FROM || 'Mid-Ama Promo <onboarding@resend.dev>', to: [email], subject: 'Your Mid-Ama Promo sign-in code', text: `Your Mid-Ama Promo verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`, html: `<div style="font-family:Arial,sans-serif;background:#101010;color:#fff;padding:32px;border-radius:16px"><h2>Mid-Ama Promo</h2><p>Your one-time sign-in code is:</p><div style="font-size:32px;letter-spacing:8px;font-weight:bold;padding:18px 0">${code}</div><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>` }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}. Check your Resend sender-domain setup.`);
}
async function getUser(request, env) {
  const token = readCookie(request, 'midama_session'); if (!token) return null;
  return env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(await sha(token), Math.floor(Date.now()/1000)).first();
}
function isAdmin(user) { return user?.role === 'admin'; }
async function requireUser(request, env) { const user = await getUser(request, env); return user || null; }
async function canSeeRelease(env, user, id) { return env.DB.prepare('SELECT * FROM releases WHERE id=? AND (?=1 OR user_id=?)').bind(id, isAdmin(user) ? 1 : 0, user.id).first(); }
async function listReleases(env, user, userId) {
  const owner = isAdmin(user) && userId ? userId : user.id;
  const rows = await env.DB.prepare('SELECT * FROM releases WHERE user_id=? ORDER BY created_at DESC').bind(owner).all();
  for (const r of rows.results) r.tracks = (await env.DB.prepare('SELECT id,title,artist_credits,audio_key FROM tracks WHERE release_id=? ORDER BY created_at').bind(r.id).all()).results;
  return rows.results;
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api/health') return json({ ok: true, service: 'midama-portal' });
  if (path === '/api/auth/request-otp' && method === 'POST') {
    const { email: rawEmail } = await body(request), email = String(rawEmail || '').trim().toLowerCase();
    if (!emailValid(email)) return fail('Enter a valid email address.');
    const now = Math.floor(Date.now()/1000), prior = await env.DB.prepare('SELECT last_sent_at FROM otp_codes WHERE email=?').bind(email).first();
    if (prior && now - prior.last_sent_at < 45) return fail('Please wait 45 seconds before requesting another code.', 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.DB.prepare('INSERT INTO otp_codes(email,code_hash,expires_at,attempts,last_sent_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at').bind(email, await sha(email + ':' + code), now + 600, 0, now).run();
    try { await sendOtp(env, email, code); } catch (e) { await env.DB.prepare('DELETE FROM otp_codes WHERE email=?').bind(email).run(); return fail(e.message, 503); }
    return json({ ok: true, message: 'If email delivery is configured, your code is on its way.' });
  }
  if (path === '/api/auth/verify-otp' && method === 'POST') {
    const data = await body(request), email = String(data.email || '').trim().toLowerCase(), code = String(data.code || '').trim();
    if (!emailValid(email) || !/^\d{6}$/.test(code)) return fail('Enter your email and six-digit code.');
    const otp = await env.DB.prepare('SELECT * FROM otp_codes WHERE email=?').bind(email).first(), now = Math.floor(Date.now()/1000);
    if (!otp || otp.expires_at < now || otp.attempts >= 5) return fail('That code expired or is no longer valid. Request a new one.', 401);
    if (await sha(email + ':' + code) !== otp.code_hash) { await env.DB.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE email=?').bind(email).run(); return fail('Incorrect code. Please try again.', 401); }
    await env.DB.prepare('DELETE FROM otp_codes WHERE email=?').bind(email).run();
    const adminEmail = String(env.ADMIN_EMAIL || '').toLowerCase();
    let user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
    if (!user) {
      const role = email === adminEmail ? 'admin' : 'client';
      const id = uuid(); await env.DB.prepare('INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)').bind(id, email, email === adminEmail ? 'Remo' : '', role).run();
      user = { id, email, display_name: email === adminEmail ? 'Remo' : '', role };
    } else if (email === adminEmail && user.role !== 'admin') {
      await env.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(user.id).run(); user.role = 'admin';
    }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha(token), user.id, now + 60*60*24*14).run();
    return json({ ok: true, user: { id:user.id,email:user.email,display_name:user.display_name,role:user.role } }, 200, { 'set-cookie': cookie('midama_session', token, 60*60*24*14) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(request, 'midama_session'); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('midama_session', '', 0) });
  }
  const user = await requireUser(request, env);
  if (path === '/api/me' && method === 'GET') return user ? json({ user }) : fail('Please sign in.', 401);
  if (!user) return fail('Please sign in.', 401);
  if (path === '/api/releases' && method === 'GET') return json({ releases: await listReleases(env, user, url.searchParams.get('userId')) });
  if (path === '/api/releases' && method === 'POST') {
    const d = await body(request); if (!d.title?.trim() || !d.primary_artist?.trim()) return fail('Release title and primary artist are required.');
    const artworkKey = d.artwork_key || null;
    if (artworkKey && !artworkKey.startsWith(`${user.id}/artwork/`)) return fail('Invalid artwork upload reference.');
    const tracks = (Array.isArray(d.tracks) ? d.tracks : []).slice(0, 50).filter(t => t && typeof t.title === 'string' && t.title.trim());
    // Validate every uploaded-file reference before writing the release, so a bad track cannot leave a partial submission.
    if (tracks.some(t => t.audio_key && (typeof t.audio_key !== 'string' || !t.audio_key.startsWith(`${user.id}/audio/`)))) return fail('Invalid audio upload reference.');
    const id = uuid();
    await env.DB.prepare('INSERT INTO releases(id,user_id,title,primary_artist,release_type,release_date,genre,explicit,notes,status,royalty_amount,artwork_key) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)').bind(id,user.id,d.title.trim(),d.primary_artist.trim(),d.release_type || 'Single',d.release_date || null,d.genre || null,d.explicit ? 1 : 0,d.notes || '', 'Submitted',artworkKey).run();
    for (const t of tracks) await env.DB.prepare('INSERT INTO tracks(id,release_id,title,artist_credits,audio_key) VALUES(?,?,?,?,?)').bind(uuid(),id,t.title.trim(),typeof t.artist_credits === 'string' ? t.artist_credits : '',t.audio_key || null).run();
    return json({ ok:true, id }, 201);
  }
  if (path.startsWith('/api/releases/') && method === 'PATCH') {
    if (!isAdmin(user)) return fail('Admin access required.', 403);
    const id = path.split('/')[3], d = await body(request); if (!STATUS.includes(d.status)) return fail('Invalid status.');
    const royalty = Number(d.royalty_amount ?? 0); if (!Number.isFinite(royalty) || royalty < 0) return fail('Royalty must be a non-negative amount.');
    const found = await env.DB.prepare('SELECT id FROM releases WHERE id=?').bind(id).first(); if (!found) return fail('Release not found.',404);
    await env.DB.prepare('UPDATE releases SET status=?,admin_notes=?,royalty_amount=?,updated_at=datetime(\'now\') WHERE id=?').bind(d.status,d.admin_notes || '',royalty,id).run(); return json({ ok:true });
  }
  if (path.startsWith('/api/releases/') && method === 'DELETE') {
    if (!isAdmin(user)) return fail('Admin access required.',403);
    // Intentionally do not delete anything in this temporary portal.
    return fail('Deletion is disabled in the temporary portal. Manage release records through status changes.',403);
  }
  if (path === '/api/admin/clients' && method === 'GET') {
    if (!isAdmin(user)) return fail('Admin access required.',403);
    const clients = await env.DB.prepare("SELECT u.id,u.email,u.display_name,u.created_at,COUNT(r.id) AS release_count FROM users u LEFT JOIN releases r ON r.user_id=u.id WHERE u.role='client' GROUP BY u.id ORDER BY u.created_at DESC").all(); return json({ clients:clients.results });
  }
  if (path === '/api/admin/releases' && method === 'GET') {
    if (!isAdmin(user)) return fail('Admin access required.',403);
    const rows = await env.DB.prepare('SELECT r.*,u.email AS client_email FROM releases r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC').all(); return json({ releases: rows.results });
  }
  if (path === '/api/admin/tickets' && method === 'GET') {
    if (!isAdmin(user)) return fail('Admin access required.',403);
    const rows = await env.DB.prepare('SELECT t.*,u.email AS client_email FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC').all();
    for (const t of rows.results) t.messages = (await env.DB.prepare('SELECT m.*,u.email AS sender_email,u.role AS sender_role FROM ticket_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=? ORDER BY m.created_at').bind(t.id).all()).results;
    return json({ tickets: rows.results });
  }
  if (path === '/api/tickets' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY updated_at DESC').bind(user.id).all();
    for (const t of rows.results) t.messages = (await env.DB.prepare('SELECT m.*,u.email AS sender_email,u.role AS sender_role FROM ticket_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=? ORDER BY m.created_at').bind(t.id).all()).results;
    return json({ tickets:rows.results });
  }
  if (path === '/api/tickets' && method === 'POST') {
    const d = await body(request); if (!d.subject?.trim() || !d.message?.trim()) return fail('Ticket subject and message are required.');
    const id=uuid(); await env.DB.prepare('INSERT INTO tickets(id,user_id,subject) VALUES(?,?,?)').bind(id,user.id,d.subject.trim()).run(); await env.DB.prepare('INSERT INTO ticket_messages(id,ticket_id,sender_id,message) VALUES(?,?,?,?)').bind(uuid(),id,user.id,d.message.trim()).run();
    if (env.RESEND_API_KEY && env.ADMIN_EMAIL) { try { await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.RESEND_FROM||'Mid-Ama Promo <onboarding@resend.dev>',to:[env.ADMIN_EMAIL],subject:`Support ticket: ${d.subject.trim()}`,text:`From: ${user.email}\nTicket: ${id}\n\n${d.message.trim()}`})}); } catch {} }
    return json({ ok:true,id },201);
  }
  const ticketMatch = path.match(/^\/api\/tickets\/([^/]+)\/messages$/);
  if (ticketMatch && method === 'POST') {
    const ticket = await env.DB.prepare('SELECT * FROM tickets WHERE id=? AND (?=1 OR user_id=?)').bind(ticketMatch[1],isAdmin(user)?1:0,user.id).first(); if (!ticket) return fail('Ticket not found.',404);
    const d=await body(request); if (!d.message?.trim()) return fail('Message is required.');
    await env.DB.prepare('INSERT INTO ticket_messages(id,ticket_id,sender_id,message) VALUES(?,?,?,?)').bind(uuid(),ticket.id,user.id,d.message.trim()).run();
    await env.DB.prepare("UPDATE tickets SET updated_at=datetime('now'),status=CASE WHEN ?='admin' AND status='Open' THEN 'In progress' ELSE status END WHERE id=?").bind(user.role,ticket.id).run();
    return json({ok:true},201);
  }
  if (path.startsWith('/api/tickets/') && method === 'PATCH' && isAdmin(user)) {
    const id=path.split('/')[3], d=await body(request); if (!['Open','In progress','Resolved'].includes(d.status)) return fail('Invalid ticket status.');
    await env.DB.prepare("UPDATE tickets SET status=?,updated_at=datetime('now') WHERE id=?").bind(d.status,id).run(); return json({ok:true});
  }
  if (path.startsWith('/api/admin/clients/') && path.endsWith('/view') && method === 'GET') {
    if (!isAdmin(user)) return fail('Admin access required.',403); const clientId=path.split('/')[4];
    const client=await env.DB.prepare("SELECT id,email,display_name,role FROM users WHERE id=? AND role='client'").bind(clientId).first(); if(!client) return fail('Client not found.',404);
    return json({client,releases:await listReleases(env,user,clientId)});
  }
  if (path === '/api/upload' && method === 'POST') {
    const form=await request.formData(), file=form.get('file'), kind=String(form.get('kind')||'audio');
    if (!(file instanceof File) || file.size > 100*1024*1024) return fail('Choose a file smaller than 100 MB.');
    if (!['audio','artwork'].includes(kind)) return fail('Invalid file type.');
    const allowed = kind==='audio' ? ['audio/mpeg','audio/wav','audio/flac','audio/x-wav','audio/mp4'] : ['image/jpeg','image/png','image/webp'];
    if (!allowed.includes(file.type)) return fail(`Unsupported ${kind} file type.`);
    const key=`${user.id}/${kind}/${uuid()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100)}`;
    await env.R2.put(key,file.stream(),{httpMetadata:{contentType:file.type},customMetadata:{ownerId:user.id,originalName:file.name}});
    return json({ok:true,key,name:file.name,size:file.size,type:file.type},201);
  }
  return fail('Not found.',404);
}
export default {
 async fetch(request, env) {
  if (new URL(request.url).pathname.startsWith('/api/')) {
    try { return await route(request,env); } catch (e) { console.error('API error',e); return fail('Unexpected server error. Check Worker logs.',500); }
  }
  return env.ASSETS.fetch(request);
 }
};
