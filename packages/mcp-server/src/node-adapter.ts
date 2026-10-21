import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type WebHandler = (req: Request) => Promise<Response>;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body });
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function serveWebHandler(handler: WebHandler, port: number): Server {
  const server = createServer(async (req, res) => {
    try {
      await writeWebResponse(res, await handler(await toWebRequest(req, `http://localhost:${port}`)));
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.end('internal error');
    }
  });
  server.listen(port);
  return server;
}
