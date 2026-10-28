# VOXNET Local

VOXNET is a browser-based internet voice-calling demo. It does not place calls through a Jio SIM or replace carrier voice service. Both phones need internet access, an active VOXNET account, and microphone permission.

## Run locally

```powershell
npm install
npm start
```

Open `http://localhost:4000` in two browsers to test. Browsers require a secure context for microphone access; `localhost` is allowed for local testing.

Run the automated two-peer voice regression with `npm run test:voice`. It uses Chrome or Edge with simulated microphones and checks that ICE candidates arriving before the callee answers are applied and that audio RTP flows in both directions.

## Test on two phones with ngrok

1. Start the server on the computer that will host VOXNET:

   ```powershell
   npm start
   ```

2. In another terminal, expose port 4000:

   ```powershell
   ngrok http 4000
   ```

3. Open the same `https://...ngrok...` URL on both phones. The app uses secure WebSockets automatically when opened over HTTPS.
4. Register each phone, allow microphone access, activate calling plans, and place a call using the other phone's VOXNET number.
5. Keep the server running for the whole call. ngrok exposes the web app and signaling connection; it does not relay WebRTC audio.

## Mobile-network audio

VOXNET first attempts a direct WebRTC connection using STUN. Mobile-carrier NAT/firewalls can prevent a direct audio path, even when the call is accepted. For reliable calling across Jio or other mobile networks, configure a TURN relay from a managed provider or a correctly secured TURN server before starting the app:

```powershell
$env:VOXNET_TURN_URLS = 'turns:turn.example.com:5349?transport=tcp'
$env:VOXNET_TURN_USERNAME = '<provider-issued-username>'
$env:VOXNET_TURN_CREDENTIAL = '<provider-issued-credential>'
npm start
```

`VOXNET_TURN_URLS` accepts comma-separated `turn:` or `turns:` URLs. The TURN username and credential are delivered to calling browsers by `/api/ice-config`, so use provider-issued, limited-lifetime credentials where possible. Do not commit credentials to source control. The app shows a network failure status when ICE cannot establish an audio path.

The audio controls require both users to allow microphone access. If a browser blocks automatic playback, tap **Enable Audio** in the active call.
