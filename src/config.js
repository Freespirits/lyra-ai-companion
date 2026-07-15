/* Server address resolution.
   In the browser (dev), everything is same-origin and vite proxies /api — the
   base stays ''. In the Capacitor app the UI is bundled on-device and talks to
   the Lyra server running on your PC over the network: the address is asked
   once and kept in localStorage ('lyra-server').
   Change it any time from the console: lyraSetServer('http://192.168.1.20:8686') */
export const SERVER = (() => {
  let s = localStorage.getItem('lyra-server') || '';
  if (!s && window.Capacitor) {
    s = window.prompt('Lyra server address (your PC on the same network), e.g. http://192.168.1.20:8686') || '';
    if (s) localStorage.setItem('lyra-server', s.trim().replace(/\/+$/, ''));
  }
  return s.trim().replace(/\/+$/, '');
})();

export const API = p => SERVER + p;
export const WS = p =>
  (SERVER ? SERVER.replace(/^http/, 'ws')
          : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host) + p;

window.lyraSetServer = u => {
  localStorage.setItem('lyra-server', String(u).trim().replace(/\/+$/, ''));
  location.reload();
};

/* The user's name, asked once and woven into every character's voice.
   Kept beside the server address; changeable from the console or settings. */
/* Never prompted for. She asks in her own voice on first contact and saves the
   answer with [name:] — filling this in from a dialog before boot would mean
   she already "knows" you on mobile and skips the introduction entirely. */
export let USER_NAME = (localStorage.getItem('lyra-user') || '').slice(0, 40);

export const getUserName = () => USER_NAME;

export function lyraSetName(n) {
  USER_NAME = String(n || '').trim().slice(0, 40);
  localStorage.setItem('lyra-user', USER_NAME);
}
window.lyraSetName = lyraSetName;
