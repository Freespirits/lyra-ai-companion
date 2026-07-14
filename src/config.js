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
