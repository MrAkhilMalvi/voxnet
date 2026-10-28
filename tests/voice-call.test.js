const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const chromePath = findChrome();

test('accepted calls exchange live audio after the callee answers', {
  skip: chromePath ? false : 'Chrome or Edge is required for the two-peer WebRTC test'
}, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxnet-voice-test-'));
  const profiles = [];
  const browsers = [];
  const serverPort = await getAvailablePort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(serverPort),
      VOXNET_DATA_DIR: dataDir,
      VOXNET_TURN_URLS: 'turn:relay.example.test:3478,turns:relay.example.test:5349',
      VOXNET_TURN_USERNAME: 'voice-test-user',
      VOXNET_TURN_CREDENTIAL: 'voice-test-credential'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  t.after(async () => {
    for (const browser of browsers) {
      if (browser.cdp) {
        await Promise.race([browser.cdp.send('Browser.close').catch(() => {}), delay(1000)]);
      }
      if (browser.exitCode === null) {
        const exited = once(browser, 'exit');
        browser.kill();
        await Promise.race([exited, delay(3000)]);
      }
    }
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await Promise.race([exited, delay(1000)]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const profile of profiles) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`Server exited: ${serverOutput}`);
    return fetch(baseUrl).then((response) => response.ok);
  }, 'server startup');

  const unauthorizedIceConfig = await fetch(`${baseUrl}/api/ice-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(unauthorizedIceConfig.status, 401);

  const first = await createPeer('Caller', baseUrl, profiles, browsers);
  const second = await createPeer('Callee', baseUrl, profiles, browsers);

  const iceConfigResponse = await fetch(`${baseUrl}/api/ice-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken: first.deviceToken })
  });
  const iceConfig = await iceConfigResponse.json();
  assert.equal(iceConfigResponse.status, 200);
  assert.deepEqual(iceConfig.iceServers[1].urls, [
    'turn:relay.example.test:3478',
    'turns:relay.example.test:5349'
  ]);
  assert.equal(iceConfig.iceServers[1].username, 'voice-test-user');
  assert.equal(iceConfig.iceServers[1].credential, 'voice-test-credential');
  assert.equal(iceConfig.turnConfigured, true);

  await activatePlan(baseUrl, first.deviceToken, 'Caller');
  await activatePlan(baseUrl, second.deviceToken, 'Callee');
  await Promise.all([
    first.waitForExpression("document.getElementById('planBadge').classList.contains('badge-active')"),
    second.waitForExpression("document.getElementById('planBadge').classList.contains('badge-active')")
  ]);

  await first.evaluate(`document.getElementById('targetNumberInput').value = '${second.number}'; document.getElementById('callStartBtn').click();`);
  await second.waitForExpression("!document.getElementById('incomingCallBox').classList.contains('hidden')");

  await first.waitForExpression("pc && pc.iceGatheringState === 'complete'");
  await delay(500);
  const offerCandidateCount = await second.evaluate("(pendingOffer.sdpOffer.sdp.match(/^a=candidate:/gm) || []).length");
  assert.equal(offerCandidateCount, 0, 'the SDP offer should not contain trickled ICE candidates');
  const candidate = await first.evaluate(`(() => {
    const sdp = pc.localDescription.sdp;
    return {
      candidate: sdp.match(/^a=candidate:.*$/m)?.[0].slice(2),
      sdpMid: sdp.match(/^a=mid:(.*)$/m)?.[1] || '0',
      usernameFragment: sdp.match(/^a=ice-ufrag:(.*)$/m)?.[1]
    };
  })()`);
  assert.ok(candidate.candidate, 'caller should have gathered an ICE candidate');
  await first.evaluate(`ws.send(JSON.stringify({
    type: 'ICE_CANDIDATE',
    toNumber: '${second.number}',
    candidate: ${JSON.stringify({ ...candidate, sdpMLineIndex: 0 })}
  }))`);
  await second.waitForExpression(
    `window.__receivedIceCandidates.some((message) => message.fromNumber === '${first.number}')`
  );
  await second.evaluate("document.getElementById('answerCallBtn').click()");
  await second.waitForExpression(`window.__addedIceCandidates.includes(${JSON.stringify(candidate.candidate)})`);

  const audio = await waitFor(async () => {
    const [caller, callee] = await Promise.all([first.getAudioStats(), second.getAudioStats()]);
    if (caller.inboundBytes > 0 && callee.inboundBytes > 0) return { caller, callee };
    return false;
  }, 'audio RTP in both directions', 25000);

  assert.ok(audio.caller.remoteAudioPlaying, 'caller should be playing the callee audio track');
  assert.ok(audio.callee.remoteAudioPlaying, 'callee should be playing the caller audio track');
});

async function createPeer(name, baseUrl, profiles, browsers) {
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'voxnet-chrome-'))}`,
    'about:blank'
  ], { stdio: 'ignore' });
  browsers.push(chrome);

  const profile = chrome.spawnargs.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  profiles.push(profile);
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  await waitFor(() => fs.existsSync(activePortFile), 'Chrome DevTools startup');
  const debugPort = Number(fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]);
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: 'PUT' });
  if (!targetResponse.ok) throw new Error(`Could not create browser tab: ${targetResponse.status}`);

  const target = await targetResponse.json();
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  chrome.cdp = cdp;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__receivedIceCandidates = [];
      window.__addedIceCandidates = [];
      const NativeWebSocket = window.WebSocket;
      function ObservedWebSocket(...args) {
        const socket = new NativeWebSocket(...args);
        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'ICE_CANDIDATE') window.__receivedIceCandidates.push(message);
          } catch {}
        });
        return socket;
      }
      Object.setPrototypeOf(ObservedWebSocket, NativeWebSocket);
      ObservedWebSocket.prototype = NativeWebSocket.prototype;
      window.WebSocket = ObservedWebSocket;
      const NativePeerConnection = window.RTCPeerConnection;
      const originalAddIceCandidate = NativePeerConnection.prototype.addIceCandidate;
      NativePeerConnection.prototype.addIceCandidate = function (candidate, ...args) {
        window.__addedIceCandidates.push(candidate.candidate);
        return originalAddIceCandidate.call(this, candidate, ...args);
      };
      window.RTCPeerConnection = function (configuration, ...args) {
        return new NativePeerConnection({ ...configuration, iceServers: [] }, ...args);
      };
    })();`
  });
  await cdp.send('Page.navigate', { url: baseUrl });

  await waitForExpression(cdp, "!!document.getElementById('regSubmitBtn')", 'app load');
  await evaluate(cdp, `document.getElementById('regNameInput').value = '${name}'; document.getElementById('regSubmitBtn').click()`);
  try {
    await waitForExpression(cdp, "!!localStorage.getItem('voxnet_device_token')", 'device registration');
  } catch (error) {
    const state = await evaluate(cdp, `({
      registerView: document.getElementById('registerView').className,
      dialerView: document.getElementById('dialerView').className,
      name: document.getElementById('regNameInput').value,
      savedToken: !!localStorage.getItem('voxnet_device_token')
    })`);
    throw new Error(`${error.message}; browser state: ${JSON.stringify(state)}; server: ${serverOutput}`);
  }
  await waitForExpression(cdp, "document.getElementById('myVirtualNumber').textContent !== '7001000000'", 'device authentication');

  const account = await evaluate(cdp, `({
    deviceToken: localStorage.getItem('voxnet_device_token'),
    number: document.getElementById('myVirtualNumber').textContent
  })`);
  if (!account.deviceToken) throw new Error(`${name} registration was not saved`);

  return {
    deviceToken: account.deviceToken,
    number: account.number,
    evaluate: (expression) => evaluate(cdp, expression),
    waitForExpression: (expression) => waitForExpression(cdp, expression, expression),
    getAudioStats: async () => evaluate(cdp, `(
      async () => {
        if (!pc) return { inboundBytes: 0, remoteAudioPlaying: false };
        const stats = await pc.getStats();
        const inboundBytes = Array.from(stats.values())
          .filter((item) => item.type === 'inbound-rtp' && (item.kind === 'audio' || item.mediaType === 'audio'))
          .reduce((total, item) => total + (item.bytesReceived || 0), 0);
        return {
          inboundBytes,
          connectionState: pc.connectionState,
          remoteAudioPlaying: !!remoteAudio.srcObject && !remoteAudio.paused && remoteAudio.readyState >= 2
        };
      }
    )()`)
  };
}

async function activatePlan(baseUrl, deviceToken, name) {
  const recharge = await fetch(`${baseUrl}/api/recharge-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken, planType: 'MONTHLY_79', message: `Test activation for ${name}` })
  }).then((response) => response.json());
  if (recharge.status !== 'SENT') throw new Error(`Could not create test plan for ${name}`);

  const approval = await fetch(`${baseUrl}/api/admin/approve-recharge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: recharge.request.id })
  });
  if (!approval.ok) throw new Error(`Could not activate test plan for ${name}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    socket.once('open', () => resolve({
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((resolveCall, rejectCall) => {
          pending.set(id, { resolve: resolveCall, reject: rejectCall });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      evaluate(expression) {
        return this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          .then((result) => {
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            return result.result.value;
          });
      }
    }));
    socket.once('error', reject);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  });
}

function evaluate(cdp, expression) {
  return cdp.evaluate(expression);
}

async function waitForExpression(cdp, expression, label) {
  return waitFor(() => cdp.evaluate(expression), label);
}

async function waitFor(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    ...(process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
        ]
      : [])
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of ['chrome', 'google-chrome', 'chromium', 'msedge']) {
    const result = spawnSync(command, [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}
