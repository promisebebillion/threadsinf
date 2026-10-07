import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { request } from "node:http";
import { once } from "node:events";
import { proxyLocalAddress, startSocksProxy } from "./socks-proxy.js";

test("a configured network adapter must exist; losing Wi-Fi never silently selects the VPN", () => {
  assert.equal(proxyLocalAddress("", {}), undefined);
  assert.throws(() => proxyLocalAddress("Wi-Fi", {}), /network adapter.*unavailable/);
  assert.equal(proxyLocalAddress("Wi-Fi", { "Wi-Fi": [{ address: "10.0.0.2", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "10.0.0.2/24" }] }), "10.0.0.2");
});

test("private bridge authenticates SOCKS5, preserves the destination, and fails closed when upstream stops", async () => {
  const upstreamSockets = new Set<Socket>();
  const destinations: string[] = [];
  const logins: string[] = [];
  const upstream = createServer((socket) => {
    upstreamSockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => upstreamSockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 + buffer[1]!) {
        buffer = buffer.subarray(2 + buffer[1]!); stage = 1; socket.write(Buffer.from([5, 2]));
      }
      if (stage === 1 && buffer.length >= 3 + buffer[1]!) {
        const length = 3 + buffer[1]! + buffer[2 + buffer[1]!]!;
        if (buffer.length < length) return;
        logins.push(buffer.subarray(2, 2 + buffer[1]!).toString());
        const password = buffer.subarray(3 + buffer[1]!, length).toString();
        assert.equal(password, "fixture-password");
        buffer = buffer.subarray(length); stage = 2; socket.write(Buffer.from([1, 0]));
      }
      if (stage === 2 && buffer.length >= 5 && buffer.length >= 7 + buffer[4]!) {
        assert.equal(buffer[3], 3, "destination DNS must be resolved by the purchased proxy");
        destinations.push(buffer.subarray(5, 5 + buffer[4]!).toString());
        assert.equal(buffer.readUInt16BE(5 + buffer[4]!), 443);
        buffer = buffer.subarray(7 + buffer[4]!); stage = 3;
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]));
      }
      if (stage === 3 && buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const bridge = await startSocksProxy({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port, login: "fixture-login", password: "fixture-password" }, "127.0.0.1");
  const connect = (authenticated: boolean) => new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: new URL(bridge.proxy.server).port, method: "CONNECT", path: "threads.fixture:443",
      headers: authenticated ? { "proxy-authorization": `Basic ${Buffer.from(`${bridge.proxy.username}:${bridge.proxy.password}`).toString("base64")}` } : {},
    });
    req.once("error", reject);
    req.once("connect", (response, socket) => resolve({ status: response.statusCode!, socket }));
    req.end();
  });
  try {
    const unauthorized = await connect(false);
    assert.equal(unauthorized.status, 407); unauthorized.socket.destroy();
    assert.deepEqual(logins, []);
    const tunnel = await connect(true);
    assert.equal(tunnel.status, 200);
    const echo = once(tunnel.socket, "data");
    tunnel.socket.write("TLS-bytes-stay-in-the-proxy-tunnel");
    assert.equal((await echo)[0].toString(), "TLS-bytes-stay-in-the-proxy-tunnel");
    assert.deepEqual(logins, ["fixture-login"]);
    assert.deepEqual(destinations, ["threads.fixture"]);
    tunnel.socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const stopped = await connect(true);
    assert.equal(stopped.status, 502); stopped.socket.destroy();
    assert.match(bridge.failure()!, /could not reach/);
  } finally {
    await bridge.close();
    await bridge.close();
    for (const socket of upstreamSockets) socket.destroy();
    upstream.close();
  }
});
