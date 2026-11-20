// Static: matchmaking + match relay server. No dependencies; run with `node server.js`.
// Players connect over WebSocket. The server groups whoever is searching into a room (up to 6),
// starts the match, and passes messages between them. One player's game runs the match;
// if that player leaves, the server hands the match to another player.
'use strict';
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 10000, MAXMSG = 64 * 1024, WIN = 21, WAIT = +process.env.WAIT || 20;   // seconds a search waits before the CPU fills the match

/* ---------- tiny WebSocket layer ---------- */
function frame(op, buf) {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, buf]);
}
function attach(sock, onMsg, onClose) {
  let buf = Buffer.alloc(0), parts = [], partLen = 0, dead = false;
  const c = {
    alive: true,
    send(o) { if (!dead) try { sock.write(frame(1, Buffer.from(JSON.stringify(o)))); } catch (e) {} },
    ping() { if (!dead) try { sock.write(frame(9, Buffer.alloc(0))); } catch (e) {} },
    close() { if (dead) return; dead = true; try { sock.end(frame(8, Buffer.alloc(0))); } catch (e) {} sock.destroy(); onClose(); }
  };
  sock.setNoDelay(true);
  sock.on('data', d => {
    if (dead) return;
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2)) return c.close(); len = buf.readUInt32BE(6); off = 10; }
      if (!masked || len > MAXMSG) return c.close();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return c.close();
      if (op === 9) { try { sock.write(frame(10, data)); } catch (e) {} continue; }
      if (op === 10) { c.alive = true; continue; }
      if (op !== 0 && op !== 1) return c.close();           // text only
      parts.push(data); partLen += len;
      if (partLen > MAXMSG) return c.close();
      if (fin) {
        const txt = Buffer.concat(parts).toString('utf8'); parts = []; partLen = 0; c.alive = true;
        let m = null; try { m = JSON.parse(txt); } catch (e) {}
        if (m && typeof m === 'object') { try { onMsg(m); } catch (e) { console.error(e); } }
      }
    }
  });
  sock.on('close', () => { if (!dead) { dead = true; onClose(); } });
  sock.on('error', () => { if (!dead) { dead = true; sock.destroy(); onClose(); } });
  return c;
}

/* ---------- rooms ---------- */
const rooms = new Set(); let online = 0, partySeq = 0;
const byCode = new Map();                                // player code -> connected player
function newRoom() { const r = { members: [], started: false, cd: -1, host: null, timer: null }; rooms.add(r); return r; }
function codeOf(pid) { return crypto.createHash('sha256').update('static:' + pid).digest('hex').slice(0, 8).toUpperCase(); }
function cleanName(v) { return (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f<>&]/g, '').slice(0, 18) || 'Player'; }
function cleanIcon(v) { v = v | 0; return v >= 0 && v < 64 ? v : 0; }
function cleanText(v) { return (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140); }
function pub(m) { return { code: m.code, name: m.name, icon: m.icon, bn: m.bn, c: m.load ? m.load.c : '' }; }

/* a lobby (party): up to 3 friends who queue together and play on the same team */
function partyTell(p) { const list = p.members.map(pub); p.members.forEach(x => x.c.send({ t: 'party', leader: p.members[0].code, list })); }
function partyLeave(m) {
  const p = m.party; if (!p) return; m.party = null;
  const i = p.members.indexOf(m); if (i >= 0) p.members.splice(i, 1);
  m.c.send({ t: 'party', leader: '', list: [] });
  if (p.members.length <= 1) { p.members.forEach(x => { x.party = null; x.c.send({ t: 'party', leader: '', list: [] }); }); p.members = []; }
  else partyTell(p);
}

/* teams: people who queued together stay together; everyone else goes where there are fewer real players */
function teamsFor(members, size) {
  size = size === 3 ? 3 : 5;
  const groups = new Map();
  members.forEach(m => { const k = m.party && m.party.members.length > 1 ? 'p' + m.party.id : 's' + m.uid; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
  const gs = [...groups.values()].sort((a, b) => b.length - a.length), teams = [[], []];
  for (const g of gs) {
    const first = teams[0].length <= teams[1].length ? 0 : 1, t = teams[first].length + g.length <= size ? first : (teams[1 - first].length + g.length <= size ? 1 - first : -1);
    if (t < 0) return null;
    teams[t].push(...g);
  }
  return teams;
}
function fits(r, group, size) { return !r.started && r.size === size && r.members.length + group.length <= size * 2 && !!teamsFor(r.members.concat(group), size); }
function join(r, group) {                                // put players into a room that has not started
  group.forEach(m => { m.room = r; r.members.push(m); });
  if (r.members.length >= 1 && r.cd <= 0) { r.cd = WAIT; clearInterval(r.timer); r.timer = setInterval(() => tickLobby(r), 1000); }   // the match starts 30 seconds after the first player arrives; the CPU fills every empty spot
  if (r.members.length >= r.size * 2) start(r); else lobby(r);
}
function lobby(r) { r.members.forEach((m, i) => m.c.send({ t: 'lobby', n: r.members.length, cd: r.cd, first: i === 0 })); }
function tickLobby(r) {
  if (r.started || r.cd <= 0) return;
  r.cd -= 1;
  if (r.cd <= 0) start(r); else lobby(r);
}
function start(r) {
  if (r.started || r.members.length < 1) return;
  const teams = teamsFor(r.members, r.size); if (!teams) return;
  r.started = true; clearInterval(r.timer); r.timer = null;
  const list = []; for (let i = 0; i < r.size * 2; i++) list.push(null);
  teams.forEach((tm, ti) => tm.forEach((m, i) => { m.slot = ti * r.size + i; list[m.slot] = { load: m.load, name: m.name, icon: m.icon, bn: m.bn }; }));
  r.host = r.members[0];
  const seed = Math.floor(Math.random() * 1000000);     // picks the map, the same for everyone
  r.members.forEach(m => m.c.send({ t: 'start', list, you: m.slot, win: WIN, host: m === r.host, seed }));
}
function leave(m) {
  const r = m.room; if (!r) return; m.room = null;
  const i = r.members.indexOf(m); if (i >= 0) r.members.splice(i, 1);
  if (!r.members.length) { clearInterval(r.timer); rooms.delete(r); return; }
  if (!r.started) { lobby(r); return; }
  if (r.host === m) {                                   // hand the match to someone still here
    r.host = r.members[0];
    r.host.c.send({ t: 'host', humans: r.members.map(x => x.slot) });
  } else r.host.c.send({ t: 'left', s: m.slot });
}
function cleanLoad(l) {
  const s = v => (typeof v === 'string' ? v.slice(0, 24) : ''), d = (l && l.drs) || {};
  l = l || {};
  return { c: s(l.c), js: s(l.js), dk: s(l.dk), em: s(l.em), bb: s(l.bb), drs: { f: s(d.f), l: s(d.l), r: s(d.r), b: s(d.b), n: s(d.n) } };
}
function onMessage(m, d) {
  const r = m.room;
  if (d.t === 'ping') return;
  if (d.t === 'hello') {                                 // who this is: the private id never leaves the server, friends see only the code
    if (m.code || typeof d.pid !== 'string' || d.pid.length < 16 || d.pid.length > 64) return;
    m.code = codeOf(d.pid); m.name = cleanName(d.name); m.icon = cleanIcon(d.icon); m.bn = cleanIcon(d.bn);
    byCode.set(m.code, m); m.c.send({ t: 'you', code: m.code });
    return;
  }
  if (d.t === 'prof') { m.name = cleanName(d.name); m.icon = cleanIcon(d.icon); m.bn = cleanIcon(d.bn); return; }
  if (d.t === 'friends') {
    const codes = Array.isArray(d.codes) ? d.codes.slice(0, 50) : [];
    m.flist = new Set(codes.filter(c => typeof c === 'string'));
    (Array.isArray(d.pend) ? d.pend.slice(0, 40) : []).forEach(c => { const x = typeof c === 'string' ? byCode.get(c) : null; if (x && x.flist.has(m.code)) m.c.send({ t: 'fadd', from: pub(x) }); });   // requests accepted while you were away
    m.c.send({ t: 'fstat', list: codes.filter(c => typeof c === 'string' && c.length === 8).map(c => {
      const x = byCode.get(c); return x ? { code: c, on: 1, name: x.name, icon: x.icon, bn: x.bn, busy: x.room && x.room.started ? 1 : 0 } : { code: c, on: 0 };
    }) });
    return;
  }
  if (d.t === 'search') {                                // find players who are online now by name
    const q = (typeof d.q === 'string' ? d.q : '').trim().toLowerCase().slice(0, 18), list = [];
    if (q.length >= 2) for (const x of byCode.values()) { if (x !== m && x.name.toLowerCase().includes(q)) { list.push({ code: x.code, name: x.name, icon: x.icon }); if (list.length >= 10) break; } }
    m.c.send({ t: 'found', list });
    return;
  }
  if (d.t === 'freq') {                                  // friend request: the other player has to accept
    const x = typeof d.to === 'string' ? byCode.get(d.to) : null, now = Date.now(); m.reqT = m.reqT.filter(v => now - v < 30000);
    if (!m.code || !x || x === m || m.reqT.length >= 8) return;
    m.reqT.push(now); x.c.send({ t: 'freq', from: pub(m) });
    return;
  }
  if (d.t === 'fok') {                                   // request accepted: tell the asker if they are here
    const x = typeof d.to === 'string' ? byCode.get(d.to) : null;
    if (m.code) m.flist.add(String(d.to || '').slice(0, 8));
    if (m.code && x && x !== m) x.c.send({ t: 'fadd', from: pub(m) });
    return;
  }
  if (d.t === 'load') { const was = m.load ? m.load.c : ''; m.load = cleanLoad(d.load); if (m.party && m.load.c !== was) partyTell(m.party); return; }
  if (d.t === 'invite') {                                // ask a friend into your lobby
    const x = typeof d.to === 'string' ? byCode.get(d.to) : null;
    if (!m.code || !x || x === m || r || (x.room && x.room.started) || (m.party && m.party.members.length >= 3) || (m.party && m.party.members.indexOf(x) >= 0)) { m.c.send({ t: 'noinvite' }); return; }
    m.inv.set(x.code, Date.now()); m.load = cleanLoad(d.load);
    x.c.send({ t: 'invited', from: pub(m) });
    return;
  }
  if (d.t === 'accept') {
    const x = typeof d.from === 'string' ? byCode.get(d.from) : null, at = x && m.code ? x.inv.get(m.code) : 0;
    if (!x || !at || Date.now() - at > 120000 || x.room || (r && r.started) || (x.party && x.party.members.length >= 3)) { m.c.send({ t: 'nojoin' }); return; }
    x.inv.delete(m.code);
    if (r) leave(m);
    if (m.party) partyLeave(m);
    if (!x.party) { x.party = { id: ++partySeq, members: [x] }; }
    x.party.members.push(m); m.party = x.party; m.load = cleanLoad(d.load);
    partyTell(x.party);
    return;
  }
  if (d.t === 'pleave') { partyLeave(m); return; }
  if (d.t === 'msg') {                                   // a chat line to one online player
    const now = Date.now(); m.msgT = m.msgT.filter(v => now - v < 5000);
    const x = typeof d.to === 'string' ? byCode.get(d.to) : null, text = cleanText(d.text);
    if (!m.code || !text || m.msgT.length >= 6) return;
    m.msgT.push(now);
    if (!x || x === m) { m.c.send({ t: 'msgfail', to: String(d.to || '').slice(0, 8) }); return; }
    x.c.send({ t: 'msg', from: pub(m), text });
    return;
  }
  if (d.t === 'leave') { if (r) leave(m); return; }
  if (d.t === 'find') {
    if (r) return;
    m.load = cleanLoad(d.load);
    let group = [m];
    if (m.party && m.party.members.length > 1) {
      if (m.party.members[0] !== m) { m.c.send({ t: 'nolead' }); return; }
      group = m.party.members.filter(x => !x.room);      // the whole lobby queues together
    }
    const size = d.size === 3 ? 3 : 5;                    // 3v3 and 5v5 queue separately
    let room = null;
    for (const q of rooms) if (fits(q, group, size)) { room = q; break; }
    if (!room) { room = newRoom(); room.size = size; }
    join(room, group);
    return;
  }
  if (!r) return;
  if (d.t === 'startnow') { if (!r.started && r.members[0] === m) start(r); return; }
  if (!r.started) return;
  if (m === r.host) {
    if (d.t === 'c') { for (const x of r.members) if (x !== m) x.c.send(d.d); }
    else if (d.t === 'to') { for (const x of r.members) if (x.slot === d.s && x !== m) x.c.send(d.d); }
  } else if (d.t === 'i') r.host.c.send({ t: 'i', s: m.slot, I: d.I });
}

/* ---------- http + upgrade ---------- */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('Static server is up. Players online: ' + online + '. Matches: ' + [...rooms].filter(r => r.started).length + '.\n');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const m = { uid: ++partySeq, room: null, slot: -1, load: cleanLoad(null), c: null, code: '', name: 'Player', icon: 0, bn: 0, inv: new Map(), party: null, msgT: [], reqT: [], flist: new Set() };
  online++;
  m.c = attach(sock, d => onMessage(m, d), () => { online--; clearInterval(beat); leave(m); partyLeave(m); if (m.code && byCode.get(m.code) === m) byCode.delete(m.code); });
  const beat = setInterval(() => { if (!m.c.alive) { m.c.close(); return; } m.c.alive = false; m.c.ping(); }, 30000);
});
server.listen(PORT, () => console.log('Static server listening on ' + PORT));
