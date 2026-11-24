// TaxaBog Job share page (docs/plans/1.2.0-jobs-step7.md G1, G4; the
// "Grundlægger" mark: docs/plans/1.2.0-jobs-step8df.md §4.1).
// Reads ?id=<uuid>, fetches the public view of ONE live post from the edge
// function job-share (no login, no key) and shows it. Text only via
// textContent, never innerHTML. "Åbn i TaxaBog" uses the app scheme (a
// universal link to the same site does not open the app from Safari).
(function () {
  'use strict';

  var FN = 'https://zcvayaoyhrnzhvocmuuq.supabase.co/functions/v1/job-share';
  var PLAY = 'https://play.google.com/store/apps/details?id=dk.egydan.taxabog';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var TZ = 'Europe/Copenhagen';

  var VAGT = { taxa: 'Taxa', flex: 'Flextrafik' };
  var EMPLOYMENT = { fast: 'Fast', deltid: 'Deltid', afloeser: 'Afløser' };
  var SCHEDULE = { dag: 'Dag', aften: 'Aften', nat: 'Nat', weekend: 'Weekend' };

  function el(id) { return document.getElementById(id); }
  function show(id) { el('loading').hidden = true; el(id).hidden = false; }
  function labels(list, map) {
    return (Array.isArray(list) ? list : []).map(function (k) { return map[k] || ''; }).filter(Boolean);
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  var dayFmt = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  var wdFmt = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, weekday: 'short' });
  var timeFmt = new Intl.DateTimeFormat('da-DK', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  var keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  function hhmm(d) { return timeFmt.format(d).replace('.', ':'); }

  // "Fre. 27. nov. 22:00 – lør. 06:00" (Copenhagen time); same day: "… 07:00 – 15:00".
  function shiftLine(s) {
    var a = new Date(s.starts_at);
    var b = new Date(s.ends_at);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return '';
    var sameDay = keyFmt.format(a) === keyFmt.format(b);
    return cap(dayFmt.format(a)) + ' ' + hhmm(a) + ' – ' + (sameDay ? '' : wdFmt.format(b) + ' ') + hhmm(b);
  }

  function openAppHref(id) {
    var path = 'job/post?id=' + encodeURIComponent(id);
    if (/android/i.test(navigator.userAgent)) {
      return 'intent://' + path + '#Intent;scheme=taxabog;package=dk.egydan.taxabog;S.browser_fallback_url=' +
        encodeURIComponent(PLAY) + ';end';
    }
    return 'taxabog://' + path;
  }

  function render(p, id) {
    var tags = el('tags');
    var kind = document.createElement('span');
    kind.className = 'share-tag' + (p.kind === 'akut' ? ' akut' : '');
    kind.textContent = p.kind === 'akut' ? 'Akut vagt' : 'Fast job';
    tags.appendChild(kind);
    labels(p.vagt_types, VAGT).forEach(function (t) {
      var x = document.createElement('span');
      x.className = 'share-tag';
      x.textContent = t;
      tags.appendChild(x);
    });

    el('title').textContent = String(p.title || '');
    document.title = String(p.title || 'Opslag') + ' · TaxaBog Job';

    var area = [p.postnr, p.city].filter(Boolean).join(' ');
    if (area) el('area').textContent = area; else el('area').hidden = true;

    var work = labels(p.employment ? [p.employment] : [], EMPLOYMENT).concat(labels(p.schedule, SCHEDULE));
    if (work.length) el('work').textContent = work.join(' · '); else el('work').hidden = true;

    var shifts = Array.isArray(p.shifts) ? p.shifts : [];
    if (shifts.length) {
      var ul = el('shifts');
      shifts.forEach(function (s) {
        var line = shiftLine(s);
        if (!line) return;
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      ul.hidden = ul.childNodes.length === 0;
    }

    el('company').textContent = String(p.company || '');
    el('founder').hidden = p.founding !== true;   // "Grundlægger" (step 8d)
    el('open-app').setAttribute('href', openAppHref(id));
    show('post');
    el('open').hidden = false;
  }

  var id = new URLSearchParams(window.location.search).get('id') || '';
  if (!UUID.test(id)) {
    show('gone');
    return;
  }

  fetch(FN + '?id=' + encodeURIComponent(id.toLowerCase()), { method: 'GET', credentials: 'omit' })
    .then(function (res) {
      if (res.status === 404) { show('gone'); return null; }
      if (!res.ok) throw new Error('status');
      return res.json();
    })
    .then(function (p) {
      if (!p) return;
      if (typeof p !== 'object' || !p.title) { show('gone'); return; }
      render(p, id.toLowerCase());
    })
    .catch(function () { show('error'); });
})();
