// Caregiver wording lint. Check-in text is read aloud by Alexa+, so it must stay generic:
// no drug names or doses (Alexa+ policy, Sec. 13), no URLs, short enough to speak.

export const LIMITS = { label: 80, prompt: 80, calmingLine: 160 } as const;

// Small, deliberate denylist: medication words and common drug names. Generic wording passes:
// "your morning routine", "your lunchtime check".
const DRUG_TERMS = [
  'medication', 'medications', 'medicine', 'medicines', 'meds', 'pill', 'pills', 'tablet', 'tablets', 'capsule', 'capsules',
  'dose', 'doses', 'dosage', 'prescription', 'prescriptions', 'insulin', 'injection', 'inhaler', 'drug', 'drugs',
  'warfarin', 'metformin', 'lisinopril', 'atorvastatin', 'levothyroxine', 'amlodipine', 'metoprolol', 'omeprazole',
  'gabapentin', 'donepezil', 'memantine', 'aspirin', 'ibuprofen', 'acetaminophen', 'tylenol', 'eliquis', 'apixaban',
  'losartan', 'simvastatin', 'furosemide', 'prednisone', 'sertraline', 'oxycodone', 'hydrocodone', 'tramadol',
];

const DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|ml|mL|units?|iu|cc|g)\b/i;
const URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|ai|co|us|gov)\b)/i;

export interface LintIssue {
  field: 'label' | 'prompt' | 'calmingLine';
  message: string;
}

export function lintField(field: LintIssue['field'], text: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const t = text.trim();
  if (!t) issues.push({ field, message: 'Required.' });
  if (t.length > LIMITS[field]) issues.push({ field, message: `Keep it under ${LIMITS[field]} characters so it is easy to hear.` });
  if (DOSE.test(t)) issues.push({ field, message: 'Remove doses or amounts. Use generic wording like "your morning routine".' });
  if (URL.test(t)) issues.push({ field, message: 'Remove web addresses; they will be read aloud.' });
  const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
  const hit = words.find((w) => DRUG_TERMS.includes(w));
  if (hit) issues.push({ field, message: `Avoid medication words like "${hit}". Use generic wording like "your morning routine".` });
  return issues;
}

export function lintCheckinText(input: { label: string; prompt: string; calmingLine: string }): LintIssue[] {
  return [...lintField('label', input.label), ...lintField('prompt', input.prompt), ...lintField('calmingLine', input.calmingLine)];
}
