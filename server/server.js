// Static: matchmaking + match relay server. No dependencies; run with `node server.js`.
// Players connect over WebSocket. The server groups whoever is searching into a room (up to 6),
// starts the match, and passes messages between them. One player's game runs the match;
// if that player leaves, the server hands the match to another player.
'use strict';
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 10000, MAXMSG = 64 * 1024, ORDER = [0, 3, 1, 4, 2, 5], WIN = 15;

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
let waiting = null, rooms = new Set(), online = 0;
function newRoom() { const r = { members: [], started: false, cd: -1, host: null, timer: null }; rooms.add(r); return r; }
function lobby(r) { r.members.forEach((m, i) => m.c.send({ t: 'lobby', n: r.members.length, cd: r.cd, first: i === 0 })); }
function tickLobby(r) {
  if (r.started || r.cd <= 0) return;
  r.cd -= 1;
  if (r.cd <= 0) start(r); else lobby(r);
}
function start(r) {
  if (r.started || r.members.length < 2) return;
  r.started = true; clearInterval(r.timer); r.timer = null; if (waiting === r) waiting = null;
  const list = [null, null, null, null, null, null];
  r.members.forEach((m, i) => { m.slot = ORDER[i]; list[m.slot] = { load: m.load }; });
  r.host = r.members[0];
  r.members.forEach(m => m.c.send({ t: 'start', list, you: m.slot, win: WIN, host: m === r.host }));
}
function leave(m) {
  const r = m.room; if (!r) return; m.room = null;
  const i = r.members.indexOf(m); if (i >= 0) r.members.splice(i, 1);
  if (!r.members.length) { clearInterval(r.timer); rooms.delete(r); if (waiting === r) waiting = null; return; }
  if (!r.started) { if (r.members.length < 2) r.cd = -1; lobby(r); return; }
  if (r.host === m) {                                   // hand the match to someone still here
    r.host = r.members[0];
    r.host.c.send({ t: 'host', humans: r.members.map(x => x.slot) });
  } else r.host.c.send({ t: 'left', s: m.slot });
}
function cleanLoad(l) {
  const s = v => (typeof v === 'string' ? v.slice(0, 24) : ''), d = (l && l.drs) || {};
  l = l || {};
  return { c: s(l.c), js: s(l.js), dk: s(l.dk), drs: { f: s(d.f), l: s(d.l), r: s(d.r), b: s(d.b), n: s(d.n) } };
}
function onMessage(m, d) {
  const r = m.room;
  if (d.t === 'ping') return;
  if (d.t === 'find') {
    if (r) return;
    if (!waiting || waiting.started || waiting.members.length >= 6) waiting = newRoom();
    const w = waiting; m.room = w; m.load = cleanLoad(d.load); w.members.push(m);
    if (w.members.length === 2) { w.cd = 10; w.timer = setInterval(() => tickLobby(w), 1000); }
    else if (w.members.length > 2) w.cd = Math.max(w.cd, 5);
    if (w.members.length >= 6) start(w); else lobby(w);
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
  const m = { room: null, slot: -1, load: null, c: null };
  online++;
  m.c = attach(sock, d => onMessage(m, d), () => { online--; clearInterval(beat); leave(m); });
  const beat = setInterval(() => { if (!m.c.alive) { m.c.close(); return; } m.c.alive = false; m.c.ping(); }, 30000);
});
server.listen(PORT, () => console.log('Static server listening on ' + PORT));
