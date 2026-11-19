// Scheda allenamento: legge scheda.json, calcola watt e frequenze dai test, la rende modificabile e scaricabile.
// Le modifiche e i test inseriti restano nel browser (localStorage); il JSON scaricato sostituisce scheda.json nel repo.
//
// Nei testi le formule si scrivono tra parentesi quadre:
//   [FTP 56%]    56% dell'FTP dell'ultimo test, arrotondato al watt
//   [LTHR 90%]   [FCMAX 94%]   [PESO]   lo stesso per gli altri parametri
//   [FASE]       la fase in corso dell'isometria lunga (dalla tabella "Fase")
(function () {
  'use strict';

  var KEY_DATA = 'scheda-dati-v3';
  var KEY_VAR = 'scheda-variante';
  var LABEL = { fly: 'weekend volo performance', dz: 'weekend in DZ a lavorare' };
  var DAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
  var KIND = { duro: 'k-duro', forte: 'k-forte', facile: 'k-facile', volo: 'k-volo' };
  var TOKEN = /\[(FTP|LTHR|FCMAX|PESO|FASE)(?:\s+([\d.,]+)\s*%)?\]/gi;
  var DAY_MS = 864e5;

  var data = null;
  var variant = 'fly';
  var editing = false;
  var setters = new WeakMap();
  var saveTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function store(fn) { try { return fn(); } catch (e) { return null; } }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function status(msg, err) {
    var s = $('status');
    s.textContent = msg || '';
    s.classList.toggle('error', !!err);
  }

  // ------------------------------------------------------------- date
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3]) : null;
  }
  function isoDate(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function daysBetween(a, b) { return Math.round((b - a) / DAY_MS); }
  function weekday(d) { return (d.getDay() + 6) % 7; } // 0 = lunedì
  // Il ciclo parte dal lunedì della settimana che segue il giorno del test
  // (test di domenica → lunedì dopo; test a metà settimana → quella settimana è la 1).
  function anchor(d) { var x = addDays(d, 1); return addDays(x, -weekday(x)); }
  function fmtDate(d, long) {
    return d.toLocaleDateString('it-IT', long
      ? { weekday: 'long', day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'short', year: '2-digit' });
  }

  // ------------------------------------------------------------- parametri e test
  function tests() {
    return (data.test || []).slice().sort(function (a, b) { return a.data < b.data ? -1 : 1; });
  }
  function param(id) {
    for (var i = 0; i < data.parametri.length; i++) if (data.parametri[i].id === id) return data.parametri[i];
    return null;
  }
  // Valori di un parametro nei test, dal più vecchio
  function history(id) {
    return tests().filter(function (t) { return t.valori && t.valori[id] != null; })
      .map(function (t) { return { data: t.data, v: t.valori[id] }; });
  }
  function current(id) { var h = history(id); return h.length ? h[h.length - 1].v : null; }
  function previous(id) { var h = history(id); return h.length > 1 ? h[h.length - 2].v : null; }

  function fmtNum(v) { return String(Math.round(v * 10) / 10).replace('.', ','); }
  function fmtVal(p, v) {
    if (v == null) return '—';
    if (p.tempo) {
      var s = Math.round(v);
      return s >= 60 ? Math.floor(s / 60) + '′' + (s % 60 < 10 ? '0' : '') + (s % 60) + '″' : s + '″';
    }
    return fmtNum(v);
  }
  function fmtDelta(p, d) {
    var sign = d > 0 ? '+' : '−';
    var a = Math.abs(d);
    return sign + (p.tempo ? fmtVal(p, a) : fmtNum(a) + ' ' + p.unita);
  }
  // Accetta "250", "84,5", "2:30" (minuti:secondi)
  function parseVal(p, s) {
    s = String(s).trim().replace(',', '.');
    if (!s) return null;
    var m = /^(\d+):(\d{1,2})$/.exec(s);
    var v = m ? (+m[1]) * 60 + (+m[2]) : Number(s);
    return isFinite(v) && v > 0 ? v : NaN;
  }

  // ------------------------------------------------------------- ciclo 3 + 1
  function cycle() {
    var t = tests();
    var last = t.length ? parseDate(t[t.length - 1].data) : today();
    var start = parseDate(data.inizio) || last;
    var w = Math.max(0, Math.floor(daysBetween(anchor(last), today()) / 7)) + 1; // settimana del ciclo, da 1
    var blocchi = t.filter(function (x) { var d = parseDate(x.data); return d && d > start; }).length;
    var carico = 3 * blocchi + Math.min(w, 3); // settimane di carico fatte, scarichi esclusi
    var fase = Math.min(6, Math.ceil(carico / 2));
    return {
      week: w,
      deload: w === 4,
      late: w > 4,
      fase: fase,
      ultimo: last,
      prossimo: addDays(anchor(last), 27)
    };
  }

  function phaseRow(n) {
    var found = null;
    data.sezioni.forEach(function (s) {
      s.moduli.forEach(function (m) {
        m.tabelle.forEach(function (tab) {
          if (/^fase$/i.test(tab.colonne[0] || '')) {
            tab.righe.forEach(function (r) { if (r.c && String(r.c[0]) === String(n)) found = { tab: tab, row: r }; });
          }
        });
      });
    });
    return found;
  }
  function phaseText(n) {
    var f = phaseRow(n);
    if (!f) return 'fase ' + n;
    // Colonne: Fase, Settimane, Serie × tempo, Recupero, Totale
    return 'fase ' + n + ' · ' + f.row.c[2] + (f.row.c[3] ? ', rec ' + f.row.c[3] : '');
  }

  // ------------------------------------------------------------- formule nei testi
  function resolve(id, pct) {
    id = id.toUpperCase();
    if (id === 'FASE') {
      var c = cycle();
      return { text: phaseText(c.fase), title: c.deload ? 'Settimana di scarico: ripeti questa fase' : 'Fase in corso' };
    }
    var p = param(id);
    var v = current(id);
    if (v == null) return { text: '?', title: 'Manca il valore di ' + id + ': inseriscilo nei test' };
    if (pct == null) return { text: fmtNum(v), title: (p ? p.nome : id) + ' dall\'ultimo test' };
    var k = Number(String(pct).replace(',', '.'));
    return {
      text: String(Math.round(v * k / 100)),
      title: fmtNum(k) + '% di ' + (p ? p.nome : id) + ' ' + fmtNum(v) + (p ? ' ' + p.unita : '')
    };
  }
  function plain(s) {
    return String(s == null ? '' : s).replace(TOKEN, function (_, id, pct) { return resolve(id, pct).text; });
  }
  function rich(node, s) {
    node.textContent = '';
    s = String(s == null ? '' : s);
    var last = 0;
    s.replace(TOKEN, function (m, id, pct, at) {
      if (at > last) node.appendChild(document.createTextNode(s.slice(last, at)));
      var r = resolve(id, pct);
      var span = el('span', 'sk-calc', r.text);
      span.title = r.title;
      node.appendChild(span);
      last = at + m.length;
      return m;
    });
    if (last < s.length) node.appendChild(document.createTextNode(s.slice(last)));
  }

  // Lega un elemento a un testo dei dati: in lettura mostra le formule calcolate, in modifica il testo grezzo.
  function bind(node, get, set) {
    node.dataset.ed = '1';
    setters.set(node, set);
    if (editing) { node.textContent = get() || ''; node.contentEditable = 'true'; }
    else rich(node, get());
    return node;
  }

  function cellGet(row, i) {
    var v = row.c[i];
    return (v && typeof v === 'object') ? (v[variant] || '') : (v || '');
  }
  function cellSet(row, i, text) {
    var v = row.c[i];
    if (v && typeof v === 'object') v[variant] = text; else row.c[i] = text;
  }

  // ------------------------------------------------------------- render
  function render() {
    bind($('titolo'), function () { return data.titolo; }, function (t) { data.titolo = t; });
    bind($('sottotitolo'), function () { return data.sottotitolo; }, function (t) { data.sottotitolo = t; });
    document.title = data.titolo || 'Scheda allenamento';

    var meta = $('meta');
    meta.textContent = '';
    (data.meta || []).forEach(function (m) {
      var d = el('div');
      d.appendChild(bind(el('dt'), function () { return m[0]; }, function (t) { m[0] = t; }));
      d.appendChild(bind(el('dd'), function () { return m[1]; }, function (t) { m[1] = t; }));
      meta.appendChild(d);
    });

    renderNow();
    renderKpis();
    renderSections();
    renderWeek();
    renderTests();
    renderRules();

    var c = cycle();
    $('piede').textContent = 'Watt e FC calcolati su FTP ' + fmtVal(param('FTP') || {}, current('FTP')) + ' W · LTHR ' +
      fmtVal({}, current('LTHR')) + ' · FC max ' + fmtVal({}, current('FCMAX')) + ' · ultimo test ' + fmtDate(c.ultimo);
  }

  function renderNow() {
    var box = $('now');
    box.textContent = '';
    var c = cycle();
    var t = today();
    var row = data.settimana[variant].righe[weekday(t)];

    var head = el('div', 'sk-now-head');
    head.appendChild(el('span', 'sk-eyebrow', 'Oggi'));
    head.appendChild(el('span', 'sk-now-date', fmtDate(t, true)));
    box.appendChild(head);

    var slots = el('div', 'sk-now-slots');
    [1, 4].forEach(function (k) {
      if (!row) return;
      var s = el('div', 'sk-slotcard ' + (KIND[row[k + 2]] || 'k-facile'));
      s.appendChild(el('span', 'sk-slot-when', k === 1 ? 'Mattina · ' + row[k] : 'Pomeriggio · ' + row[k]));
      var what = el('span', 'sk-slot-what');
      rich(what, row[k + 1]);
      s.appendChild(what);
      slots.appendChild(s);
    });
    box.appendChild(slots);

    var facts = el('dl', 'sk-facts');
    function fact(k, v, cls) {
      var d = el('div', cls);
      d.appendChild(el('dt', null, k));
      var dd = el('dd');
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
      d.appendChild(dd);
      facts.appendChild(d);
    }
    var bar = el('span', 'sk-cycle');
    for (var i = 1; i <= 4; i++) {
      var dot = el('i', i === 4 ? 'is-deload' : null);
      if (i < Math.min(c.week, 5)) dot.className += ' is-done';
      if (i === c.week) dot.className += ' is-now';
      bar.appendChild(dot);
    }
    var cyc = el('span', 'sk-cycle-wrap');
    cyc.appendChild(bar);
    cyc.appendChild(document.createTextNode(c.late ? 'test in ritardo'
      : 'settimana ' + c.week + ' di 4 · ' + (c.deload ? 'scarico' : 'carico')));
    fact('Ciclo', cyc);
    fact('Isometria lunga', (c.deload ? 'scarico: ripeti ' : '') + phaseText(c.fase));
    var dd = daysBetween(t, c.prossimo);
    fact('Prossimo test', c.late || dd < 0 ? 'adesso: sei oltre le 4 settimane'
      : fmtDate(c.prossimo, true) + (dd === 0 ? ' · oggi' : ' · tra ' + dd + (dd === 1 ? ' giorno' : ' giorni')),
      c.late || dd <= 0 ? 'is-alert' : null);
    box.appendChild(facts);
  }

  function renderKpis() {
    var box = $('kpis');
    box.textContent = '';
    ['FTP', 'LTHR', 'FCMAX', 'PESO'].forEach(function (id) {
      var p = param(id);
      if (!p) return;
      var v = current(id);
      var pv = previous(id);
      var k = el('div', 'sk-kpi');
      k.appendChild(el('span', 'sk-kpi-label', p.nome));
      var val = el('span', 'sk-kpi-value', fmtVal(p, v));
      val.appendChild(el('small', null, ' ' + p.unita));
      k.appendChild(val);
      var sub = el('span', 'sk-kpi-sub');
      if (id === 'FTP' && v && current('PESO')) sub.textContent = fmtNum(Math.round(v / current('PESO') * 100) / 100) + ' W/kg';
      if (pv != null && v !== pv) {
        var d = el('span', 'sk-delta ' + (p.neutro ? '' : (v > pv ? 'is-up' : 'is-down')), fmtDelta(p, v - pv));
        if (sub.textContent) sub.appendChild(document.createTextNode(' · '));
        sub.appendChild(d);
      }
      var h = history(id);
      if (!sub.textContent && h.length) sub.textContent = 'test ' + fmtDate(parseDate(h[h.length - 1].data));
      k.appendChild(sub);
      box.appendChild(k);
    });
    var go = el('a', 'sk-kpi sk-kpi-go', null);
    go.href = '#test';
    go.appendChild(el('span', 'sk-kpi-label', 'Test del mese'));
    go.appendChild(el('span', 'sk-kpi-go-text', 'Inserisci i risultati →'));
    go.addEventListener('click', function (e) {
      e.preventDefault();
      $('test').scrollIntoView({ behavior: 'smooth', block: 'start' });
      var first = $('test-fields').querySelector('input');
      if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 400);
    });
    box.appendChild(go);
  }

  function slug(s, i) { return 'sez-' + i; }

  function renderSections() {
    var content = $('content');
    var toc = $('toc');
    content.textContent = '';
    toc.textContent = '';
    data.sezioni.forEach(function (sez, si) {
      var id = slug(sez.titolo, si);
      var section = el('section', 'sk-section sk-tone-' + (si % 6));
      section.id = id;
      section.appendChild(bind(el('h2', 'sk-section-title'),
        function () { return sez.titolo; }, function (t) { sez.titolo = t; }));
      var grid = el('div', 'sk-modules');
      sez.moduli.forEach(function (mod) { grid.appendChild(renderModule(mod)); });
      section.appendChild(grid);
      content.appendChild(section);

      var a = el('a', 'sk-tone-' + (si % 6));
      a.href = '#' + id;
      rich(a, sez.titolo);
      toc.appendChild(a);
    });
    [['settimana', 'Settimana tipo'], ['test', 'Test'], ['regole', 'Regole']].forEach(function (x) {
      var a = el('a', 'sk-toc-extra', x[1]);
      a.href = '#' + x[0];
      toc.appendChild(a);
    });
  }

  function renderModule(mod) {
    var card = el('article', 'card sk-module');
    var head = el('div', 'sk-module-head');
    head.appendChild(bind(el('span', 'sk-tag'), function () { return mod.tag; }, function (t) { mod.tag = t; }));
    head.appendChild(bind(el('h3'), function () { return mod.nome; }, function (t) { mod.nome = t; }));
    var day = bind(el('span', 'sk-day'), function () { return mod.giorno || ''; }, function (t) { mod.giorno = t; });
    if (!mod.giorno && !editing) day.hidden = true;
    head.appendChild(day);
    card.appendChild(head);

    mod.tabelle.forEach(function (tab) {
      var isList = tab.colonne.length === 2 && !tab.numeri;
      card.appendChild(isList ? renderList(tab) : renderTable(tab));
    });

    (mod.note || []).forEach(function (n) {
      if (n.v && n.v !== variant) return;
      card.appendChild(bind(el('p', 'sk-note' + (n.v ? ' sk-note-' + n.v : '')),
        function () { return n.t; }, function (t) { n.t = t; }));
    });
    return card;
  }

  function delButton(tab, ri) {
    var b = el('button', 'sk-x', '✕');
    b.type = 'button';
    b.setAttribute('aria-label', 'Elimina riga');
    b.addEventListener('click', function () { tab.righe.splice(ri, 1); changed(true); });
    return b;
  }

  function addButtons(tab) {
    var ncol = tab.colonne.length;
    var add = el('div', 'sk-add');
    var b1 = el('button', null, '+ Riga');
    b1.type = 'button';
    b1.addEventListener('click', function () {
      var c = [];
      for (var i = 0; i < ncol; i++) c.push(i === 0 ? 'Nuovo esercizio' : '—');
      tab.righe.push({ c: c });
      changed(true);
    });
    var b2 = el('button', null, '+ Titoletto');
    b2.type = 'button';
    b2.addEventListener('click', function () { tab.righe.push({ sub: 'Nuovo blocco' }); changed(true); });
    add.appendChild(b1);
    add.appendChild(b2);
    return add;
  }

  // Tabelle a due colonne (esercizio → dose): lista leggibile anche su telefono
  function renderList(tab) {
    var box = el('div', 'sk-list');
    tab.righe.forEach(function (row, ri) {
      var item;
      if (row.sub != null) {
        item = el('div', 'sk-sub');
        item.appendChild(bind(el('span'), function () { return row.sub; }, function (t) { row.sub = t; }));
      } else {
        item = el('div', 'sk-item');
        item.appendChild(bind(el('span', 'sk-ex'), function () { return cellGet(row, 0); }, function (t) { cellSet(row, 0, t); }));
        var dose = bind(el('span', 'sk-dose'), function () { return cellGet(row, 1); }, function (t) { cellSet(row, 1, t); });
        if (row.c[1] && typeof row.c[1] === 'object') {
          dose.classList.add('sk-var');
          dose.title = 'Cambia col tipo di weekend';
        }
        item.appendChild(dose);
      }
      if (editing) item.appendChild(delButton(tab, ri));
      box.appendChild(item);
    });
    if (editing) box.appendChild(addButtons(tab));
    return box;
  }

  function renderTable(tab) {
    var wrap = el('div', 'scroll sk-scroll');
    var table = el('table', 'sk-table' + (tab.numeri ? ' sk-num' : ''));
    var ncol = tab.colonne.length;
    var isPhase = /^fase$/i.test(tab.colonne[0] || '');
    var c = isPhase ? cycle() : null;

    var thead = el('thead');
    var hr = el('tr');
    tab.colonne.forEach(function (_, i) {
      hr.appendChild(bind(el('th'), function () { return tab.colonne[i]; }, function (t) { tab.colonne[i] = t; }));
    });
    if (editing) hr.appendChild(el('th', 'sk-x-col'));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    tab.righe.forEach(function (row, ri) {
      var tr = el('tr');
      if (row.sub != null) {
        tr.className = 'sk-subrow';
        var td = bind(el('td'), function () { return row.sub; }, function (t) { row.sub = t; });
        td.colSpan = ncol;
        tr.appendChild(td);
      } else {
        if (isPhase && String(row.c[0]) === String(c.fase)) {
          tr.className = 'sk-cur';
          tr.title = c.deload ? 'Scarico: ripeti questa fase' : 'Fase in corso';
        }
        for (var i = 0; i < ncol; i++) {
          (function (i) {
            var td = bind(el('td'), function () { return cellGet(row, i); }, function (t) { cellSet(row, i, t); });
            if (row.c[i] && typeof row.c[i] === 'object') td.classList.add('sk-var');
            if (i > 0 && /\[(FTP|LTHR|FCMAX|PESO) /i.test(cellGet(row, i))) td.classList.add('sk-nw');
            tr.appendChild(td);
          })(i);
        }
      }
      if (editing) {
        var x = el('td', 'sk-x-col');
        x.appendChild(delButton(tab, ri));
        tr.appendChild(x);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (!editing) return wrap;
    var box = el('div');
    box.appendChild(wrap);
    box.appendChild(addButtons(tab));
    return box;
  }

  function renderWeek() {
    var w = data.settimana[variant];
    $('week-title').textContent = 'Settimana tipo · ' + LABEL[variant];
    var box = $('week');
    box.textContent = '';
    var todayIdx = weekday(today());
    w.righe.forEach(function (r, i) {
      var day = el('div', 'sk-dayc' + (i === todayIdx ? ' is-today' : ''));
      var name = el('div', 'sk-dayc-name');
      name.appendChild(bind(el('span'), function () { return r[0]; }, function (t) { r[0] = t; }));
      if (i === todayIdx) name.appendChild(el('span', 'sk-today', 'oggi'));
      day.appendChild(name);
      [1, 4].forEach(function (k) {
        var s = el('div', 'sk-dslot ' + (KIND[r[k + 2]] || 'k-facile'));
        s.appendChild(bind(el('span', 'sk-dslot-label'), function () { return r[k]; }, function (t) { r[k] = t; }));
        s.appendChild(bind(el('span', 'sk-dslot-text'), function () { return r[k + 1]; }, function (t) { r[k + 1] = t; }));
        day.appendChild(s);
      });
      box.appendChild(day);
    });
    bind($('week-note'), function () { return w.nota; }, function (t) { w.nota = t; });
  }

  function renderRules() {
    var ul = $('rules');
    ul.textContent = '';
    data.regole.forEach(function (r) {
      var li = el('li');
      li.appendChild(bind(el('b'), function () { return r[0]; }, function (t) { r[0] = t; }));
      var span = el('span');
      span.appendChild(bind(el('span'), function () { return r[1]; }, function (t) { r[1] = t; }));
      li.appendChild(span);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------- test
  function spark(h) {
    var NS = 'http://www.w3.org/2000/svg';
    var W = 88, H = 26, P = 3;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'sk-spark');
    svg.setAttribute('aria-hidden', 'true');
    if (!h.length) return svg;
    var vs = h.map(function (x) { return x.v; });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (hi === lo) { lo -= 1; hi += 1; }
    var pts = h.map(function (x, i) {
      var px = h.length === 1 ? W - P : P + i * (W - 2 * P) / (h.length - 1);
      var py = H - P - (x.v - lo) / (hi - lo) * (H - 2 * P);
      return [px, py];
    });
    if (pts.length > 1) {
      var line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '));
      svg.appendChild(line);
    }
    var last = pts[pts.length - 1];
    var dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', last[0]);
    dot.setAttribute('cy', last[1]);
    dot.setAttribute('r', 2.5);
    svg.appendChild(dot);
    return svg;
  }

  function renderTests() {
    var c = cycle();
    $('test-when').textContent = 'prossimo: ' + fmtDate(c.prossimo);

    // Campi: si ricreano solo se non c'è niente di scritto, per non perdere un inserimento a metà
    var fields = $('test-fields');
    var typing = Array.prototype.some.call(fields.querySelectorAll('input'), function (i) { return i.value; });
    if (!typing) {
      fields.textContent = '';
      data.parametri.forEach(function (p) {
        var f = el('label', 'sk-field');
        var top = el('span', 'sk-field-top');
        top.appendChild(el('span', null, p.nome));
        top.appendChild(el('small', null, p.tempo ? 'm:ss' : p.unita));
        f.appendChild(top);
        var inp = el('input');
        inp.type = 'text';
        inp.inputMode = p.tempo ? 'text' : 'decimal';
        inp.name = p.id;
        inp.autocomplete = 'off';
        var cur = current(p.id);
        inp.placeholder = cur != null ? fmtVal(p, cur) : '—';
        f.appendChild(inp);
        if (p.come) f.appendChild(el('span', 'sk-field-hint', p.come));
        fields.appendChild(f);
      });
    }
    if (!$('t-data').value) $('t-data').value = isoDate(today());

    var table = $('test-history');
    table.textContent = '';
    var t = tests();
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'Parametro'));
    hr.appendChild(el('th', 'sk-hist-trend', 'Andamento'));
    t.slice().reverse().forEach(function (x) {
      var th = el('th', 'sk-hist-date');
      var d = parseDate(x.data);
      th.appendChild(el('span', null, d ? fmtDate(d) : x.data));
      var del = el('button', 'sk-x', '✕');
      del.type = 'button';
      del.title = 'Elimina il test del ' + (d ? fmtDate(d) : x.data);
      del.setAttribute('aria-label', del.title);
      del.addEventListener('click', function () {
        if (!confirm('Eliminare il test del ' + (d ? fmtDate(d, true) : x.data) + '?')) return;
        data.test.splice(data.test.indexOf(x), 1);
        changed(true);
        status('Test eliminato.');
      });
      th.appendChild(del);
      if (x.note) th.title = x.note;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    data.parametri.forEach(function (p) {
      var tr = el('tr');
      var th = el('th', null, p.nome);
      th.scope = 'row';
      tr.appendChild(th);
      var h = history(p.id);
      var tdT = el('td', 'sk-hist-trend');
      tdT.appendChild(spark(h));
      if (h.length > 1) {
        var d = h[h.length - 1].v - h[0].v;
        if (d) tdT.appendChild(el('span', 'sk-delta ' + (p.neutro ? '' : (d > 0 ? 'is-up' : 'is-down')), fmtDelta(p, d)));
      }
      tr.appendChild(tdT);
      t.slice().reverse().forEach(function (x) {
        var v = x.valori ? x.valori[p.id] : null;
        var td = el('td', v == null ? 'sk-empty' : null, v == null ? '·' : fmtVal(p, v));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    var notes = t.some(function (x) { return x.note; });
    if (notes) {
      var tr = el('tr', 'sk-hist-notes');
      tr.appendChild(el('th', null, 'Note'));
      tr.appendChild(el('td', 'sk-hist-trend'));
      t.slice().reverse().forEach(function (x) { tr.appendChild(el('td', null, x.note || '')); });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  $('test-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var date = $('t-data').value;
    if (!parseDate(date)) { status('Scegli la data del test.', true); return; }
    var vals = {}, bad = [], n = 0;
    data.parametri.forEach(function (p) {
      var inp = this.querySelector('input[name="' + p.id + '"]');
      var v = parseVal(p, inp.value);
      if (v === null) return;
      if (isNaN(v)) { bad.push(p.nome); return; }
      vals[p.id] = v;
      n++;
    }, this);
    if (bad.length) { status('Valore non valido: ' + bad.join(', ') + '.', true); return; }
    if (!n) { status('Inserisci almeno un risultato.', true); return; }

    var before = {};
    ['FTP', 'LTHR', 'FCMAX'].forEach(function (id) { before[id] = current(id); });

    data.test = data.test || [];
    var same = data.test.filter(function (x) { return x.data === date; })[0];
    if (same) Object.keys(vals).forEach(function (k) { same.valori[k] = vals[k]; });
    else data.test.push({ data: date, valori: vals, note: '' });
    var target = same || data.test[data.test.length - 1];
    var note = $('t-note').value.trim();
    if (note) target.note = note;

    this.reset();
    $('t-data').value = '';
    changed(true);

    var msg = [];
    ['FTP', 'LTHR', 'FCMAX'].forEach(function (id) {
      var a = before[id], b = current(id);
      if (a !== b && b != null) msg.push(param(id).nome + ' ' + fmtVal({}, a) + ' → ' + fmtVal({}, b));
    });
    status('Test del ' + fmtDate(parseDate(date)) + ' salvato su questo dispositivo.' +
      (msg.length ? ' ' + msg.join(', ') + ': watt e frequenze della scheda ricalcolati.' : '') +
      ' Per metterlo sul sito scarica il JSON e sostituisci scheda.json.');
  });

  // ------------------------------------------------------------- salvataggio
  function changed(rerender) {
    store(function () { localStorage.setItem(KEY_DATA, JSON.stringify(data)); });
    $('local').hidden = false;
    if (rerender) render();
  }

  document.addEventListener('input', function (e) {
    var n = e.target.closest && e.target.closest('[data-ed]');
    if (!n || !setters.has(n)) return;
    setters.get(n)(n.textContent.replace(/\s+/g, ' ').trim());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { changed(false); status('Salvato su questo dispositivo.'); }, 400);
  });

  // Invio = esci dal campo, niente a capo nelle celle
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.isContentEditable) { e.preventDefault(); e.target.blur(); }
  });

  // Incolla solo testo
  document.addEventListener('paste', function (e) {
    if (!e.target.isContentEditable) return;
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, t.replace(/\s+/g, ' '));
  });

  // ------------------------------------------------------------- comandi
  function showVariant() {
    document.querySelectorAll('.seg [data-v]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.v === variant));
    });
  }
  document.querySelectorAll('.seg [data-v]').forEach(function (b) {
    b.addEventListener('click', function () {
      variant = b.dataset.v;
      showVariant();
      store(function () { localStorage.setItem(KEY_VAR, variant); });
      if (data) render();
    });
  });

  $('edit').addEventListener('click', function () {
    editing = !editing;
    this.setAttribute('aria-pressed', String(editing));
    this.textContent = editing ? 'Fine modifiche' : 'Modifica';
    document.body.classList.toggle('sk-editing', editing);
    $('edit-hint').hidden = !editing;
    if (data) render();
  });

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function closeMenu() { document.querySelector('.sk-more').open = false; }

  $('dl-json').addEventListener('click', function () {
    download('scheda.json', JSON.stringify(data, null, 2) + '\n', 'application/json');
    closeMenu();
  });

  $('dl-csv').addEventListener('click', function () {
    var q = function (s) { s = plain(s); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var val = function (v) { return (v && typeof v === 'object') ? (v.fly + ' | DZ: ' + v.dz) : v; };
    var lines = [];
    lines.push(['Parametro'].concat(tests().map(function (t) { return t.data; })).map(q).join(';'));
    data.parametri.forEach(function (p) {
      lines.push([p.nome + ' (' + p.unita + ')'].concat(tests().map(function (t) {
        var v = t.valori[p.id]; return v == null ? '' : fmtVal(p, v);
      })).map(q).join(';'));
    });
    lines.push('');
    data.sezioni.forEach(function (sez) {
      sez.moduli.forEach(function (mod) {
        mod.tabelle.forEach(function (tab) {
          lines.push([sez.titolo, mod.tag + ' ' + mod.nome, mod.giorno || ''].concat(tab.colonne).map(q).join(';'));
          var blocco = '';
          tab.righe.forEach(function (r) {
            if (r.sub != null) { blocco = r.sub; return; }
            lines.push(['', blocco, ''].concat(r.c.map(val)).map(q).join(';'));
          });
          lines.push('');
        });
      });
    });
    ['fly', 'dz'].forEach(function (v) {
      lines.push(['Settimana tipo', LABEL[v], '', 'Giorno', 'Mattina', 'Pomeriggio'].map(q).join(';'));
      data.settimana[v].righe.forEach(function (r) {
        lines.push(['', '', '', r[0], r[1] + ': ' + r[2], r[4] + ': ' + r[5]].map(q).join(';'));
      });
      lines.push('');
    });
    download('scheda.csv', '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
    closeMenu();
  });

  $('print').addEventListener('click', function () { closeMenu(); window.print(); });

  function valid(d) {
    return d && Array.isArray(d.sezioni) && d.settimana && Array.isArray(d.parametri) && Array.isArray(d.test);
  }

  $('load').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!valid(d)) throw new Error('struttura');
        data = d;
        changed(true);
        status('Scheda caricata da ' + f.name + '.');
      } catch (e) {
        status('Questo file non è una scheda valida: scegli un JSON scaricato da questa pagina.', true);
      }
    };
    reader.readAsText(f);
    this.value = '';
    closeMenu();
  });

  $('reset').addEventListener('click', function () {
    if (!confirm('Tornare alla scheda del sito? Le modifiche e i test salvati solo su questo dispositivo andranno persi.')) return;
    store(function () { localStorage.removeItem(KEY_DATA); });
    $('local').hidden = true;
    loadDefault().then(function () { status('Tornato alla scheda del sito.'); });
  });

  // ------------------------------------------------------------- avvio
  function loadDefault() {
    return fetch('scheda.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { data = d; render(); })
      .catch(function () {
        status('Non riesco a leggere scheda.json. Apri la pagina dal sito, non dal file sul computer.', true);
      });
  }

  var savedVar = store(function () { return localStorage.getItem(KEY_VAR); });
  if (savedVar === 'dz' || savedVar === 'fly') { variant = savedVar; showVariant(); }

  var saved = store(function () { return localStorage.getItem(KEY_DATA); });
  var parsed = null;
  try { parsed = saved ? JSON.parse(saved) : null; } catch (e) { parsed = null; }
  if (valid(parsed)) {
    data = parsed;
    $('local').hidden = false;
    render();
  } else {
    loadDefault();
  }
})();
