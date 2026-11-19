// Scheda allenamento: legge scheda.json, la mostra, la rende modificabile e scaricabile.
// Le modifiche restano nel browser (localStorage); il JSON scaricato sostituisce scheda.json nel repo.
(function () {
  'use strict';

  var KEY_DATA = 'scheda-dati-v1';
  var KEY_VAR = 'scheda-variante';
  var LABEL = { fly: 'weekend volo performance', dz: 'weekend in DZ a lavorare' };

  var data = null;
  var variant = 'fly';
  var editing = false;
  var setters = new WeakMap();
  var saveTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var content = $('content');

  function store(get) { try { return get(); } catch (e) { return null; } }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Lega un elemento a un valore dei dati: lo mostra e, in modifica, lo aggiorna.
  function bind(node, get, set) {
    node.textContent = get();
    node.dataset.ed = '1';
    setters.set(node, set);
    if (editing) node.contentEditable = 'true';
    return node;
  }

  // Valore di una cella che può avere due varianti {fly, dz}
  function cellGet(row, i) {
    var v = row.c[i];
    return (v && typeof v === 'object') ? (v[variant] || '') : (v || '');
  }
  function cellSet(row, i, text) {
    var v = row.c[i];
    if (v && typeof v === 'object') v[variant] = text; else row.c[i] = text;
  }

  function status(msg, err) {
    var s = $('status');
    s.textContent = msg || '';
    s.classList.toggle('error', !!err);
  }

  // ------------------------------------------------------------- render
  function render() {
    bind($('titolo'), function () { return data.titolo; }, function (t) { data.titolo = t; });
    bind($('sottotitolo'), function () { return data.sottotitolo; }, function (t) { data.sottotitolo = t; });
    document.title = data.titolo || 'Scheda allenamento';

    var meta = $('meta');
    meta.textContent = '';
    data.meta.forEach(function (m) {
      var d = el('div');
      d.appendChild(bind(el('dt'), function () { return m[0]; }, function (t) { m[0] = t; }));
      d.appendChild(bind(el('dd'), function () { return m[1]; }, function (t) { m[1] = t; }));
      meta.appendChild(d);
    });

    content.textContent = '';
    data.sezioni.forEach(function (sez) {
      var section = el('section', 'sk-section');
      section.appendChild(bind(el('h2', 'sk-section-title'),
        function () { return sez.titolo; }, function (t) { sez.titolo = t; }));
      var grid = el('div', 'sk-modules');
      sez.moduli.forEach(function (mod) { grid.appendChild(renderModule(mod)); });
      section.appendChild(grid);
      content.appendChild(section);
    });

    renderWeek();
    renderRules();
    bind($('piede'), function () { return data.piede; }, function (t) { data.piede = t; });
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

    mod.tabelle.forEach(function (tab) { card.appendChild(renderTable(tab)); });

    (mod.note || []).forEach(function (n) {
      if (n.v && n.v !== variant) return;
      card.appendChild(bind(el('p', 'sk-note' + (n.v ? ' sk-note-' + n.v : '')),
        function () { return n.t; }, function (t) { n.t = t; }));
    });
    return card;
  }

  function renderTable(tab) {
    var wrap = el('div', 'scroll sk-scroll');
    var table = el('table', 'sk-table' + (tab.numeri ? ' sk-num' : ''));
    var ncol = tab.colonne.length;

    var thead = el('thead');
    var hr = el('tr');
    tab.colonne.forEach(function (c, i) {
      hr.appendChild(bind(el('th'), function () { return tab.colonne[i]; }, function (t) { tab.colonne[i] = t; }));
    });
    if (editing) hr.appendChild(el('th', 'sk-x-col'));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    tab.righe.forEach(function (row, ri) {
      var tr = el('tr');
      if (row.sub != null) {
        tr.className = 'sk-sub';
        var td = bind(el('td'), function () { return row.sub; }, function (t) { row.sub = t; });
        td.colSpan = ncol;
        tr.appendChild(td);
      } else {
        for (var i = 0; i < ncol; i++) {
          (function (i) {
            var td = bind(el('td', i === 0 ? 'sk-ex' : 'sk-val'),
              function () { return cellGet(row, i); }, function (t) { cellSet(row, i, t); });
            var v = row.c[i];
            if (v && typeof v === 'object') td.classList.add('sk-var');
            tr.appendChild(td);
          })(i);
        }
      }
      if (editing) {
        var x = el('td', 'sk-x-col');
        var b = el('button', 'sk-x', '✕');
        b.type = 'button';
        b.setAttribute('aria-label', 'Elimina riga');
        b.addEventListener('click', function () { tab.righe.splice(ri, 1); changed(true); });
        x.appendChild(b);
        tr.appendChild(x);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (!editing) return wrap;
    var box = el('div');
    box.appendChild(wrap);
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
    box.appendChild(add);
    return box;
  }

  var KIND = { duro: 'sk-hard', forte: 'sk-strong', facile: 'sk-easy', volo: 'sk-fly' };

  function renderWeek() {
    var w = data.settimana[variant];
    $('week-title').textContent = 'Settimana tipo · ' + LABEL[variant];
    var table = $('week');
    table.textContent = '';
    var thead = el('thead');
    var hr = el('tr');
    ['Giorno', 'Mattina', 'Pomeriggio'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    w.righe.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(bind(el('td', 'sk-dayname'), function () { return r[0]; }, function (t) { r[0] = t; }));
      [1, 4].forEach(function (k) {
        var td = el('td');
        td.appendChild(bind(el('span', 'sk-slot'), function () { return r[k]; }, function (t) { r[k] = t; }));
        td.appendChild(bind(el('span', KIND[r[k + 2]] || 'sk-easy'), function () { return r[k + 1]; }, function (t) { r[k + 1] = t; }));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    bind($('week-note'), function () { return w.nota; }, function (t) { w.nota = t; });
  }

  function renderRules() {
    var ul = $('rules');
    ul.textContent = '';
    data.regole.forEach(function (r) {
      var li = el('li');
      li.appendChild(bind(el('b'), function () { return r[0]; }, function (t) { r[0] = t; }));
      li.appendChild(document.createTextNode(': '));
      li.appendChild(bind(el('span'), function () { return r[1]; }, function (t) { r[1] = t; }));
      ul.appendChild(li);
    });
  }

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
  function setVariant(v) {
    variant = v;
    document.querySelectorAll('.seg [data-v]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.v === v));
    });
    store(function () { localStorage.setItem(KEY_VAR, v); });
    render();
  }
  document.querySelectorAll('.seg [data-v]').forEach(function (b) {
    b.addEventListener('click', function () { setVariant(b.dataset.v); });
  });

  $('edit').addEventListener('click', function () {
    editing = !editing;
    this.setAttribute('aria-pressed', String(editing));
    this.textContent = editing ? 'Fine modifiche' : 'Modifica';
    document.body.classList.toggle('sk-editing', editing);
    $('edit-hint').hidden = !editing;
    render();
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

  $('dl-json').addEventListener('click', function () {
    download('scheda.json', JSON.stringify(data, null, 2) + '\n', 'application/json');
  });

  $('dl-csv').addEventListener('click', function () {
    var q = function (s) { s = String(s == null ? '' : s); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var val = function (v) { return (v && typeof v === 'object') ? (v.fly + ' | DZ: ' + v.dz) : v; };
    var lines = [];
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
  });

  $('print').addEventListener('click', function () { window.print(); });

  $('load').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!d || !Array.isArray(d.sezioni) || !d.settimana) throw new Error('struttura');
        data = d;
        changed(true);
        status('Scheda caricata da ' + f.name + '.');
      } catch (e) {
        status('Questo file non è una scheda valida: scegli un JSON scaricato da questa pagina.', true);
      }
    };
    reader.readAsText(f);
    this.value = '';
  });

  $('reset').addEventListener('click', function () {
    store(function () { localStorage.removeItem(KEY_DATA); });
    $('local').hidden = true;
    loadDefault().then(function () { status('Tornato alla scheda originale.'); });
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
  if (savedVar === 'dz' || savedVar === 'fly') {
    variant = savedVar;
    document.querySelectorAll('.seg [data-v]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.v === variant));
    });
  }

  var saved = store(function () { return localStorage.getItem(KEY_DATA); });
  var parsed = null;
  try { parsed = saved ? JSON.parse(saved) : null; } catch (e) { parsed = null; }
  if (parsed && Array.isArray(parsed.sezioni)) {
    data = parsed;
    $('local').hidden = false;
    render();
  } else {
    loadDefault();
  }
})();
