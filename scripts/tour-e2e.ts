// Plays the guided tour (/simulator/?tour=good-night) in a real browser and checks what each step shows.
// Usage: npm run dev (in another terminal), then: npx tsx scripts/tour-e2e.ts [base-url] [access-code]
// Screenshots go to out/tour/. The tour's demo household is deleted at the end.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const CODE = process.argv[3] ?? 'local-dev';
const OUT = join(import.meta.dirname, '..', 'out', 'tour');
await mkdir(OUT, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const text = (page: Page, sel: string) => page.locator(sel).innerText();
/** tools/call entries in the traffic pane, oldest first. */
const toolCalls = async (page: Page) => (await page.locator('#traffic .t-method').allInnerTexts()).filter((t) => t.startsWith('tools/call ')).reverse();
const nextLabel = (page: Page) => text(page, '#tour-next');

async function waitForNext(page: Page, label: RegExp) {
  await page.waitForFunction(
    (src) => {
      const b = document.querySelector('#tour-next');
      return !!b && b.getAttribute('aria-disabled') === 'false' && new RegExp(src).test(b.textContent ?? '');
    },
    label.source,
    { timeout: 20_000 },
  );
}

async function play(page: Page, n: number, then: RegExp, how: 'click' | 'keyboard' = 'click') {
  const before = (await toolCalls(page)).length;
  if (how === 'keyboard') await page.keyboard.press('Enter');
  else await page.click('#tour-next');
  await waitForNext(page, then);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `step-${n}.png`) });
  return (await toolCalls(page)).slice(before);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1536, height: 864 } });
await context.addInitScript(`try { sessionStorage.setItem('closed-loop-access-code', ${JSON.stringify(CODE)}); } catch {}`);
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/simulator/?tour=good-night`);
await waitForNext(page, /^Start: Margaret sets it up$/);
const household = await page.evaluate(() => sessionStorage.getItem('closed-loop-household'));
check('the tour opens from the link, in a visitor household of its own', /^demo-[a-z0-9]{10}$/.test(household ?? ''), household ?? '');
check('the Next button has keyboard focus', await page.evaluate(() => document.activeElement?.id === 'tour-next'));
check('the page still says it is a simulated Alexa+ client', /Simulated Alexa\+ client/.test(await text(page, '#tour')) && /Simulated Alexa\+ client/.test(await text(page, '.topnav')));
check("only Margaret's own check-in will be in play", /No check-ins today/.test(await text(page, '#loops')) && /switched off/.test(await text(page, '#captions')));
await page.screenshot({ path: join(OUT, 'step-0.png') });

// 1. Margaret sets it up, by keyboard.
let calls = await play(page, 1, /^Next: Good night at 9:41 pm$/, 'keyboard');
let convo = await text(page, '#captions');
check('step 1: two set_my_checkin calls (preview, then the yes)', calls.join() === 'tools/call set_my_checkin,tools/call set_my_checkin', calls.join());
check('step 1: the preview is read back and asks', /If you haven't said good night by 10 pm tonight, I'll email Dana\. Should I set that up\?/.test(convo));
check('step 1: Margaret says yes, and it is set', /Yes, please\./.test(convo) && /Okay, it's set\./.test(convo));
check('step 1: the loop shows as set by Margaret', /set by Margaret · tells Dana/.test(await text(page, '#loops')), await text(page, '#loops'));
check('step 1: marked done by a check mark and text, not color alone', (await page.locator('#tour-main li').first().getAttribute('data-state')) === 'done' && /done/.test(await page.locator('#tour-main li').first().innerText()));

// 2. 9:41 pm, good night.
calls = await play(page, 2, /^Next: Dana asks$/);
check('step 2: the clock reads 9:41 pm', (await text(page, '#clock-time')) === '9:41 pm', await text(page, '#clock-time'));
check('step 2: a status lookup, then record_response', calls.join() === 'tools/call get_my_status,tools/call record_response', calls.join());
check('step 2: the loop closes as reported by the person, answered 21:41', /Reported by the person/i.test(await text(page, '#loops')) && /answered 21:41/.test(await text(page, '#loops')), await text(page, '#loops'));
check('step 2: no email', /No email yet/.test(await text(page, '#mail')));

// 3. Dana asks.
calls = await play(page, 3, /^What if Margaret doesn’t\?$/);
convo = await text(page, '#captions');
check('step 3: get_family_summary', calls.join() === 'tools/call get_family_summary', calls.join());
check("step 3: Dana's question is asked from Dana's side", /Dana \(family, own assistant\)\s*How's Mom doing today\?/.test(convo));
check('step 3: Dana hears the recorded wording', /Margaret's “good night” by 10 pm: reported by the person\./.test(convo));

// 4. What if Margaret doesn't? Rewind.
calls = await play(page, 4, /^Next: 10:01 pm, no good night$/);
check('step 4: a fresh morning', (await text(page, '#clock-time')) === '7:55 am', await text(page, '#clock-time'));
check('step 4: the same check-in set again (preview, yes)', calls.join() === 'tools/call set_my_checkin,tools/call set_my_checkin', calls.join());
const rewound = await page.evaluate(() => sessionStorage.getItem('closed-loop-household'));
check('step 4: in a new household of its own', !!rewound && rewound !== household, `${household} -> ${rewound}`);

// 5. 10:01 pm, no good night.
calls = await play(page, 5, /^Replay the tour$/);
check('step 5: nobody speaks; only the clock moves', calls.length === 0, calls.join());
check('step 5: the clock reads 10:01 pm', (await text(page, '#clock-time')) === '10:01 pm', await text(page, '#clock-time'));
const mail = await text(page, '#mail');
check("step 5: Dana gets the email in Margaret's name", /Margaret asked us to let you know: no "good night" by 10 pm \(not an emergency alert\)/.test(mail) && /to Dana \(daughter\)/.test(mail), mail.slice(0, 200));
check('step 5: the loop shows no response, family emailed', /No response \(not reached\) · family emailed/i.test(await text(page, '#loops')), await text(page, '#loops'));

const everything = `${await text(page, 'body')}`;
check('nothing on the page says "confirmed" or "taken"', !/\b(confirmed|taken)\b/i.test(everything));
check('no page errors', errors.length === 0, errors.join(' | '));

// End the tour: the panel closes and focus returns to the button that opens it.
await page.click('#tour-end');
check('ending the tour returns focus to the tour button', await page.evaluate(() => document.activeElement?.id === 'tour-open' && (document.querySelector('#tour') as HTMLElement).hidden));
check('ending the tour drops ?tour from the address', !new URL(page.url()).searchParams.has('tour'), page.url());

await fetch(`${BASE}/api/households/${rewound}/data`, { method: 'DELETE', headers: { authorization: `Bearer ${CODE}` } });
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : `\nAll checks passed. Screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
