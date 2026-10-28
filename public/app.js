const registerView = document.getElementById('registerView');
const dialerView = document.getElementById('dialerView');
const regNameInput = document.getElementById('regNameInput');
const regSubmitBtn = document.getElementById('regSubmitBtn');

const myNameLabel = document.getElementById('myNameLabel');
const myVirtualNumber = document.getElementById('myVirtualNumber');
const planBadge = document.getElementById('planBadge');
const planExpiryText = document.getElementById('planExpiryText');

const targetNumberInput = document.getElementById('targetNumberInput');
const callStartBtn = document.getElementById('callStartBtn');
const onlineUsersList = document.getElementById('onlineUsersList');

const incomingCallBox = document.getElementById('incomingCallBox');
const incomingCallerText = document.getElementById('incomingCallerText');
const answerCallBtn = document.getElementById('answerCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');

const activeCallBox = document.getElementById('activeCallBox');
const callStatusHeader = document.getElementById('callStatusHeader');
const callPeerLabel = document.getElementById('callPeerLabel');
const enableAudioBtn = document.getElementById('enableAudioBtn');
const muteMicBtn = document.getElementById('muteMicBtn');
const hangupCallBtn = document.getElementById('hangupCallBtn');

const rechargePlanSelect = document.getElementById('rechargePlanSelect');
const rechargeMsgInput = document.getElementById('rechargeMsgInput');
const sendRechargeMsgBtn = document.getElementById('sendRechargeMsgBtn');
const rechargeFeedback = document.getElementById('rechargeFeedback');
const remoteAudio = document.getElementById('remoteAudio');

let ws = null;
let pc = null;
let localStream = null;
let currentPeerNumber = null;
let pendingOffer = null;
let myNumber = null;
let isMuted = false;
let ringtoneTimer = null;
let pendingIceCandidates = [];

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function startRingtone() {
  if (navigator.vibrate) navigator.vibrate([500, 300, 500, 300, 500]);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ringtoneTimer = setInterval(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }, 900);
  } catch {}
}

function stopRingtone() {
  if (ringtoneTimer) {
    clearInterval(ringtoneTimer);
    ringtoneTimer = null;
  }
  if (navigator.vibrate) navigator.vibrate(0);
}

window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('voxnet_device_token');
  if (!savedToken) {
    registerView.classList.remove('hidden');
  } else {
    dialerView.classList.remove('hidden');
    connectSignaling(savedToken);
  }
});

regSubmitBtn.addEventListener('click', async () => {
  const displayName = regNameInput.value.trim();
  if (!displayName) return alert('Enter your name');

  const res = await fetch('/api/register-once', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  const data = await res.json();

  if (data.user) {
    localStorage.setItem('voxnet_device_token', data.user.deviceToken);
    localStorage.setItem('voxnet_offline_license', data.user.signedOfflineLicense);
    registerView.classList.add('hidden');
    dialerView.classList.remove('hidden');
    connectSignaling(data.user.deviceToken);
  }
});

function connectSignaling(deviceToken) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'AUTH_DEVICE', deviceToken }));
  };

  ws.onclose = () => {
    setTimeout(() => connectSignaling(deviceToken), 2500);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'AUTH_INVALID') {
      localStorage.removeItem('voxnet_device_token');
      window.location.reload();
      return;
    }

    if (msg.type === 'AUTH_SUCCESS') {
      myNumber = msg.user.virtualNumber;
      myNameLabel.textContent = msg.user.displayName;
      myVirtualNumber.textContent = msg.user.virtualNumber;
      updatePlanUI(msg.user.currentPlan, msg.user.planExpiresAt, msg.user.signedOfflineLicense);
    }

    if (msg.type === 'RECHARGE_APPROVED') {
      updatePlanUI(msg.currentPlan, msg.planExpiresAt, msg.signedOfflineLicense);
      rechargeFeedback.textContent = 'Admin approved recharge! Calling unlocked.';
    }

    if (msg.type === 'ONLINE_DIRECTORY') {
      renderOnlinePeers(msg.users);
    }

    if (msg.type === 'RECHARGE_LOCKED') {
      cleanupCallUI();
      alert(msg.reason);
    }

    if (msg.type === 'CALL_ERROR') {
      cleanupCallUI();
      alert(msg.message);
    }

    if (msg.type === 'INCOMING_CALL') {
      pendingIceCandidates = [];
      currentPeerNumber = msg.fromNumber;
      pendingOffer = msg;
      incomingCallerText.textContent = `${msg.fromName} (${msg.fromNumber})`;
      incomingCallBox.classList.remove('hidden');
      startRingtone();
    }

    if (msg.type === 'CALL_ANSWER' && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdpAnswer));
      await flushPendingIceCandidates();
      callStatusHeader.textContent = 'Connecting voice...';
    }

    if (msg.type === 'ICE_CANDIDATE' && msg.fromNumber === currentPeerNumber) {
      pendingIceCandidates.push(msg.candidate);
      await flushPendingIceCandidates();
    }

    if (msg.type === 'HANGUP') {
      cleanupCallUI();
    }
  };
}

function updatePlanUI(plan, expiresAtIso, signedOfflineLicense) {
  if (signedOfflineLicense) localStorage.setItem('voxnet_offline_license', signedOfflineLicense);
  const expDate = new Date(expiresAtIso);
  const isActive = expDate > new Date();

  if (isActive) {
    planBadge.textContent = plan === 'YEARLY_600' ? 'Active (₹600/Yr)' : 'Active (₹79/Mo)';
    planBadge.className = 'badge badge-active';
    planExpiryText.textContent = `Valid until: ${expDate.toLocaleDateString()}`;
  } else {
    planBadge.textContent = 'Recharge Required';
    planBadge.className = 'badge badge-expired';
    planExpiryText.textContent = 'Message Admin below for ₹79/mo or ₹600/yr (₹50/mo) activation.';
  }
}

function renderOnlinePeers(users) {
  const others = users.filter((u) => u.virtualNumber !== myNumber);
  if (others.length === 0) {
    onlineUsersList.innerHTML = 'No other users online right now.';
    return;
  }

  onlineUsersList.innerHTML = '';
  others.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'peer-item';
    row.innerHTML = `
      <span><strong>${u.displayName}</strong><br/><small style="color:#38bdf8">${u.virtualNumber}</small></span>
      <button class="btn-primary" onclick="quickDial('${u.virtualNumber}')">Call</button>
    `;
    onlineUsersList.appendChild(row);
  });
}

window.quickDial = (number) => {
  targetNumberInput.value = number;
  startVoiceCall(number);
};

async function loadIceServers() {
  const response = await fetch('/api/ice-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken: localStorage.getItem('voxnet_device_token') })
  });
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || 'Could not load voice network settings.');
  if (!Array.isArray(config.iceServers)) throw new Error('Voice network settings are invalid.');
  return config.iceServers;
}

async function createPeerConnection(peerNumber) {
  const iceServers = await loadIceServers();
  const peerConnection = new RTCPeerConnection({ iceServers });
  pc = peerConnection;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (error) {
    peerConnection.close();
    pc = null;
    console.error('Microphone access failed:', error);
    throw new Error('Microphone access is required. Allow microphone permission and try again.');
  }

  localStream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    const remoteStream = event.streams[0] || new MediaStream([event.track]);
    remoteAudio.srcObject = remoteStream;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    remoteAudio.play().then(() => {
      callStatusHeader.textContent = 'Voice connected';
      enableAudioBtn.textContent = 'Audio enabled';
    }).catch((error) => {
      console.error('Remote audio playback was blocked:', error);
      callStatusHeader.textContent = 'Call connected. Tap Enable Audio to hear the caller.';
      enableAudioBtn.textContent = 'Enable Audio';
    });
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ICE_CANDIDATE',
        toNumber: peerNumber,
        candidate: event.candidate
      }));
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (pc !== peerConnection) return;
    if (peerConnection.connectionState === 'connected' && !remoteAudio.srcObject) {
      callStatusHeader.textContent = 'Network connected. Waiting for audio...';
    } else if (peerConnection.connectionState === 'failed') {
      callStatusHeader.textContent = 'Network failed. Configure a TURN relay for mobile networks.';
    } else if (peerConnection.connectionState === 'disconnected') {
      callStatusHeader.textContent = 'Network interrupted. Trying to reconnect...';
    }
  };
}

async function flushPendingIceCandidates() {
  while (pc && pc.remoteDescription && pendingIceCandidates.length) {
    const candidate = pendingIceCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Could not apply remote ICE candidate:', error);
      callStatusHeader.textContent = 'Network setup issue. Check the connection and try again.';
    }
  }
}

callStartBtn.addEventListener('click', () => {
  const target = targetNumberInput.value.trim();
  if (!target) return alert('Enter a VOXNET number');
  startVoiceCall(target);
});

async function startVoiceCall(peerNumber) {
  try {
    currentPeerNumber = peerNumber;
    pendingIceCandidates = [];
    activeCallBox.classList.remove('hidden');
    callStatusHeader.textContent = 'Starting secure voice connection...';
    callPeerLabel.textContent = `Calling ${peerNumber}`;

    await createPeerConnection(peerNumber);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({ type: 'CALL_INIT', toNumber: peerNumber, sdpOffer: offer }));
  } catch (err) {
    cleanupCallUI();
    alert('Call error: ' + err.message);
  }
}

answerCallBtn.addEventListener('click', async () => {
  if (!pendingOffer) return;
  stopRingtone();
  try {
    currentPeerNumber = pendingOffer.fromNumber;
    incomingCallBox.classList.add('hidden');
    activeCallBox.classList.remove('hidden');
    callStatusHeader.textContent = 'Connecting voice...';
    callPeerLabel.textContent = `Speaking with ${pendingOffer.fromName} (${currentPeerNumber})`;

    await createPeerConnection(currentPeerNumber);
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdpOffer));
    await flushPendingIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({ type: 'CALL_ANSWER', toNumber: currentPeerNumber, sdpAnswer: answer }));
    pendingOffer = null;
  } catch (err) {
    cleanupCallUI();
    alert('Answer error: ' + err.message);
  }
});

rejectCallBtn.addEventListener('click', () => {
  stopRingtone();
  if (pendingOffer) {
    ws.send(JSON.stringify({ type: 'HANGUP', toNumber: pendingOffer.fromNumber }));
    pendingOffer = null;
  }
  incomingCallBox.classList.add('hidden');
});

enableAudioBtn.addEventListener('click', async () => {
  remoteAudio.muted = false;
  remoteAudio.volume = 1;
  try {
    await remoteAudio.play();
    enableAudioBtn.textContent = 'Audio enabled';
    callStatusHeader.textContent = 'Voice connected';
  } catch (error) {
    console.error('Could not enable remote audio:', error);
    callStatusHeader.textContent = 'Audio is blocked. Check this browser tab’s sound permission.';
  }
});

muteMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  muteMicBtn.textContent = isMuted ? 'Unmute Mic' : 'Mute Mic';
});

hangupCallBtn.addEventListener('click', () => {
  if (currentPeerNumber) {
    ws.send(JSON.stringify({ type: 'HANGUP', toNumber: currentPeerNumber }));
  }
  cleanupCallUI();
});

function cleanupCallUI() {
  stopRingtone();
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  isMuted = false;
  pendingIceCandidates = [];
  enableAudioBtn.textContent = 'Enable Audio';
  muteMicBtn.textContent = 'Mute Mic';
  currentPeerNumber = null;
  pendingOffer = null;
  incomingCallBox.classList.add('hidden');
  activeCallBox.classList.add('hidden');
}

sendRechargeMsgBtn.addEventListener('click', async () => {
  const deviceToken = localStorage.getItem('voxnet_device_token');
  const planType = rechargePlanSelect.value;
  const message = rechargeMsgInput.value.trim();

  const res = await fetch('/api/recharge-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceToken, planType, message })
  });
  const data = await res.json();
  if (data.status === 'SENT') {
    rechargeMsgInput.value = '';
    rechargeFeedback.textContent = 'Message sent! Approve it in /admin.html to unlock.';
  }
});