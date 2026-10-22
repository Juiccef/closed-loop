// Caregiver console. Plain HTML forms with labels, errors tied to fields, and a polite status region.

import { $, $$, SCOPE_NOTICE, SIMULATED_NOTICE, api, ensureAccess, esc, getConfig, loopGlyph, loopKind, onHouseholdReplaced, visitorHousehold } from '/shared/app.js';

/** This visitor's own demo household (see visitorHousehold in /shared/app.js). */
let H = null;
const state = { view: null, ledger: null, contactsRendered: false, editing: new Set(), kinds: new Map() };

$('#scope-notice').textContent = SCOPE_NOTICE;
$('#simulated-notice').textContent = SIMULATED_NOTICE;
$$('.legend-glyph').forEach((el) => (el.outerHTML = loopGlyph(el.dataset.state)));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function confirmDialog({ title, body, okLabel = 'Confirm', requireType = false }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-type-wrap').hidden = !requireType;
  $('#confirm-type').value = '';
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' && (!requireType || $('#confirm-type').value.trim().toLowerCase() === 'delete')),
      { once: true },
    );
    dlg.showModal();
    (requireType ? $('#confirm-type') : $('#confirm-ok')).focus();
  });
}

// ---- Hero ----

function renderHero(v) {
  const name = v.household.recipientName;
  const [date] = v.localNow.split(' ');
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  $('#hero-title').textContent = `${name}’s check-ins`;
  $('#hero-eyebrow').textContent = day;
  const statusText = {
    active: ['ok', 'Active'],
    paused: ['wait', `Paused until ${v.pausedUntilLocal}`],
    expired: ['bad', 'Plan expired: record consent again to resume'],
    revoked: ['bad', 'Consent revoked: no questions, no emails'],
    no_consent: ['bad', 'No consent recorded: check-ins are off'],
  }[v.status] || ['wait', v.status];
  const ends = v.consent && !v.consent.revokedAt ? new Date(v.consent.planExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const kv = (term, value, note = '') => `<div><dt>${esc(term)}</dt><dd>${value}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
  $('#plan-status').innerHTML = [
    kv('Status', `<span class="pill ${statusText[0]}">${esc(statusText[1])}</span>`),
    ends && v.status !== 'expired' ? kv('Plan', `Runs until ${esc(ends)}`, 'Then stops until consent is recorded again') : kv('Plan', 'Not running'),
    kv('Family emails today', `${esc(v.alertsToday)} of ${esc(v.ladder.dailyAlertCap)}`, 'Daily limit you set'),
    kv('Household time', esc(v.localNow.slice(11)), 'Simulated clock'),
  ].join('');
}

// ---- Ledger ----

const EMAIL_STATUS = {
  pending: 'Email about to be sent',
  sending: 'Email sending',
  sent: 'Email sent',
  suppressed_cap: 'Not emailed: daily email limit reached',
  waiting_quiet_hours: 'Email held until quiet hours end',
  failed: 'Email failed; retrying',
  cancelled: 'Email not needed',
};

function contactName(id) {
  return state.view?.household.contacts.find((c) => c.id === id)?.name;
}

function entryHtml(i) {
  const facts = [];
  facts.push(`Window ${i.window}`);
  if (i.askedAt) facts.push(`Asked ${i.askedAt}`);
  if (i.followUps) facts.push(`${i.followUps} follow-up${i.followUps > 1 ? 's' : ''}`);
  if (i.answeredAt) facts.push(`Answered ${i.answeredAt}`);
  if (i.deferredUntil && i.state === 'DEFERRED') facts.push(`Will ask again ${i.deferredUntil}`);
  if (i.alertStatus && i.alertStatus !== 'none') facts.push(EMAIL_STATUS[i.alertStatus] || i.alertStatus);
  if (i.needsHumanNote === 'sent') facts.push('Note sent: a call may help');
  const flags = [];
  if (i.safetyNote) flags.push(`Recorded as “${i.ledger}” rather than “done” (${i.safetyNote}).`);
  if (i.reviewFlag === 'needs_human') flags.push('A second check of the words flagged this for a person to follow up.');
  const words = i.lastWords ? `<blockquote class="words">“${esc(i.lastWords.text)}” <span class="when">(${esc(i.lastWords.at)})</span></blockquote>` : '';
  const ack = i.canAcknowledge
    ? `<button class="btn small act" type="button" data-ack="${esc(i.occurrenceId)}">I've been in touch<span class="visually-hidden">: acknowledge ${esc(i.label)}, ${esc(i.date)}</span></button>`
    : '';
  if (i.setBy) facts.splice(1, 0, `Closes when ${i.setBy} says it`, `Tells ${i.tell}`);
  const kind = loopKind(i.state);
  const changed = state.kinds.has(i.occurrenceId) && state.kinds.get(i.occurrenceId) !== kind;
  state.kinds.set(i.occurrenceId, kind);
  return `<li class="entry${changed ? ' changed' : ''}" data-kind="${kind}">
    ${loopGlyph(i.state)}
    <div>
      <h3>${esc(i.label)}${i.setBy ? ` <span class="tag">Set by ${esc(i.setBy)}</span>` : ''}</h3>
      <p class="said">${esc(i.ledger)}</p>
      <ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${flags.map((f) => `<p class="flag">${esc(f)}</p>`).join('')}
      ${words}
    </div>
    ${ack}
  </li>`;
}

function renderLedger(l) {
  const today = l.items.filter((i) => i.date === l.today);
  const earlier = l.items.filter((i) => i.date !== l.today);
  $('#ledger-today').innerHTML = today.length ? today.map(entryHtml).join('') : '<li class="help">No check-ins today.</li>';
  let html = '';
  let last = '';
  for (const i of earlier) {
    if (i.date !== last) {
      last = i.date;
      html += `<li class="day-label" aria-hidden="false">${esc(new Date(`${i.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</li>`;
    }
    html += entryHtml(i);
  }
  $('#ledger-earlier').innerHTML = html || '<li class="help">Nothing earlier yet.</li>';
  $('#activity-list').innerHTML = l.events
    .slice(0, 40)
    .map((e) => `<li><time datetime="${esc(e.at)}">${esc(e.local)}</time> <span class="what">${esc(e.detail)}</span></li>`)
    .join('');
}

// ---- Check-ins ----

function windowRow(prefix, w, idx) {
  return `<div class="window-row" data-window>
    <div class="field"><label for="${prefix}-ws${idx}">Window ${idx + 1} starts</label><input id="${prefix}-ws${idx}" type="time" value="${esc(w.start)}" required></div>
    <div class="field"><label for="${prefix}-we${idx}">ends</label><input id="${prefix}-we${idx}" type="time" value="${esc(w.end)}" required></div>
    <button class="btn ghost small" type="button" data-remove-window aria-label="Remove window ${idx + 1}">Remove</button>
  </div>`;
}

function checkinHtml(c, isNew = false) {
  const p = `chk-${c.id}`;
  const field = (name, label, value, { help = '', textarea = false, max = 80 } = {}) => `
    <div class="field">
      <label for="${p}-${name}">${label}</label>
      ${textarea ? `<textarea id="${p}-${name}" name="${name}" maxlength="${max}" aria-describedby="${p}-${name}-help ${p}-${name}-err">${esc(value)}</textarea>` : `<input id="${p}-${name}" name="${name}" maxlength="${max}" value="${esc(value)}" aria-describedby="${p}-${name}-help ${p}-${name}-err">`}
      <p class="help" id="${p}-${name}-help">${help}</p>
      <p class="error" id="${p}-${name}-err" aria-live="polite"></p>
    </div>`;
  const windows = c.windows.map((w, i) => `<span>${esc(w.start)}–${esc(w.end)}</span>`).join(', ');
  return `<details class="checkin" data-id="${esc(c.id)}" ${isNew ? 'open data-new' : ''}>
    <summary>${loopGlyph(c.active ? 'SCHEDULED' : 'PAUSED')}<span><span class="sum-title">${esc(c.label || 'New check-in')}</span><span class="sum-sub">${windows}${c.active ? '' : ' · turned off'}</span></span></summary>
    <form class="body" novalidate>
      ${field('label', 'What it is called', c.label, { help: 'Short and general, for example “your morning routine”.' })}
      ${field('prompt', 'The question, as it will be read aloud', c.prompt, { help: 'For example “Have you done your morning routine yet?”' })}
      <div class="grid-3">
        <div class="field"><label for="${p}-kind">Kind</label><select id="${p}-kind" name="kind">
          ${['routine', 'meal', 'wellbeing'].map((k) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}
        </select></div>
        <div class="field"><label for="${p}-reask">Ask again after (minutes)</label><input id="${p}-reask" name="reaskMinutes" type="number" min="15" max="240" value="${esc(c.reaskMinutes)}"></div>
        <div class="field"><label for="${p}-max">Follow-ups at most</label><input id="${p}-max" name="maxReasks" type="number" min="0" max="3" value="${esc(c.maxReasks)}"></div>
      </div>
      <fieldset><legend>When to ask</legend><div data-windows>${c.windows.map((w, i) => windowRow(p, w, i)).join('')}</div>
        <button class="btn ghost small" type="button" data-add-window>Add a window</button></fieldset>
      ${field('calmingLine', 'If they seem confused or upset, say this instead of asking', c.calmingLine, { help: 'Something you would say. It is the only thing said; no questions follow.', textarea: true, max: 160 })}
      <label class="switch-row"><input type="checkbox" role="switch" name="active" ${c.active ? 'checked' : ''}> Ask this check-in</label>
      <p class="error" data-form-error aria-live="polite"></p>
      <div class="form-actions">
        <button class="btn" type="submit">Save check-in</button>
        ${isNew ? '' : '<button class="btn ghost warn-text" type="button" data-delete>Delete</button>'}
      </div>
    </form>
  </details>`;
}

/** Check-ins the person set up by voice: listed so the family knows they exist, with no edit or delete. */
function renderOwn(v) {
  const name = v.household.recipientName;
  const own = v.ownCheckins || [];
  $('#own-block').hidden = !own.length;
  $('#own-title').textContent = `Set by ${name}, by voice`;
  $('#own-desc').textContent = `${name} set these up by saying, for example, “If I haven’t said good night by ten, let Dana know.” They are never asked; each one closes when ${name} says the words. Only ${name} can change or cancel them. Pausing check-ins pauses these too.`;
  $('#own-list').innerHTML = own
    .map(
      (c) => `<li>${loopGlyph('SCHEDULED')}<span><span class="sum-title">“${esc(c.phrase)}” by ${esc(c.bySpoken)} <span class="tag">Set by ${esc(c.setBy)}</span></span>
      <span class="sum-sub">Tells ${esc(c.tell)} if ${esc(name)} hasn’t said it · ${c.repeat === 'daily' ? 'every day' : 'one time'} · set ${esc(c.createdLocal)}</span></span></li>`,
    )
    .join('');
}

function renderCheckins(list) {
  const open = new Set($$('.checkin[open]').map((d) => d.dataset.id));
  const byTime = list.filter((c) => c.author !== 'person').sort((a, b) => (a.windows[0]?.start ?? '').localeCompare(b.windows[0]?.start ?? ''));
  $('#checkin-list').innerHTML = byTime.map((c) => checkinHtml(c)).join('');
  $$('.checkin').forEach((d) => {
    if (open.has(d.dataset.id)) d.open = true;
    wireCheckin(d);
  });
}

function readCheckin(details) {
  const f = details.querySelector('form');
  const windows = $$('[data-window]', f).map((row) => {
    const [s, e] = $$('input[type=time]', row);
    return { start: s.value, end: e.value };
  });
  return {
    label: f.label.value,
    prompt: f.prompt.value,
    calmingLine: f.calmingLine.value,
    kind: f.kind.value,
    reaskMinutes: Number(f.reaskMinutes.value),
    maxReasks: Number(f.maxReasks.value),
    windows,
    active: f.active.checked,
  };
}

function showIssues(details, issues) {
  const f = details.querySelector('form');
  for (const name of ['label', 'prompt', 'calmingLine']) {
    const msgs = issues.filter((i) => i.field === name).map((i) => i.message);
    const input = f[name];
    const err = details.querySelector(`#${CSS.escape(input.id)}-err`);
    err.textContent = msgs.join(' ');
    input.setAttribute('aria-invalid', msgs.length ? 'true' : 'false');
  }
}

let lintTimer;
function wireCheckin(details) {
  const f = details.querySelector('form');
  const id = details.dataset.id;
  const relint = () => {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(async () => {
      const b = readCheckin(details);
      const r = await api(`/api/households/${H}/lint`, { method: 'POST', body: { label: b.label, prompt: b.prompt, calmingLine: b.calmingLine } }).catch(() => null);
      if (r) showIssues(details, r.issues.filter((i) => i.message !== 'Required.' || f[i.field].value !== ''));
    }, 350);
  };
  for (const name of ['label', 'prompt', 'calmingLine']) f[name].addEventListener('input', relint);
  details.addEventListener('focusin', () => state.editing.add(id));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = readCheckin(details);
    $('[data-form-error]', f).textContent = '';
    try {
      await api(`/api/households/${H}/checkins/${encodeURIComponent(id)}`, { method: 'PUT', body });
      showIssues(details, []);
      state.editing.delete(id);
      toast(`Saved “${body.label}”.`);
      details.removeAttribute('data-new');
      await load(true);
    } catch (err) {
      if (err.data?.issues) {
        showIssues(details, err.data.issues);
        f.querySelector('[aria-invalid=true]')?.focus();
      } else {
        $('[data-form-error]', f).textContent = err.message;
      }
    }
  });
  f.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-add-window]')) {
      const box = $('[data-windows]', f);
      const n = $$('[data-window]', box).length;
      if (n >= 3) return toast('Up to three windows per check-in.');
      box.insertAdjacentHTML('beforeend', windowRow(`chk-${id}`, { start: '12:00', end: '14:00' }, n));
      $$('[data-window]', box).at(-1).querySelector('input').focus();
    }
    if (t.matches('[data-remove-window]')) {
      if ($$('[data-window]', f).length <= 1) return toast('A check-in needs at least one window.');
      t.closest('[data-window]').remove();
    }
    if (t.matches('[data-delete]')) {
      const ok = await confirmDialog({ title: 'Delete this check-in?', body: `“${f.label.value}” will no longer be asked. Past ledger entries stay.`, okLabel: 'Delete' });
      if (!ok) return;
      await api(`/api/households/${H}/checkins/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.editing.delete(id);
      toast('Check-in deleted.');
      await load(true);
    }
  });
}

$('#add-checkin').addEventListener('click', () => {
  const id = `c${Date.now().toString(36)}`;
  const blank = { id, label: '', prompt: '', calmingLine: state.view?.checkins.find((c) => c.author !== 'person')?.calmingLine ?? '', kind: 'routine', windows: [{ start: '09:00', end: '11:00' }], reaskMinutes: 60, maxReasks: 2, active: true };
  $('#checkin-list').insertAdjacentHTML('beforeend', checkinHtml(blank, true));
  const d = $$('.checkin').at(-1);
  wireCheckin(d);
  state.editing.add(id);
  d.querySelector('input').focus();
});

// ---- Contacts and ladder ----

function renderContacts(v) {
  const rows = [...v.household.contacts];
  if (rows.length < 5) rows.push({ id: `c${rows.length + 1}`, name: '', relation: '', email: '', isNew: true });
  $('#contact-rows').innerHTML = rows
    .map(
      (c, i) => `<div class="contact-row" data-contact="${esc(c.id)}">
      <div class="field"><label for="ct-${i}-name">${c.isNew ? 'New contact name' : `Contact ${i + 1} name`}</label><input id="ct-${i}-name" name="name" maxlength="40" value="${esc(c.name)}" autocomplete="off"></div>
      <div class="field"><label for="ct-${i}-rel">Relation</label><input id="ct-${i}-rel" name="relation" maxlength="30" value="${esc(c.relation)}" autocomplete="off"></div>
      <div class="field"><label for="ct-${i}-email">Email</label><input id="ct-${i}-email" name="email" type="email" maxlength="254" value="${esc(c.email)}" autocomplete="off"></div>
    </div>`,
    )
    .join('');
  const group = (sel, legend, ids) => {
    $(sel).innerHTML =
      `<legend>${legend}</legend>` +
      v.household.contacts.map((c) => `<label class="check"><input type="checkbox" value="${esc(c.id)}" ${ids.includes(c.id) ? 'checked' : ''}> <span>${esc(c.name)} <span class="help-inline">(${esc(c.relation)})</span></span></label>`).join('');
  };
  group('#l1-group', 'Email first', v.ladder.l1ContactIds);
  group('#l2-group', 'Email second, if nobody acknowledges', v.ladder.l2ContactIds);
  $('#l2-days').value = v.ladder.l2AfterMissedDays;
  $('#cap').value = v.ladder.dailyAlertCap;
  $('#expiry').value = v.ladder.planExpiryDays;
  $('#quiet-on').checked = !!v.ladder.quietHours;
  $('#quiet-start').value = v.ladder.quietHours?.start ?? '21:00';
  $('#quiet-end').value = v.ladder.quietHours?.end ?? '07:00';
  $('#demo-note').textContent = v.household.demoMode ? 'Demo mode is on for this household, so quiet hours are not applied.' : '';
}

$('#contacts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const contacts = $$('[data-contact]')
    .map((row) => ({ id: row.dataset.contact, name: row.querySelector('[name=name]').value.trim(), relation: row.querySelector('[name=relation]').value.trim(), email: row.querySelector('[name=email]').value.trim() }))
    .filter((c) => c.name || c.email);
  try {
    await api(`/api/households/${H}/contacts`, { method: 'PUT', body: { contacts } });
    toast('Contacts saved.');
    await load(true, true);
  } catch (err) {
    toast(err.message);
  }
});

$('#ladder-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ids = (sel) => $$(`${sel} input:checked`).map((i) => i.value);
  const body = {
    l1ContactIds: ids('#l1-group'),
    l2ContactIds: ids('#l2-group'),
    l2AfterMissedDays: Number($('#l2-days').value),
    dailyAlertCap: Number($('#cap').value),
    planExpiryDays: Number($('#expiry').value),
    quietHours: $('#quiet-on').checked ? { start: $('#quiet-start').value, end: $('#quiet-end').value } : null,
  };
  try {
    await api(`/api/households/${H}/ladder`, { method: 'PUT', body });
    toast('Email settings saved.');
    await load(true, true);
  } catch (err) {
    toast(err.message);
  }
});

// ---- Consent ----

function renderConsent(v) {
  const c = v.consent;
  const box = $('#consent-current');
  const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  if (!c) {
    box.className = 'consent-current off';
    box.innerHTML = '<p><strong>No consent on record.</strong> Check-ins and emails are off.</p>';
  } else if (c.revokedAt) {
    box.className = 'consent-current off';
    box.innerHTML = `<p><strong>Consent revoked</strong> on ${esc(fmt(c.revokedAt))}. Nothing is asked and nobody is emailed.</p>`;
  } else {
    const expired = v.status === 'expired';
    box.className = `consent-current${expired ? ' off' : ''}`;
    box.innerHTML = `<p><strong>${esc(c.recipientName)} agreed</strong> to daily check-ins, recorded by ${esc(c.recordedBy)} on ${esc(fmt(c.recordedAt))}. ${expired ? 'The plan <strong>ended</strong>' : 'The plan runs until'} ${esc(fmt(c.planExpiresAt))}.</p>`;
  }
  if (!$('#consent-name').value) $('#consent-name').value = v.household.recipientName;
  $('#consent-who').textContent = v.household.recipientName;
  $('#revoke').disabled = !c || !!c.revokedAt;
}

$('#consent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#consent-confirm').checked) {
    toast('Please confirm they agreed before recording consent.');
    $('#consent-confirm').focus();
    return;
  }
  try {
    await api(`/api/households/${H}/consent`, { method: 'POST', body: { recipientName: $('#consent-name').value, recordedBy: $('#consent-by').value } });
    $('#consent-confirm').checked = false;
    toast('Consent recorded.');
    await load(true);
  } catch (err) {
    toast(err.message);
  }
});

$('#revoke').addEventListener('click', async () => {
  const ok = await confirmDialog({ title: 'Revoke consent?', body: 'Check-ins stop being asked and nobody is emailed, starting now. You can record consent again later.', okLabel: 'Revoke consent' });
  if (!ok) return;
  await api(`/api/households/${H}/consent/revoke`, { method: 'POST', body: {} });
  toast('Consent revoked. Check-ins and emails stopped.');
  await load(true);
});

// ---- Pause and data ----

function renderData(v) {
  const paused = v.status === 'paused';
  $('#pause-status').textContent = paused ? `Paused until ${v.pausedUntilLocal}${v.household.pausedBy === 'person' ? ` (by ${v.household.recipientName}; it ends on its own)` : ''}.` : 'Check-ins are running.';
  $('#resume').disabled = !paused || v.household.pausedBy === 'person';
  $('#pause').disabled = paused;
}

$('#pause').addEventListener('click', async () => {
  await api(`/api/households/${H}/pause`, { method: 'POST', body: { hours: 24 } });
  toast('Paused for 24 hours.');
  await load(true);
});
$('#resume').addEventListener('click', async () => {
  try {
    await api(`/api/households/${H}/resume`, { method: 'POST', body: {} });
    toast('Check-ins resumed.');
    await load(true);
  } catch (err) {
    toast(err.message);
  }
});
$('#delete').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Delete all data?',
    body: 'This removes the plan, consent record, ledger, recorded words, and activity for this household. It cannot be undone.',
    okLabel: 'Delete everything',
    requireType: true,
  });
  if (!ok) return;
  const r = await api(`/api/households/${H}/data`, { method: 'DELETE' });
  toast(`Deleted ${r.removed} records.`);
  $('#hero-title').textContent = 'All data deleted';
  $('#ledger-today').innerHTML = '<li class="help">No data. Use the simulator’s “Start a fresh demo day” to recreate the demo household.</li>';
});

// ---- Link a voice assistant (OAuth link codes) ----

const CLIENT_NAMES = { 'alexa-plus': 'Alexa+ add-on', simulator: 'Simulated client' };

async function renderLinks() {
  const { links } = await api(`/api/households/${H}/links`);
  $('#links-list').innerHTML = links.length
    ? links
        .map(
          (l) =>
            `<li>${esc(CLIENT_NAMES[l.clientId] || l.clientId)} · ${l.role === 'family' ? 'family member (can hear the day, cannot answer)' : `${esc(state.view?.household.recipientName ?? 'their')}’s own (asks and records)`}, linked ${esc(new Date(l.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</li>`,
        )
        .join('')
    : '<li>Nothing linked yet.</li>';
  $('#unlink').disabled = !links.length;
}

async function makeCode(role) {
  const r = await api(`/api/households/${H}/link-code`, { method: 'POST', body: { role } });
  const until = new Date(r.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const forWhom = role === 'family' ? 'For a family member’s Alexa: hears the day, cannot answer.' : `For ${state.view?.household.recipientName ?? 'their'}’s own Alexa.`;
  $('#link-code-out').innerHTML = `${esc(r.code)}<small>${esc(forWhom)} Works once, until ${esc(until)} (real time).</small>`;
}
$('#make-code').addEventListener('click', () => makeCode('person'));
$('#make-family-code').addEventListener('click', () => makeCode('family'));

$('#unlink').addEventListener('click', async () => {
  const ok = await confirmDialog({ title: 'Unlink all voice assistant sign-ins?', body: 'New sign-ins stop at once. An existing session ends within an hour. You can link again with a new code.', okLabel: 'Unlink' });
  if (!ok) return;
  const r = await api(`/api/households/${H}/links`, { method: 'DELETE' });
  toast(`Unlinked ${r.removed} sign-in${r.removed === 1 ? '' : 's'}.`);
  await renderLinks();
});

// ---- Acknowledge from the ledger ----

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ack]');
  if (!b) return;
  const contactId = state.view?.ladder.l1ContactIds[0] ?? 'console';
  try {
    await api(`/api/households/${H}/acknowledge/${encodeURIComponent(b.dataset.ack)}`, { method: 'POST', body: { contactId } });
    toast('Acknowledged. No more emails about this check-in.');
    await load(true);
  } catch (err) {
    toast(err.message);
  }
});

// ---- Side navigation: mark the section in view ----

const navLinks = $$('.sidenav a');
const sections = $$('main section[id]');
let spyFrame = 0;
function markCurrent() {
  spyFrame = 0;
  const line = innerHeight * 0.3;
  let current = sections[0];
  for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = sections.at(-1);
  navLinks.forEach((a) => (a.getAttribute('href') === `#${current.id}` ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
}
addEventListener('scroll', () => (spyFrame ||= requestAnimationFrame(markCurrent)), { passive: true });
markCurrent();

// ---- Load and poll ----

async function load(force = false, contactsToo = false) {
  const [view, ledger] = await Promise.all([api(`/api/households/${H}`), api(`/api/households/${H}/ledger?days=3`)]);
  state.view = view;
  renderHero(view);
  renderLedger(ledger);
  renderConsent(view);
  renderData(view);
  if (force || !state.editing.size) renderCheckins(view.checkins);
  renderOwn(view);
  renderLinks().catch(() => {});
  if (!state.contactsRendered || contactsToo) {
    renderContacts(view);
    state.contactsRendered = true;
  }
}

async function main() {
  const config = await getConfig();
  await ensureAccess(config);
  H = await visitorHousehold();
  // A fresh demo day started in another of this visitor's tabs: show that one.
  onHouseholdReplaced((id) => {
    H = id;
    load(true, true).catch(() => {});
  });
  try {
    await load(true, true);
  } catch (err) {
    $('#hero-title').textContent = err.status === 404 ? 'No household yet' : 'Could not load';
    $('#ledger-today').innerHTML = `<li class="help">${err.status === 404 ? 'Start a fresh demo day in the simulator to create the demo household.' : esc(err.message)}</li>`;
    return;
  }
  setInterval(() => {
    const active = document.activeElement;
    if (active && active.closest('form')) return; // never re-render under someone's cursor
    load().catch(() => {});
  }, 8000);
}

main();
