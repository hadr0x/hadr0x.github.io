"use strict";
/* Collegamento Bluetooth al FlySight 2: elenca le cartelle e scarica i file, solo in lettura.

   Protocollo "CRS" del firmware ufficiale (flysight/flysight-2-firmware, FlySight/crs.c):
   - servizio 00000000-cc7a-482a-984a-7f2ed5b3e58f, TX (notifiche dal FlySight) e RX (scrittura senza risposta);
   - pacchetti [comando][dati], al massimo 244 byte, interi little-endian, numeri di sequenza su 1 byte;
   - READ_DIR 05 percorso\0 → F1 05, poi un FILE_INFO 11 per voce (l'ultimo ha il nome vuoto);
   - READ 02 offset:u32 passo-1:u32 percorso\0 → F1 02, poi FILE_DATA 10 seq dati (vuoto = fine file),
     ognuno confermato con FILE_ACK 12 seq; il FlySight ne manda 8 alla volta e ripete dopo 200 ms senza conferma;
   - F0 = rifiuto, FE = ping, FF = annulla. Senza scritture per 30 s il FlySight chiude la connessione. */

(function () {
  const CRS_SERVICE = "00000000-cc7a-482a-984a-7f2ed5b3e58f";
  const CRS_TX = "00000001-8e22-4541-9d4c-21edae82ed19";
  const CRS_RX = "00000002-8e22-4541-9d4c-21edae82ed19";
  const COMPANY_ID = 0x09db;

  const READ = 0x02, READ_DIR = 0x05, FILE_DATA = 0x10, FILE_INFO = 0x11, FILE_ACK = 0x12;
  const NAK = 0xf0, ACK = 0xf1, PING = 0xfe, CANCEL = 0xff;
  const AM_DIR = 0x10;          // attributo FatFs delle cartelle
  const PACKET = 244;           // pacchetto più lungo: 2 + 242 byte di dati
  const IDLE_MS = 6000;         // operazione ferma da troppo: annulla
  const KEEPALIVE_MS = 20000;   // ping se non si fa niente (il FlySight chiude dopo 30 s)

  const withPath = (head, path) => {
    const out = new Uint8Array(head.length + path.length + 1);
    out.set(head);
    for (let i = 0; i < path.length; i++) out[head.length + i] = path.charCodeAt(i) & 0xff;
    return out;  // l'ultimo byte resta 0
  };
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  class FlySightBLE {
    constructor() {
      this.device = null;
      this.rx = null;
      this.tx = null;
      this.handler = null;       // riceve i pacchetti dell'operazione in corso
      this.queue = Promise.resolve();   // un'operazione alla volta
      this.writes = Promise.resolve();  // una scrittura GATT alla volta
      this.keepalive = null;
      this.onDisconnect = () => {};
    }

    static supported() {
      return typeof navigator !== "undefined" && !!navigator.bluetooth;
    }

    async connect() {
      const bt = navigator.bluetooth;
      const optionalServices = [CRS_SERVICE];
      try {
        this.device = await bt.requestDevice({ filters: [{ manufacturerData: [{ companyIdentifier: COMPANY_ID }] }], optionalServices });
      } catch (e) {
        // browser che non conoscono il filtro per costruttore (alcune versioni di Bluefy): elenca tutto
        if (e && e.name === "TypeError") this.device = await bt.requestDevice({ acceptAllDevices: true, optionalServices });
        else throw e;
      }
      this.device.addEventListener("gattserverdisconnected", () => {
        this.stopKeepalive();
        this.rx = this.tx = null;
        this.onDisconnect();
      });
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(CRS_SERVICE);
      this.tx = await service.getCharacteristic(CRS_TX);
      this.rx = await service.getCharacteristic(CRS_RX);
      this.tx.addEventListener("characteristicvaluechanged", (ev) => {
        const v = ev.target.value;
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
        if (this.handler) this.handler(bytes);
      });
      await this.tx.startNotifications();  // qui il sistema fa l'accoppiamento, se serve
      await this.ping();
      this.startKeepalive();
      return this.device.name || "FlySight";
    }

    disconnect() {
      this.stopKeepalive();
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    get connected() {
      return !!(this.device && this.device.gatt.connected && this.rx);
    }

    write(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const send = () => (this.rx.writeValueWithoutResponse ? this.rx.writeValueWithoutResponse(data) : this.rx.writeValue(data));
      this.writes = this.writes.then(send, send);
      return this.writes;
    }

    startKeepalive() {
      this.stopKeepalive();
      this.keepalive = setInterval(() => {
        if (!this.handler && this.connected) this.ping().catch(() => {});
      }, KEEPALIVE_MS);
    }
    stopKeepalive() {
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = null;
    }

    // esegue un'operazione alla volta; body(resolve, reject, packet) riceve ogni pacchetto
    run(request, body) {
      const op = () => new Promise((resolve, reject) => {
        if (!this.connected) { reject(new Error("FlySight non collegato.")); return; }
        let timer = null;
        const finish = (fn, v) => {
          clearTimeout(timer);
          this.handler = null;
          fn(v);
        };
        const fail = (err) => {
          this.write([CANCEL]).catch(() => {});
          // lascia al FlySight il tempo di fermarsi prima della prossima richiesta
          setTimeout(() => finish(reject, err), 300);
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => fail(new Error("Il FlySight non risponde.")), IDLE_MS);
        };
        this.handler = (p) => {
          arm();
          try { body((v) => finish(resolve, v), fail, p); } catch (e) { fail(e); }
        };
        arm();
        this.write(request).catch((e) => fail(e));
      });
      this.queue = this.queue.then(op, op);
      return this.queue;
    }

    ping() {
      return this.run([PING], (done, fail, p) => {
        if (p[0] === ACK && p[1] === PING) done();
      });
    }

    // voci di una cartella: { name, size, dir }
    listDir(path) {
      const entries = [];
      let accepted = false;
      return this.run(withPath([READ_DIR], path), (done, fail, p) => {
        if (p[0] === NAK && p[1] === READ_DIR) return fail(new Error(`Cartella non trovata: ${path}`));
        if (p[0] === ACK && p[1] === READ_DIR) { accepted = true; return; }
        if (!accepted || p[0] !== FILE_INFO) return;
        if (p.length < 12) return fail(new Error("Pacchetto troppo corto dal FlySight."));
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        let name = "";
        for (let i = 11; i < Math.min(p.length, 24) && p[i]; i++) name += String.fromCharCode(p[i]);
        if (!name) return done(entries);
        if (name === "." || name === "..") return;
        entries.push({ name, size: dv.getUint32(2, true), dir: (p[10] & AM_DIR) !== 0 });
      });
    }

    // contenuto di un file come Uint8Array; onProgress(byte ricevuti)
    readFile(path, onProgress = () => {}) {
      const chunks = [];
      let received = 0, expected = 0, accepted = false, short = false;
      return this.run(withPath([READ, ...u32(0), ...u32(0)], path), (done, fail, p) => {
        if (p[0] === NAK && p[1] === READ) return fail(new Error(`File non trovato: ${path}`));
        if (p[0] === ACK && p[1] === READ) { accepted = true; return; }
        if (!accepted || p[0] !== FILE_DATA || p.length < 2) return;
        if (p[1] !== (expected & 0xff)) {
          // blocco già ricevuto (la nostra conferma si è persa): riconfermalo, altrimenti il FlySight resta fermo lì
          const behind = (expected - p[1]) & 0xff;
          if (behind >= 1 && behind <= 8) this.write([FILE_ACK, p[1]]).catch(() => {});
          return;  // fuori ordine in avanti: il FlySight lo ripete
        }
        this.write([FILE_ACK, p[1]]).catch(() => {});
        expected++;
        if (p.length === 2) return done(concat(chunks, received));  // pacchetto vuoto = fine file
        if (short) return fail(new Error("Il collegamento Bluetooth taglia i pacchetti (MTU troppo piccolo): prova con un altro browser o dispositivo."));
        if (p.length < PACKET) short = true;  // solo l'ultimo blocco può essere corto
        chunks.push(p.subarray(2));
        received += p.length - 2;
        onProgress(received);
      });
    }
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  window.FlySightBLE = FlySightBLE;
})();
