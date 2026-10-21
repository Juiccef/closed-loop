import type { WebHandler } from './node-adapter';

/** Lambda Function URL event, payload format 2.0 (only the fields used here). */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName: string };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export function toWebRequestFromUrlEvent(event: FunctionUrlEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  const method = event.requestContext.http.method;
  const body =
    method === 'GET' || method === 'HEAD' || event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? new Uint8Array(Buffer.from(event.body, 'base64'))
        : event.body;
  return new Request(url, { method, headers, body });
}

export async function toUrlResult(res: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text(), isBase64Encoded: false };
}

export function urlEventHandler(handler: WebHandler) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> =>
    toUrlResult(await handler(toWebRequestFromUrlEvent(event)));
}
