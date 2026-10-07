import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { SocksClient } from "socks";
import { HttpError } from "./http.js";

export function proxyLocalAddress(interfaceName: string, interfaces = networkInterfaces()): string | undefined {
  if (!interfaceName) return undefined;
  const address = interfaces[interfaceName]?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new HttpError(502, `The proxy network adapter “${interfaceName}” is unavailable. Connect it before opening Threads.`);
  return address;
}

// Chromium cannot authenticate SOCKS5. This private loopback bridge does that
// on its behalf, keeping all destination connections on the assigned proxy.
export async function startSocksProxy(upstream: {
  host: string; port: number; login: string; password: string;
}, localAddress?: string) {
  const username = randomBytes(16).toString("hex");
  const password = randomBytes(24).toString("hex");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const sockets = new Set<Socket>();
  let closed = false;
  let failure: string | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(403, { connection: "close" });
    response.end("This account proxy accepts HTTPS tunnels only.");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, client, head) => {
    if (request.headers["proxy-authorization"] !== authorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="account"\r\nConnection: close\r\n\r\n');
      return;
    }
    let destination: URL;
    try { destination = new URL(`tcp://${request.url}`); }
    catch { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    if (!destination.hostname || destination.port !== "443" || destination.username || destination.password) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    void SocksClient.createConnection({
      proxy: { host: upstream.host, port: upstream.port, type: 5, userId: upstream.login, password: upstream.password },
      command: "connect", destination: { host: destination.hostname, port: 443 },
      timeout: 15_000, socket_options: { host: upstream.host, port: upstream.port, localAddress },
    }).then(({ socket }) => {
      if (closed || client.destroyed) { socket.destroy(); return; }
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); client.end(); });
      socket.on("error", () => client.destroy());
      client.once("close", () => socket.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
      socket.resume();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      failure = /authentication|username|password/i.test(message)
        ? "The SOCKS5 proxy rejected its login or password."
        : "The SOCKS5 proxy could not reach the requested site. Check its availability and the selected network adapter.";
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    proxy: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username, password },
    failure: () => failure,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
