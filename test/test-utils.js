'use strict';
const net = require('net');

async function withOpenServer(handler, fn) {
  const server = net.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

async function withClosedPort(fn) {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  await fn(port);
}

module.exports = { withOpenServer, withClosedPort };
