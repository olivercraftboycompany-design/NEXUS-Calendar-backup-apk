/* NEXUS Calendar: seals reminder data before it leaves your phone.
   ECDH P-256 + HKDF-SHA256 + AES-GCM. Only the GitHub Action (which holds the private key) can open it.
   Used by both the page and the service worker. */
(function (g) {
  'use strict';
  const b64u = {
    enc(buf) { let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
  };
  async function deflate(bytes) {
    const st = new Blob([bytes]).stream().pipeThrough(new g.CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  async function seal(obj, boxPublicKey, compress) {
    const C = g.crypto.subtle;
    const pub = await C.importKey('raw', b64u.dec(boxPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await C.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await C.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
    const hk = await C.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await C.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('nxcal-box-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = g.crypto.getRandomValues(new Uint8Array(12));
    let pt = new TextEncoder().encode(JSON.stringify(obj));
    if (compress) pt = await deflate(pt);
    const ct = await C.encrypt({ name: 'AES-GCM', iv }, key, pt);
    const ephRaw = await C.exportKey('raw', eph.publicKey);
    return [compress ? 'nc2' : 'nc1', b64u.enc(ephRaw), b64u.enc(iv), b64u.enc(ct)].join('.');
  }
  g.NXCalPush = {
    TOPIC: 'nxcal-0a79e7056731689696f5798e',
    VAPID_PUBLIC: 'BGuyPDZyW3rsyy4HpTfNsIY0nkNS1bWrLGbZAUxoRoSW84z-I--zVkBtiAEK11b8yU4LsUP4FV4mmamgASx0D1o',
    BOX_PUBLIC: 'BCw7n89tXfm8PpobbW3m2nJj4PeXW0N3ndK5Nbps4q859WpDIOVlOHEQIrHWQTW_LrF6qloQvHQ1UmV2zrZ_TT8',
    seal, b64u,
    async sealed(obj) { return g.CompressionStream ? seal(obj, g.NXCalPush.BOX_PUBLIC, true) : seal(obj, g.NXCalPush.BOX_PUBLIC); },
    async post(obj, body) {
      body = body || await g.NXCalPush.sealed(obj);
      if (body.length > 4000) throw new Error('too big to sync in one message');
      const r = await fetch('https://ntfy.sh/' + g.NXCalPush.TOPIC, { method: 'POST', body });
      if (!r.ok) throw new Error('sync failed (' + r.status + ')');
      return r.json().catch(() => ({}));
    }
  };
})(self);
