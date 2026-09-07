import { request as nodeRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Plugin } from "vite";

const ACCOUNT_PATH = /^\/(?:login|register|account)(?:[/?]|$)|^\/auth(?:[/?]|$)/;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type AuthResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

function requestAuth(authUrl: URL, path: string, headers: IncomingHttpHeaders): Promise<AuthResponse> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      {
        protocol: authUrl.protocol,
        hostname: authUrl.hostname,
        port: authUrl.port,
        path,
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function sendAuthResponse(response: AuthResponse, outgoing: ServerResponse) {
  outgoing.statusCode = response.status;
  Object.entries(response.headers).forEach(([name, value]) => {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      outgoing.setHeader(name, value);
    }
  });
  outgoing.end(response.body);
}

function proxyAccountRequest(req: IncomingMessage, res: ServerResponse, authUrl: URL) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["x-real-ip"];
  headers["x-real-ip"] = req.socket.remoteAddress || "127.0.0.1";
  const upstream = nodeRequest(
    {
      protocol: authUrl.protocol,
      hostname: authUrl.hostname,
      port: authUrl.port,
      path: req.url || "/",
      method: req.method,
      headers,
    },
    (response) => {
      res.statusCode = response.statusCode || 502;
      Object.entries(response.headers).forEach(([name, value]) => {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
          res.setHeader(name, value);
        }
      });
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end("账号服务暂不可用");
  });
  req.pipe(upstream);
}

export function localAuth(): Plugin {
  return {
    name: "lumina-local-auth",
    configureServer(server) {
      const configuredUrl = process.env.LUMINA_LOCAL_AUTH_URL;
      if (!configuredUrl) return;
      const authUrl = new URL(configuredUrl);

      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url || "/").split("?", 1)[0];
        if (ACCOUNT_PATH.test(pathname)) {
          proxyAccountRequest(req, res, authUrl);
          return;
        }

        Object.keys(req.headers).forEach((name) => {
          if (name.toLowerCase().startsWith("oai-authenticated-") || name.toLowerCase().startsWith("x-lumina-account-")) {
            delete req.headers[name];
          }
        });

        try {
          const verification = await requestAuth(authUrl, "/auth/verify", {
            accept: req.headers.accept || "*/*",
            cookie: req.headers.cookie || "",
            origin: req.headers.origin || "",
            "sec-fetch-site": req.headers["sec-fetch-site"] || "same-origin",
            "x-forwarded-method": req.method || "GET",
            "x-forwarded-uri": req.url || "/",
          });
          if (verification.status !== 200) {
            sendAuthResponse(verification, res);
            return;
          }

          const userId = verification.headers["x-lumina-account-id"];
          const name = verification.headers["x-lumina-account-name"];
          const email = verification.headers["x-lumina-account-email"];
          if (typeof userId !== "string" || typeof name !== "string" || typeof email !== "string") {
            res.statusCode = 502;
            res.end("账号验证信息不完整");
            return;
          }
          req.headers["oai-authenticated-user-id"] = userId;
          req.headers["oai-authenticated-user-email"] = email;
          req.headers["oai-authenticated-user-full-name"] = name;
          req.headers["oai-authenticated-user-full-name-encoding"] = "percent-encoded-utf-8";
          next();
        } catch {
          res.statusCode = 502;
          res.end("账号服务暂不可用");
        }
      });
    },
  };
}
