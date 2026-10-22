import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ConflictError,
  DEFAULT_LADDER,
  EVENT_TTL_DAYS,
  UTTERANCE_TTL_DAYS,
  VISITOR_HOURS,
  clip,
  isExpired,
  isVisitorHousehold,
  keys,
  randomSuffix,
  realNow,
  type AuditEvent,
  type CheckinDefinition,
  type ConsentRecord,
  type Household,
  type HouseholdId,
  type LadderConfig,
  type MailLogEntry,
  type LinkRole,
  type OAuthGrant,
  type Occurrence,
  type Store,
  type Utterance,
} from '@closed-loop/core';

type Item = Record<string, unknown>;

const DAY_S = 86_400;
const ttlFrom = (iso: string, days: number) => Math.floor(new Date(iso).getTime() / 1000) + days * DAY_S;
const ttlFromDate = (date: string, days: number) => ttlFrom(`${date}T00:00:00Z`, days);

/**
 * Every item of a visitor demo household expires: VISITOR_HOURS after it is written, or sooner if it already would.
 * Writes stop once the household itself has expired, so nothing of it outlives that by more than VISITOR_HOURS.
 */
function ttlFor(id: HouseholdId, ttl?: number): number | undefined {
  if (!isVisitorHousehold(id)) return ttl;
  const visitor = Math.floor(realNow() / 1000) + VISITOR_HOURS * 3600;
  return ttl === undefined ? visitor : Math.min(ttl, visitor);
}
const withTtl = (id: HouseholdId): Item => {
  const ttl = ttlFor(id);
  return ttl === undefined ? {} : { ttl };
};

/** Removes the key and bookkeeping attributes before handing an item back as an entity. */
function entity<T>(item: Item | undefined): T | undefined {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, T: _t, ttl: _ttl, ...rest } = item;
  return rest as T;
}

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async get(key: Item): Promise<Item | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: key }));
    return res.Item;
  }

  private async put(item: Item): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ TableName: this.table, ...input, ExclusiveStartKey: start }));
      out.push(...(res.Items ?? []));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }

  private prefix(id: HouseholdId, prefix: string, forward = true, limit?: number) {
    return {
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': `H#${id}`, ':p': prefix },
      ScanIndexForward: forward,
      Limit: limit,
    };
  }

  // ---- Clock ----

  // Deployment-wide offset in the CLOCK item; a visitor household's own offset on its household record.

  async getClockOffsetSeconds(householdId?: HouseholdId) {
    if (householdId && isVisitorHousehold(householdId)) {
      const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.household(householdId), ProjectionExpression: 'clockOffsetSeconds' }));
      if (typeof res.Item?.clockOffsetSeconds === 'number') return res.Item.clockOffsetSeconds;
    }
    const item = await this.get(keys.clock());
    return typeof item?.offsetSeconds === 'number' ? item.offsetSeconds : 0;
  }
  async setClockOffsetSeconds(seconds: number, householdId?: HouseholdId) {
    if (householdId && isVisitorHousehold(householdId)) return this.updateHousehold(householdId, { clockOffsetSeconds: seconds });
    await this.put({ ...keys.clock(), T: 'clock', offsetSeconds: seconds });
  }

  // ---- Household ----

  async getHousehold(id: HouseholdId) {
    const h = entity<Household>(await this.get(keys.household(id)));
    return h && !isExpired(h, realNow()) ? h : undefined;
  }
  async putHousehold(h: Household) {
    // A visitor household's record and registry entry expire exactly at its expiry (updates never extend it).
    const expiry: Item = isVisitorHousehold(h.id) && h.expiresAt ? { expiresAt: h.expiresAt, ttl: Math.floor(Date.parse(h.expiresAt) / 1000) } : {};
    await Promise.all([
      this.put({ ...keys.household(h.id), T: 'household', ...h, ...expiry }),
      this.put({ ...keys.registry(h.id), T: 'registry', householdId: h.id, ...expiry }),
    ]);
  }
  async updateHousehold(id: HouseholdId, patch: Partial<Omit<Household, 'id'>>) {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    Object.entries(patch).forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      if (v === undefined) removes.push(`#f${i}`);
      else {
        sets.push(`#f${i} = :v${i}`);
        values[`:v${i}`] = v;
      }
    });
    if (!sets.length && !removes.length) return;
    const expr = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].join(' ').trim();
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.household(id),
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      }),
    ).catch((err) => {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    });
  }
  async listHouseholdIds() {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'REGISTRY' },
    });
    return items
      .filter((i) => !isExpired({ expiresAt: typeof i.expiresAt === 'string' ? i.expiresAt : undefined }, realNow()))
      .map((i) => String(i.householdId))
      .sort();
  }

  // ---- Consent ----

  async listConsents(id: HouseholdId) {
    const items = await this.queryAll(this.prefix(id, 'CONSENT#', false));
    return items.map((i) => entity<ConsentRecord>(i)!);
  }
  async putConsent(id: HouseholdId, c: ConsentRecord) {
    await this.put({ ...keys.consent(id, c.recordedAt), T: 'consent', ...c, ...withTtl(id) });
  }

  // ---- Check-in definitions ----

  async listCheckins(id: HouseholdId) {
    const items = await this.queryAll(this.prefix(id, 'CHK#'));
    return items.map((i) => entity<CheckinDefinition>(i)!);
  }
  async putCheckin(id: HouseholdId, def: CheckinDefinition) {
    await this.put({ ...keys.checkin(id, def.id), T: 'checkin', ...def, ...withTtl(id) });
  }
  async deleteCheckin(id: HouseholdId, checkinId: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: keys.checkin(id, checkinId) }));
  }

  // ---- Ladder ----

  async getLadder(id: HouseholdId) {
    return entity<LadderConfig>(await this.get(keys.ladder(id))) ?? structuredClone(DEFAULT_LADDER);
  }
  async putLadder(id: HouseholdId, ladder: LadderConfig) {
    await this.put({ ...keys.ladder(id), T: 'ladder', ...ladder, ...withTtl(id) });
  }

  // ---- Occurrences ----

  async getOccurrence(id: HouseholdId, occurrenceId: string) {
    return entity<Occurrence>(await this.get(keys.occurrence(id, occurrenceId)));
  }
  async listOccurrences(id: HouseholdId, fromDate: string, toDate = fromDate) {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': `H#${id}`, ':a': `OCC#${fromDate}`, ':b': `OCC#${toDate}~` },
    });
    return items.map((i) => entity<Occurrence>(i)!);
  }
  async createOccurrence(occ: Occurrence) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.occurrence(occ.householdId, occ.id), T: 'occurrence', ...occ, ...withTtl(occ.householdId) },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
  async updateOccurrence(next: Occurrence, expectedVersion: number) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...keys.occurrence(next.householdId, next.id), T: 'occurrence', ...next, ...withTtl(next.householdId) },
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expectedVersion },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConflictError(next.id);
      throw err;
    }
  }

  // ---- Utterances (30-day TTL) ----

  async putUtterance(u: Utterance) {
    await this.put({
      ...keys.utterance(u.householdId, u.occurrenceId, u.at),
      T: 'utterance',
      ...u,
      text: clip(u.text),
      ttl: ttlFor(u.householdId, ttlFrom(u.at, UTTERANCE_TTL_DAYS)),
    });
  }
  async listUtterances(id: HouseholdId, occurrenceId?: string) {
    const items = await this.queryAll(this.prefix(id, occurrenceId ? `UTT#${occurrenceId}#` : 'UTT#'));
    return items.map((i) => entity<Utterance>(i)!);
  }
  async markUtteranceReviewed(id: HouseholdId, occurrenceId: string, at: string) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.utterance(id, occurrenceId, at),
        UpdateExpression: 'SET reviewed = :t',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':t': true },
      }),
    ).catch((err) => {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    });
  }

  // ---- Audit events (90-day TTL) ----

  async appendEvent(e: AuditEvent) {
    await this.put({
      ...keys.event(e.householdId, e.at, randomSuffix()),
      T: 'event',
      ...e,
      detail: clip(e.detail),
      ttl: ttlFor(e.householdId, ttlFrom(e.at, EVENT_TTL_DAYS)),
    });
  }
  async listEvents(id: HouseholdId, limit: number) {
    const res = await this.doc.send(new QueryCommand({ TableName: this.table, ...this.prefix(id, 'EVT#', false, limit) }));
    return (res.Items ?? []).map((i) => entity<AuditEvent>(i)!);
  }

  // ---- Daily alert cap ----

  async tryConsumeAlert(id: HouseholdId, date: string, cap: number) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.alertCap(id, date),
          UpdateExpression: 'ADD #c :one SET #t = :t, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#c) OR #c < :cap',
          ExpressionAttributeNames: { '#c': 'count', '#t': 'T', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':cap': cap, ':t': 'cap', ':ttl': ttlFor(id, ttlFromDate(date, 3)) },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
  async getAlertCount(id: HouseholdId, date: string) {
    const item = await this.get(keys.alertCap(id, date));
    return typeof item?.count === 'number' ? item.count : 0;
  }

  // ---- OAuth: hashes only, TTL-expired, consumed with a conditional delete so each code works once ----

  private async consume(key: Item, now: Date): Promise<Item | undefined> {
    try {
      const res = await this.doc.send(
        new DeleteCommand({ TableName: this.table, Key: key, ConditionExpression: 'attribute_exists(PK)', ReturnValues: 'ALL_OLD' }),
      );
      const item = res.Attributes;
      return item && typeof item.expiresAt === 'string' && new Date(item.expiresAt) > now ? item : undefined;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  }
  async putLinkCode(codeHash: string, householdId: HouseholdId, expiresAt: string, role: LinkRole = 'person') {
    await this.put({ ...keys.linkCode(codeHash), T: 'linkcode', householdId, role, expiresAt, ttl: ttlFor(householdId, ttlFrom(expiresAt, 1)) });
  }
  async consumeLinkCode(codeHash: string, now: Date) {
    const item = await this.consume(keys.linkCode(codeHash), now);
    return item ? { householdId: item.householdId as HouseholdId, role: (item.role === 'family' ? 'family' : 'person') as LinkRole } : undefined;
  }
  async putAuthCode(codeHash: string, grant: OAuthGrant, expiresAt: string) {
    await this.put({ ...keys.authCode(codeHash), T: 'authcode', grant, expiresAt, ttl: ttlFor(grant.householdId, ttlFrom(expiresAt, 1)) });
  }
  async consumeAuthCode(codeHash: string, now: Date) {
    return (await this.consume(keys.authCode(codeHash), now))?.grant as OAuthGrant | undefined;
  }
  async putRefreshToken(householdId: HouseholdId, tokenHash: string, grant: OAuthGrant, expiresAt: string) {
    await this.put({ ...keys.refreshToken(householdId, tokenHash), T: 'refreshtoken', grant, expiresAt, ttl: ttlFor(householdId, ttlFrom(expiresAt, 1)) });
  }
  async consumeRefreshToken(householdId: HouseholdId, tokenHash: string, now: Date) {
    return (await this.consume(keys.refreshToken(householdId, tokenHash), now))?.grant as OAuthGrant | undefined;
  }
  async listRefreshTokens(householdId: HouseholdId) {
    const items = await this.queryAll(this.prefix(householdId, 'RT#'));
    return items.map((i) => {
      const g = i.grant as OAuthGrant;
      return { clientId: String(g.clientId), role: (g.role === 'family' ? 'family' : 'person') as LinkRole, createdAt: String(g.createdAt), expiresAt: String(i.expiresAt) };
    });
  }
  async deleteRefreshTokens(householdId: HouseholdId) {
    const items = await this.queryAll({ ...this.prefix(householdId, 'RT#'), ProjectionExpression: 'PK, SK' });
    await Promise.all(items.map((i) => this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: i.PK, SK: i.SK } }))));
    return items.length;
  }

  // ---- Mail log (2-day TTL; no addresses) ----

  async appendMailLog(entry: MailLogEntry) {
    await this.put({ PK: `H#${entry.householdId}`, SK: `MAIL#${entry.at}#${randomSuffix()}`, T: 'mail', ...entry, ttl: ttlFor(entry.householdId, ttlFrom(entry.at, 2)) });
  }
  async listMailLog(householdId: HouseholdId, limit: number) {
    const res = await this.doc.send(new QueryCommand({ TableName: this.table, ...this.prefix(householdId, 'MAIL#', false, limit) }));
    return (res.Items ?? []).map((i) => entity<MailLogEntry>(i)!);
  }

  // ---- Delete my data ----

  async deleteHousehold(id: HouseholdId) {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `H#${id}` },
      ProjectionExpression: 'PK, SK',
    });
    const allKeys = [...items.map((i) => ({ PK: i.PK, SK: i.SK })), keys.registry(id)];
    for (let i = 0; i < allKeys.length; i += 25) {
      let batch: Item[] = allKeys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; batch.length && attempt < 5; attempt++) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: batch } }));
        batch = (res.UnprocessedItems?.[this.table] ?? []) as Item[];
        if (batch.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
      if (batch.length) throw new Error(`delete incomplete: ${batch.length} items left`);
    }
    return allKeys.length;
  }
}
