// Guided tour of one moment (/simulator/?tour=good-night): Margaret sets up a check-in of Margaret's own by voice,
// closes it by saying good night, and Dana asks how the day went; then, optionally, the night Margaret doesn't.
// The tour only presses the simulator's own controls in order: every step goes through the planner and makes
// real MCP calls, shown in the traffic pane. Nothing here writes a reply.

import { $, esc } from '/shared/app.js';

export const TOUR_ID = 'good-night';

const SET_LINE = "If I haven't said good night by ten, let Dana know.";

const STEPS = [
  {
    title: 'Margaret sets it up',
    caption: 'Margaret sets up a check-in by voice, hears it read back, and says yes.',
    spot: '.panel.convo',
    run: async (t) => {
      await t.speaker('person');
      await t.person(SET_LINE);
      await t.settle(1600); // time to read the preview before the answer
      await t.person('Yes, please.');
    },
  },
  {
    title: 'Good night at 9:41 pm',
    caption: 'The clock jumps to 9:41 pm and Margaret says good night, which closes the loop before the 10 pm deadline.',
    spot: '.loops-block',
    run: async (t) => {
      await t.speaker('person');
      await t.clockTo(21, 41, '9:41 pm');
      await t.settle(700);
      await t.person('Good night');
    },
  },
  {
    title: 'Dana asks',
    caption: 'Dana asks from another device and hears what was recorded, in the ledger’s exact words.',
    spot: '.panel.convo',
    run: async (t) => {
      await t.speaker('family');
      await t.family("How's Mom doing today?");
    },
  },
  {
    title: 'Rewind to the morning',
    caption: 'What if Margaret doesn’t say it? Rewind to a fresh morning and set the same check-in again.',
    spot: '.panel.convo',
    run: async (t) => {
      await t.speaker('person');
      await t.freshDay();
      await t.person(SET_LINE);
      await t.settle(1200);
      await t.person('Yes, please.');
    },
  },
  {
    title: '10:01 pm, no good night',
    caption: 'The clock jumps to 10:01 pm with no good night, and Dana gets an email written in Margaret’s name.',
    spot: '.mail-block',
    run: async (t) => {
      await t.clockTo(22, 1, '10:01 pm');
    },
  },
];
const MAIN = 3; // steps 1-3; 4-5 are the "What if Margaret doesn't?" branch

const INTRO = 'Every step makes real MCP calls to the server; watch them arrive in the traffic pane.';

/**
 * `sim` is the simulator's own controls: ready() (resolves once it is connected), person(text), family(text),
 * speaker(who), clockTo(h, m, label), freshDay() (a fresh household, set up for the tour), settle(ms), pinLastLine(),
 * ended(), onError(err).
 */
export function createTour(sim) {
  const panel = $('#tour');
  const nextBtn = $('#tour-next');
  const captionEl = $('#tour-caption');
  const tour = { open: false, ready: false, step: 0, running: false, failed: false };
  /** A step is playing, or the tour's household is being set up. */
  const busy = () => tour.running || (!tour.ready && !tour.failed);

  function render() {
    const mark = (i) => {
      const state = i < tour.step ? 'done' : i === tour.step && tour.ready ? 'current' : 'todo';
      const status = state === 'done' ? ', done' : state === 'current' ? (tour.running ? ', playing now' : ', next') : '';
      return `<li data-state="${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="tour-mark" aria-hidden="true">${state === 'done' ? '' : i + 1}</span><span>${esc(STEPS[i].title)}</span><span class="visually-hidden">${status}</span></li>`;
    };
    $('#tour-main').innerHTML = STEPS.slice(0, MAIN).map((_, i) => mark(i)).join('');
    $('#tour-branch').innerHTML = STEPS.slice(MAIN).map((_, i) => mark(i + MAIN)).join('');

    let label;
    if (!tour.ready) label = tour.failed ? 'Try again' : 'Getting ready…';
    else if (tour.running) label = `Playing step ${tour.step + 1}…`;
    else if (tour.failed) label = 'Start the tour over';
    else if (tour.step === 0) label = `Start: ${STEPS[0].title}`;
    else if (tour.step === MAIN) label = 'What if Margaret doesn’t?';
    else if (tour.step >= STEPS.length) label = 'Replay the tour';
    else label = `Next: ${STEPS[tour.step].title}`;
    nextBtn.textContent = label;
    nextBtn.setAttribute('aria-disabled', String(busy()));
    $('#tour-end').setAttribute('aria-disabled', String(busy())); // a step finishes before the tour can end
  }

  function setCaption(text) {
    captionEl.textContent = text;
  }

  function spot(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    document.querySelectorAll('.tour-spot').forEach((e) => e.classList.remove('tour-spot'));
    void el.offsetWidth;
    el.classList.add('tour-spot');
    el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setTimeout(() => el.classList.remove('tour-spot'), 2600);
  }

  // The panel takes room above the three panes; they shrink by its height so the page still fits one screen.
  const fit = () => document.documentElement.style.setProperty('--tour-h', tour.open ? `${panel.offsetHeight + 16}px` : '0px');
  new ResizeObserver(fit).observe(panel);

  async function setup() {
    tour.step = 0;
    tour.ready = false;
    tour.failed = false;
    render();
    setCaption('Getting a fresh demo household of your own ready…');
    try {
      await sim.ready();
      await sim.freshDay();
      tour.ready = true;
      setCaption(INTRO);
    } catch (err) {
      tour.failed = true;
      setCaption(`The tour could not start: ${err.message || err}. Try again.`);
      sim.onError(err);
    }
    render();
  }

  async function play() {
    if (tour.running) return;
    if (!tour.ready || tour.failed || tour.step >= STEPS.length) return setup();
    const step = STEPS[tour.step];
    tour.running = true;
    render();
    setCaption(step.caption);
    try {
      await step.run(sim);
      spot(step.spot);
      await sim.settle(600); // the MCP App card sizes itself first
      sim.pinLastLine();
      tour.step++;
    } catch (err) {
      tour.failed = true;
      setCaption(`Step ${tour.step + 1} did not finish: ${err.message || err}. Start the tour over to try again.`);
      sim.onError(err);
    } finally {
      tour.running = false;
      render();
    }
  }

  function setUrl(on) {
    const u = new URL(location.href);
    if (on) u.searchParams.set('tour', TOUR_ID);
    else u.searchParams.delete('tour');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }

  async function open() {
    if (tour.open) return nextBtn.focus();
    tour.open = true;
    panel.hidden = false;
    document.body.classList.add('touring');
    setUrl(true);
    fit();
    nextBtn.focus();
    await setup();
  }

  function close() {
    if (busy()) return;
    tour.open = false;
    panel.hidden = true;
    document.body.classList.remove('touring');
    setUrl(false);
    fit();
    sim.ended();
    openers.find((b) => b.offsetParent !== null)?.focus();
  }

  nextBtn.addEventListener('click', () => {
    if (!busy()) play();
  });
  $('#tour-end').addEventListener('click', close);
  // One opener in the top bar, one under the notice at phone width (only one shows at a time).
  const openers = [...document.querySelectorAll('[data-tour-open]')];
  openers.forEach((b) => b.addEventListener('click', open));

  return { open, wanted: () => new URL(location.href).searchParams.get('tour') === TOUR_ID };
}
