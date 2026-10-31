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
const validProfileUrl = (value, hosts) => { if(!value) return true; try { const u=new URL(value); return u.protocol==='https:' && hosts.some(h=>u.hostname===h || u.hostname.endsWith('.'+h)); } catch { return false; } };
async function sendOtp(env, email, code) {
  if (!env.RESEND_API_KEY) throw new Error('Email delivery is not configured yet.');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.RESEND_FROM || 'Mid-Ama Promo <onboarding@resend.dev>', to: [email], subject: 'Your Mid-Ama Promo sign-in code', text: `Your Mid-Ama Promo verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`, html: `<div style="font-family:Arial,sans-serif;background:#101010;color:#fff;padding:32px;border-radius:16px"><h2>Mid-Ama Promo</h2><p>Your one-time sign-in code is:</p><div style="font-size:32px;letter-spacing:8px;font-weight:bold;padding:18px 0">${code}</div><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>` }) });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}. Check your Resend sender-domain setup.`);
}
async function getUser(request, env) {
  const token = readCookie(request, 'midama_session'); if (!token) return null;
  return env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.first_name,u.surname,u.primary_artist_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(await sha(token), Math.floor(Date.now()/1000)).first();
}
function isAdmin(user) { return user?.role === 'admin'; }
async function requireUser(request, env) { const user = await getUser(request, env); return user || null; }
async function canSeeRelease(env, user, id) { return env.DB.prepare('SELECT * FROM releases WHERE id=? AND (?=1 OR user_id=?)').bind(id, isAdmin(user) ? 1 : 0, user.id).first(); }
async function listReleases(env, user, userId) {
  const owner = isAdmin(user) && userId ? userId : user.id;
  const rows = await env.DB.prepare('SELECT * FROM releases WHERE user_id=? ORDER BY created_at DESC').bind(owner).all();
  for (const r of rows.results) r.tracks = (await env.DB.prepare('SELECT id,title,artist_credits,audio_key,composers,featured_artists,spotify_profile_url,apple_music_profile_url,spotify_creation_requested,apple_creation_requested FROM tracks WHERE release_id=? ORDER BY created_at').bind(r.id).all()).results;
  return rows.results;
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api/health') return json({ ok: true, service: 'midama-portal' });
  if (path === '/api/auth/request-otp' && method === 'POST') {
    const registration = await body(request), rawEmail = registration.email, email = String(rawEmail || '').trim().toLowerCase();
    const firstName=String(registration.first_name||'').trim(), surname=String(registration.surname||'').trim(), primaryArtist=String(registration.primary_artist_name||'').trim();
    if ((firstName || surname || primaryArtist) && (!firstName || !surname || !primaryArtist)) return fail('Enter your real first name, surname and primary artist name.');
    if (!emailValid(email)) return fail('Enter a valid email address.');
    const existingAccount=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (!existingAccount && (!firstName || !surname || !primaryArtist)) return fail('New accounts require your real first name, surname and primary artist name.');
    const now = Math.floor(Date.now()/1000), prior = await env.DB.prepare('SELECT last_sent_at FROM otp_codes WHERE email=?').bind(email).first();
    if (prior && now - prior.last_sent_at < 45) return fail('Please wait 45 seconds before requesting another code.', 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.DB.prepare('INSERT INTO otp_codes(email,code_hash,expires_at,attempts,last_sent_at,first_name,surname,primary_artist_name) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at,first_name=excluded.first_name,surname=excluded.surname,primary_artist_name=excluded.primary_artist_name').bind(email, await sha(email + ':' + code), now + 600, 0, now, firstName, surname, primaryArtist).run();
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
      const id = uuid(); const first=otp.first_name||'', last=otp.surname||'', artist=otp.primary_artist_name||'';
      await env.DB.prepare('INSERT INTO users(id,email,display_name,role,first_name,surname,primary_artist_name) VALUES(?,?,?,?,?,?,?)').bind(id,email,[first,last].filter(Boolean).join(' ') || (email===adminEmail?'Remo':''),role,first,last,artist).run();
      user = { id,email,display_name:[first,last].filter(Boolean).join(' ') || (email===adminEmail?'Remo':''),first_name:first,surname:last,primary_artist_name:artist,role };
    } else if (email === adminEmail && user.role !== 'admin') {
      await env.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(user.id).run(); user.role = 'admin';
    }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha(token), user.id, now + 60*60*24*14).run();
    return json({ ok: true, user: { id:user.id,email:user.email,display_name:user.display_name,first_name:user.first_name||'',surname:user.surname||'',primary_artist_name:user.primary_artist_name||'',role:user.role } }, 200, { 'set-cookie': cookie('midama_session', token, 60*60*24*14) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(request, 'midama_session'); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('midama_session', '', 0) });
  }
  const user = await requireUser(request, env);
  if (path === '/api/me' && method === 'GET') return user ? json({ user }) : fail('Please sign in.', 401);
  if (!user) return fail('Please sign in.', 401);
  if (path === '/api/releases' && method === 'GET') return json({ releases: await listReleases(env, user, url.searchParams.get('userId')) });
  if (path === '/api/artists' && method === 'GET') return json({artists:(await env.DB.prepare('SELECT * FROM artists WHERE user_id=? ORDER BY artist_name').bind(user.id).all()).results});
  if (path === '/api/artists' && method === 'POST') { const d=await body(request); if(!d.artist_name?.trim()) return fail('Artist name is required.'); if(!d.spotify_url && !d.spotify_creation_requested) return fail('Provide a Spotify profile link or request a new Spotify profile.'); if(!d.apple_music_url && !d.apple_creation_requested) return fail('Provide an Apple Music profile link or request a new Apple Music profile.'); if(!validProfileUrl(d.spotify_url,['spotify.com']) || !validProfileUrl(d.apple_music_url,['apple.com'])) return fail('Use valid HTTPS Spotify and Apple Music profile URLs.'); const id=uuid(); try { await env.DB.prepare('INSERT INTO artists(id,user_id,artist_name,spotify_url,apple_music_url,spotify_creation_requested,apple_creation_requested) VALUES(?,?,?,?,?,?,?)').bind(id,user.id,d.artist_name.trim(),d.spotify_url||null,d.apple_music_url||null,d.spotify_creation_requested?1:0,d.apple_creation_requested?1:0).run(); } catch { return fail('That artist is already in your library.'); } return json({ok:true,id},201); }
  if (path.startsWith('/api/artists/') && method==='DELETE') { const id=path.split('/')[3]; await env.DB.prepare('DELETE FROM artists WHERE id=? AND user_id=?').bind(id,user.id).run(); return json({ok:true}); }
  if (path === '/api/drafts' && method==='GET') return json({drafts:(await env.DB.prepare('SELECT id,draft_json,updated_at FROM release_drafts WHERE user_id=? ORDER BY updated_at DESC').bind(user.id).all()).results});
  if (path === '/api/drafts' && method==='POST') { const d=await body(request); if(!d.draft || typeof d.draft!=='object') return fail('Draft data is required.'); const id=d.id||uuid(); await env.DB.prepare("INSERT INTO release_drafts(id,user_id,draft_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=datetime('now') WHERE release_drafts.user_id=excluded.user_id").bind(id,user.id,JSON.stringify(d.draft)).run(); return json({ok:true,id},201); }

  if (path === '/api/releases' && method === 'POST') {
    const d = await body(request); if (!d.title?.trim() || !d.primary_artist?.trim()) return fail('Release title and primary artist are required.');
    if (!d.rights_confirmed) return fail('You must confirm that you own or have permission to distribute all submitted material.');
    if (!d.release_date) return fail('Choose a release date at least seven full days ahead.');
    if (d.release_date) { const min=new Date(); min.setHours(0,0,0,0); min.setDate(min.getDate()+7); const chosen=new Date(`${d.release_date}T00:00:00`); if (Number.isNaN(chosen.getTime()) || chosen<min) return fail('Release date must be at least seven full days after submission.'); }
    const artworkKey = d.artwork_key || null;
    if (typeof artworkKey!=='string' || !artworkKey) return fail('A valid cover artwork upload is required.');
    const spotifyProfiles=Array.isArray(d.spotify_profiles)?d.spotify_profiles:[], appleProfiles=Array.isArray(d.apple_profiles)?d.apple_profiles:[];
    if (!spotifyProfiles.every(u=>validProfileUrl(u,['spotify.com'])) || !appleProfiles.every(u=>validProfileUrl(u,['apple.com']))) return fail('Enter valid Spotify and Apple Music artist profile URLs.');
    if (artworkKey && !artworkKey.startsWith(`${user.id}/artwork/`)) return fail('Invalid artwork upload reference.');
    const tracks = (Array.isArray(d.tracks) ? d.tracks : []).filter(t => t && typeof t.title === 'string' && t.title.trim());
    // Validate every uploaded-file reference before writing the release, so a bad track cannot leave a partial submission.
    if (!tracks.length) return fail('Add at least one track.');
    if (tracks.some(t => !Array.isArray(t.composers) || !t.composers.length || t.composers.some(n => typeof n!=='string' || n.trim().split(/\s+/).length<2))) return fail('Every track requires each composer’s full real name and surname.');
    for (let i=0;i<tracks.length;i++) { const t=tracks[i], artist=t.artist_credits?.trim()||d.primary_artist; const spotify=t.spotify_profile_url||spotifyProfiles[0], apple=t.apple_music_profile_url||appleProfiles[0]; if(!spotify && !t.spotify_creation_requested && !d.spotify_creation_requested) return fail(`Track #${i+1} artist \"${artist}\" needs a Spotify profile link or creation request.`); if(!apple && !t.apple_creation_requested && !d.apple_creation_requested) return fail(`Track #${i+1} artist \"${artist}\" needs an Apple Music profile link or creation request.`); if(!validProfileUrl(spotify,['spotify.com']) || !validProfileUrl(apple,['apple.com'])) return fail(`Track #${i+1} has an invalid Spotify or Apple Music profile URL.`); }
    if (tracks.some(t => !t.audio_key || typeof t.audio_key !== 'string' || !t.audio_key.startsWith(`${user.id}/audio/`))) return fail('Every track requires a valid MP3 upload.');
    const id = uuid();
    await env.DB.prepare('INSERT INTO releases(id,user_id,title,primary_artist,release_type,release_date,genre,explicit,notes,status,royalty_amount,artwork_key,rights_confirmed,spotify_creation_requested,apple_creation_requested,featured_artists,spotify_profiles,apple_profiles) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)').bind(id,user.id,d.title.trim(),d.primary_artist.trim(),d.release_type || 'Single',d.release_date || null,d.genre || null,d.explicit ? 1 : 0,d.notes || '', 'Submitted',artworkKey,1,d.spotify_creation_requested?1:0,d.apple_creation_requested?1:0,JSON.stringify(Array.isArray(d.featured_artists)?d.featured_artists:[]),JSON.stringify(spotifyProfiles),JSON.stringify(appleProfiles)).run();
    for (const t of tracks) await env.DB.prepare('INSERT INTO tracks(id,release_id,title,artist_credits,audio_key,composers,featured_artists,spotify_profile_url,apple_music_profile_url,spotify_creation_requested,apple_creation_requested) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(uuid(),id,t.title.trim(),typeof t.artist_credits === 'string' ? t.artist_credits : '',t.audio_key || null,JSON.stringify(t.composers||[]),JSON.stringify(t.featured_artists||[]),t.spotify_profile_url||null,t.apple_music_profile_url||null,t.spotify_creation_requested?1:0,t.apple_creation_requested?1:0).run();
    return json({ ok:true, id }, 201);
  }
  if (path.startsWith('/api/releases/') && method === 'PATCH') {
    if (!isAdmin(user)) return fail('Admin access required.', 403);
    const id = path.split('/')[3], d = await body(request); if (!STATUS.includes(d.status)) return fail('Invalid status.');
    const royalty = Number(d.royalty_amount ?? 0); if (!Number.isFinite(royalty) || royalty < 0) return fail('Royalty must be a non-negative amount.');
    if (d.presave_url && !/^https:\/\//i.test(d.presave_url)) return fail('Pre-save links must use HTTPS.');
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
    const clients = await env.DB.prepare("SELECT u.id,u.email,u.display_name,u.first_name,u.surname,u.primary_artist_name,u.created_at,COUNT(r.id) AS release_count FROM users u LEFT JOIN releases r ON r.user_id=u.id WHERE u.role='client' GROUP BY u.id ORDER BY u.created_at DESC").all(); return json({ clients:clients.results });
  }
  if (path === '/api/admin/releases' && method === 'GET') {
    if (!isAdmin(user)) return fail('Admin access required.',403);
    const rows = await env.DB.prepare('SELECT r.*,u.email AS client_email,u.first_name AS client_first_name,u.surname AS client_surname,u.primary_artist_name AS client_primary_artist FROM releases r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC').all();
    for (const r of rows.results) r.tracks=(await env.DB.prepare('SELECT id,title,artist_credits,audio_key,composers,featured_artists,spotify_profile_url,apple_music_profile_url,spotify_creation_requested,apple_creation_requested FROM tracks WHERE release_id=? ORDER BY created_at').bind(r.id).all()).results;
    return json({ releases: rows.results });
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
    const client=await env.DB.prepare("SELECT id,email,display_name,first_name,surname,primary_artist_name,role FROM users WHERE id=? AND role='client'").bind(clientId).first(); if(!client) return fail('Client not found.',404);
    await env.DB.prepare('INSERT INTO admin_access_audit(id,admin_user_id,client_user_id) VALUES(?,?,?)').bind(uuid(),user.id,clientId).run();
    return json({client,releases:await listReleases(env,user,clientId)});
  }
  if (path === '/api/files' && method === 'GET') {
    const key=url.searchParams.get('key'); if(!key) return fail('File key is required.');
    const owned=await env.DB.prepare('SELECT r.id FROM releases r LEFT JOIN tracks t ON t.release_id=r.id WHERE r.user_id=? AND (r.artwork_key=? OR t.audio_key=?)').bind(user.id,key,key).first();
    const adminOwned=isAdmin(user)?await env.DB.prepare('SELECT r.id FROM releases r LEFT JOIN tracks t ON t.release_id=r.id WHERE r.artwork_key=? OR t.audio_key=?').bind(key,key).first():null;
    if(!owned && !adminOwned) return fail('File not found.',404);
    if(!env.R2.signedUrl) return fail('Secure file downloads are not configured.',503);
    return new Response(null,{status:302,headers:{Location:await env.R2.signedUrl(key,300),'Cache-Control':'no-store'}});
  }
  if (path === '/api/upload' && method === 'POST') {
    const form=await request.formData(), file=form.get('file'), kind=String(form.get('kind')||'audio');
    if (!(file instanceof File) || file.size > 100*1024*1024) return fail('Choose a file smaller than 100 MB.');
    if (!['audio','artwork'].includes(kind)) return fail('Invalid file type.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if (kind==='audio') {
      const isMp3=(bytes.length>3 && bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33) || (bytes.length>2 && bytes[0]===0xff && (bytes[1]&0xe0)===0xe0);
      if (!isMp3) return fail('Audio uploads must be genuine MP3 files.');
    } else {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return fail('Artwork must be JPG, PNG or WebP.');
      let w=0,h=0;
      if (file.type==='image/png' && bytes.length>24) { w=new DataView(bytes.buffer).getUint32(16); h=new DataView(bytes.buffer).getUint32(20); }
      else if (file.type==='image/jpeg') { let i=2; while(i<bytes.length-9){ if(bytes[i]!==0xff){i++;continue;} const marker=bytes[i+1],len=(bytes[i+2]<<8)|bytes[i+3]; if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){h=(bytes[i+5]<<8)|bytes[i+6];w=(bytes[i+7]<<8)|bytes[i+8];break;} if(!len)break;i+=2+len; } }
      else if (file.type==='image/webp' && bytes.length>30) { const kind=String.fromCharCode(...bytes.slice(12,16)); if(kind==='VP8X'){w=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);h=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);} }
      if (!w || !h || w!==h || w<3000 || w>3500) return fail('Artwork must be square and between 3000 × 3000 and 3500 × 3500 pixels.');
    }
    const key=`${user.id}/${kind}/${uuid()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100)}`;
    await env.R2.put(key,bytes,{httpMetadata:{contentType:kind==='audio'?'audio/mpeg':file.type},customMetadata:{ownerId:user.id,originalName:file.name}});
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
