/* Environmental sync: the avatar's state bleeds into the room lighting.
   Providers:
     hue : Philips Hue local bridge (HUE_BRIDGE_IP, HUE_USERNAME, HUE_GROUP)
     ha  : Home Assistant webhook (HA_URL, HA_WEBHOOK_ID) covering Nanoleaf,
           WLED, Govee, or anything else HA can drive
     off : no-op
   Scene = f(emotion, app state). Debounced so rapid state flips don't strobe. */

const PALETTE = {
  /* [hueDeg, sat 0-100, bri 0-100, transition seconds] */
  neutral:   [ 35, 35, 45, 3.0],
  happy:     [ 45, 60, 70, 1.2],
  excited:   [ 25, 85, 90, 0.6],
  flirty:    [320, 85, 38, 2.5],   /* crimson into violet, dimmed */
  surprised: [  0,  5, 98, 0.2],
  sad:       [230, 60, 22, 3.0],
  thinking:  [190, 45, 30, 2.0],
};
const STATE_BRI = { speaking: 1.15, listening: .8, thinking: .85, idle: 1.0 };

function hsvToRgb(h, s, v) {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m].map(v2 => Math.round(v2 * 255));
}

export class Aura {
  constructor(env) {
    this.provider = (env.AURA_PROVIDER || 'off').toLowerCase();
    this.env = env;
    this.lastKey = '';
    this.lastSent = 0;
    this.timer = null;
    this.pending = null;
  }

  update(state, emotion) {
    if (this.provider === 'off') return;
    const p = PALETTE[emotion] || PALETTE.neutral;
    const briMul = STATE_BRI[state] || 1;
    const scene = {
      h: p[0], s: p[1],
      bri: Math.max(4, Math.min(100, Math.round(p[2] * briMul))),
      transition: state === 'idle' ? Math.max(p[3], 3) : p[3],
      state, emotion,
    };
    const key = scene.h + '/' + scene.s + '/' + scene.bri;
    if (key === this.lastKey) return;
    this.pending = scene;
    const wait = Math.max(0, 400 - (Date.now() - this.lastSent));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._send(), wait);
  }

  async _send() {
    const scene = this.pending;
    if (!scene) return;
    this.pending = null;
    this.lastKey = scene.h + '/' + scene.s + '/' + scene.bri;
    this.lastSent = Date.now();
    try {
      if (this.provider === 'hue') {
        const { HUE_BRIDGE_IP, HUE_USERNAME } = this.env;
        if (!HUE_BRIDGE_IP || !HUE_USERNAME) return;
        const group = this.env.HUE_GROUP || '0';
        await fetch(`http://${HUE_BRIDGE_IP}/api/${HUE_USERNAME}/groups/${group}/action`, {
          method: 'PUT',
          body: JSON.stringify({
            on: true,
            hue: Math.round(scene.h / 360 * 65535),
            sat: Math.round(scene.s / 100 * 254),
            bri: Math.round(scene.bri / 100 * 254),
            transitiontime: Math.round(scene.transition * 10),
          }),
        });
      } else if (this.provider === 'ha') {
        const { HA_URL, HA_WEBHOOK_ID } = this.env;
        if (!HA_URL || !HA_WEBHOOK_ID) return;
        await fetch(`${HA_URL.replace(/\/$/, '')}/api/webhook/${HA_WEBHOOK_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: scene.state,
            emotion: scene.emotion,
            rgb: hsvToRgb(scene.h, scene.s, 100),
            brightness: Math.round(scene.bri / 100 * 255),
            transition: scene.transition,
          }),
        });
      }
    } catch (e) { /* lights offline: never break the conversation over it */ }
  }
}
