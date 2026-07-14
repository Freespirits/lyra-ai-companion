/* Deepgram live STT relay.
   Browser streams MediaRecorder webm/opus chunks over ws://.../stt;
   this proxies them to Deepgram's live API (keeping the key server-side)
   and forwards transcripts back as {text, isFinal, speechFinal}.
   The client falls back to the Web Speech API when no key is configured. */
import { WebSocketServer, WebSocket } from 'ws';

export function sttEnabled() {
  return !!process.env.DEEPGRAM_API_KEY;
}

export function attachStt(server) {
  const wss = new WebSocketServer({ server, path: '/stt' });
  wss.on('connection', (client, req) => {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      try { client.send(JSON.stringify({ error: 'DEEPGRAM_API_KEY missing in .env' })); } catch (e) {}
      return client.close();
    }
    const url = new URL(req.url, 'http://x');
    const lang = url.searchParams.get('lang') || 'en';
    /* nova-3 for English, nova-2 otherwise (wider language coverage);
       endpointing gives us utterance boundaries for the call loop */
    const model = lang.startsWith('en') ? 'nova-3' : 'nova-2';
    const dgUrl = 'wss://api.deepgram.com/v1/listen'
      + '?model=' + model
      + '&language=' + encodeURIComponent(lang.split('-')[0])
      + '&interim_results=true&smart_format=true&punctuate=true'
      + '&endpointing=700&vad_events=true';
    const dg = new WebSocket(dgUrl, { headers: { Authorization: 'Token ' + key } });

    const pending = [];
    dg.on('open', () => { for (const b of pending.splice(0)) dg.send(b); });
    dg.on('message', data => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'Results') {
          const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
          const text = (alt && alt.transcript) || '';
          client.send(JSON.stringify({
            text,
            isFinal: !!m.is_final,
            speechFinal: !!m.speech_final,   /* endpointing fired: utterance over */
          }));
        } else if (m.type === 'SpeechStarted') {
          client.send(JSON.stringify({ speechStarted: true }));
        }
      } catch (e) { /* keepalives */ }
    });
    dg.on('error', e => {
      try { client.send(JSON.stringify({ error: 'deepgram: ' + e.message })); } catch (err) {}
    });
    dg.on('close', () => { try { client.close(); } catch (e) {} });

    client.on('message', data => {
      if (dg.readyState === WebSocket.OPEN) dg.send(data);
      else if (dg.readyState === WebSocket.CONNECTING) pending.push(data);
    });
    client.on('close', () => {
      try { dg.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
      try { dg.close(); } catch (e) {}
    });
  });
  return wss;
}
