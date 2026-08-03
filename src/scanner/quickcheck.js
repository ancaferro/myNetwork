'use strict';
const dns = require('dns').promises;
const { parseHostPort } = require('./net-utils');
const { pingAlive } = require('./discovery');
const { probePortDetailed, serviceName } = require('./ports');

// Resolve a hostname or IP literal. dns.promises.lookup() handles IP
// literals for free (no network round-trip), so it works for both cases.
async function resolveHost(host) {
  try {
    const { address, family } = await dns.lookup(host);
    return { ip: address, family, error: null };
  } catch (e) {
    return { ip: null, family: null, error: (e && e.code) || (e && e.message) || 'DNS lookup failed' };
  }
}

// One-shot "is this host:port reachable?" check (issue #6). Given a single
// input like "github.com", "github.com:443", or a bare IP, reports:
//   - DNS resolution (or the failure)
//   - ICMP reachability
//   - TCP connect result per port (given port, or 80+443 if none given),
//     distinguishing closed (refused) from filtered (timed out)
async function quickCheck(input, { pingTimeout = 1000, portTimeout = 2000 } = {}) {
  const { host, port } = parseHostPort(input);
  const dnsResult = await resolveHost(host);

  const result = {
    input: String(input).trim(),
    host,
    port: port || null,
    ip: dnsResult.ip,
    resolved: Boolean(dnsResult.ip),
    dnsError: dnsResult.error,
    icmp: null,
    ports: [],
  };

  if (!dnsResult.ip) return result; // did not resolve — nothing further to check

  const portsToCheck = port ? [port] : [80, 443];
  const [icmp, tcpResults] = await Promise.all([
    pingAlive(dnsResult.ip, pingTimeout, 2),
    Promise.all(portsToCheck.map((p) => probePortDetailed(dnsResult.ip, p, portTimeout))),
  ]);

  result.icmp = icmp;
  result.ports = tcpResults.map((r) => ({ ...r, service: serviceName(r.port, 'tcp') }));
  return result;
}

module.exports = { quickCheck, resolveHost };
