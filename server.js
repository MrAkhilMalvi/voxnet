const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const turnUrls = (process.env.VOXNET_TURN_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

app.post('/api/ice-config', (req, res) => {
  const { deviceToken } = req.body;
  const db = readDb();
  if (!db.users.some((user) => user.deviceToken === deviceToken)) {
    return res.status(401).json({ error: 'Invalid device token.' });
  }

  if (turnUrls.length && (!process.env.VOXNET_TURN_USERNAME || !process.env.VOXNET_TURN_CREDENTIAL)) {
    return res.status(500).json({ error: 'TURN URLs require VOXNET_TURN_USERNAME and VOXNET_TURN_CREDENTIAL.' });
  }

  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.VOXNET_TURN_USERNAME,
      credential: process.env.VOXNET_TURN_CREDENTIAL
    });
  }

  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, turnConfigured: turnUrls.length > 0 });
});

const DATA_DIR = process.env.VOXNET_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'local_db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({ nextNumber: 7001000001, users: [], rechargeMessages: [] }, null, 2)
  );
}

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function createSignedLicense(virtualNumber, planType, expiresAtIso) {
  const payload = `${virtualNumber}|${planType}|${expiresAtIso}`;
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

app.post('/api/register-once', (req, res) => {
  const { displayName } = req.body;
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: 'Name required' });

  const db = readDb();
  const virtualNumber = String(db.nextNumber++);
  const deviceToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(0).toISOString();
  const signedOfflineLicense = createSignedLicense(virtualNumber, 'NONE', expiresAt);

  const newUser = {
    id: crypto.randomUUID(),
    virtualNumber,
    displayName: displayName.trim(),
    deviceToken,
    currentPlan: 'NONE',
    planExpiresAt: expiresAt,
    signedOfflineLicense,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDb(db);
  res.json({ user: newUser, serverPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
});

app.post('/api/recharge-message', (req, res) => {
  const { deviceToken, planType, message } = req.body;
  const db = readDb();
  const user = db.users.find((u) => u.deviceToken === deviceToken);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const amountInr = planType === 'YEARLY_600' ? 600 : 79;
  const rechargeReq = {
    id: crypto.randomUUID(),
    virtualNumber: user.virtualNumber,
    displayName: user.displayName,
    planRequested: planType === 'YEARLY_600' ? 'YEARLY_600' : 'MONTHLY_79',
    amountInr,
    userMessage: message || `Activate ${planType}`,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };

  db.rechargeMessages.unshift(rechargeReq);
  writeDb(db);
  broadcastToAdmins({ type: 'NEW_RECHARGE_MESSAGE', request: rechargeReq });
  res.json({ status: 'SENT', request: rechargeReq });
});

app.get('/api/admin/overview', (req, res) => {
  const db = readDb();
  res.json({ users: db.users, rechargeMessages: db.rechargeMessages, onlineNumbers: Array.from(onlineSockets.keys()) });
});

app.post('/api/admin/approve-recharge', (req, res) => {
  const { requestId } = req.body;
  const db = readDb();
  const reqIndex = db.rechargeMessages.findIndex((r) => r.id === requestId);
  if (reqIndex === -1) return res.status(404).json({ error: 'Not found' });

  const rechargeReq = db.rechargeMessages[reqIndex];
  const userIndex = db.users.findIndex((u) => u.virtualNumber === rechargeReq.virtualNumber);
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

  const daysToAdd = rechargeReq.planRequested === 'YEARLY_600' ? 365 : 30;
  const newExpiry = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
  const signedLicense = createSignedLicense(rechargeReq.virtualNumber, rechargeReq.planRequested, newExpiry);

  db.users[userIndex].currentPlan = rechargeReq.planRequested;
  db.users[userIndex].planExpiresAt = newExpiry;
  db.users[userIndex].signedOfflineLicense = signedLicense;
  db.rechargeMessages[reqIndex].status = 'APPROVED';
  db.rechargeMessages[reqIndex].approvedAt = new Date().toISOString();
  writeDb(db);

  const userWs = onlineSockets.get(rechargeReq.virtualNumber);
  if (userWs && userWs.readyState === WebSocket.OPEN) {
    userWs.send(JSON.stringify({
      type: 'RECHARGE_APPROVED',
      currentPlan: rechargeReq.planRequested,
      planExpiresAt: newExpiry,
      signedOfflineLicense: signedLicense
    }));
  }

  res.json({ success: true, virtualNumber: rechargeReq.virtualNumber, planExpiresAt: newExpiry });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const onlineSockets = new Map();
const adminSockets = new Set();

function broadcastToAdmins(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of adminSockets) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function broadcastOnlineDirectory() {
  const db = readDb();
  const onlineList = db.users
    .filter((u) => onlineSockets.has(u.virtualNumber))
    .map((u) => ({ virtualNumber: u.virtualNumber, displayName: u.displayName }));

  const packet = JSON.stringify({ type: 'ONLINE_DIRECTORY', users: onlineList });
  for (const [, ws] of onlineSockets) if (ws.readyState === WebSocket.OPEN) ws.send(packet);
  broadcastToAdmins({ type: 'ONLINE_DIRECTORY', users: onlineList });
}

wss.on('connection', (ws) => {
  let boundNumber = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'ADMIN_SUBSCRIBE') {
      adminSockets.add(ws);
      return;
    }

    if (data.type === 'AUTH_DEVICE') {
      const db = readDb();
      const user = db.users.find((u) => u.deviceToken === data.deviceToken);
      if (!user) { ws.send(JSON.stringify({ type: 'AUTH_INVALID' })); return; }

      boundNumber = user.virtualNumber;
      onlineSockets.set(boundNumber, ws);

      ws.send(JSON.stringify({
        type: 'AUTH_SUCCESS',
        user: {
          virtualNumber: user.virtualNumber,
          displayName: user.displayName,
          currentPlan: user.currentPlan,
          planExpiresAt: user.planExpiresAt,
          signedOfflineLicense: user.signedOfflineLicense
        }
      }));
      broadcastOnlineDirectory();
      return;
    }

    if (data.type === 'CALL_INIT') {
      const db = readDb();
      const caller = db.users.find((u) => u.virtualNumber === boundNumber);

      if (!caller || new Date(caller.planExpiresAt) <= new Date()) {
        ws.send(JSON.stringify({
          type: 'RECHARGE_LOCKED',
          reason: 'Plan expired! Message Admin to recharge ₹79/month or ₹600/year (₹50/mo).'
        }));
        return;
      }

      const receiverWs = onlineSockets.get(data.toNumber);
      if (!receiverWs || receiverWs.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CALL_ERROR', message: `Number ${data.toNumber} is offline.` }));
        return;
      }

      receiverWs.send(JSON.stringify({
        type: 'INCOMING_CALL',
        fromNumber: boundNumber,
        fromName: caller.displayName,
        sdpOffer: data.sdpOffer
      }));
      return;
    }

    if (['CALL_ANSWER', 'ICE_CANDIDATE', 'HANGUP'].includes(data.type)) {
      const targetWs = onlineSockets.get(data.toNumber);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ ...data, fromNumber: boundNumber }));
      }
    }
  });

  ws.on('close', () => {
    adminSockets.delete(ws);
    if (boundNumber) {
      onlineSockets.delete(boundNumber);
      broadcastOnlineDirectory();
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`VOXNET Telecom Server running on port ${PORT}`);
});