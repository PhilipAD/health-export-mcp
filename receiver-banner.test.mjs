// The receiver's startup banner is its whole user interface: the iOS app says "type the address it
// prints". These pin what it prints, from the real interface lists that went wrong on 2026-11-26.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateLAN, phoneAddresses, tailscaleDNSName, startupLines, systemdSetup } from './receiver.mjs';

const v4 = (address) => ({ family: 'IPv4', address, internal: false });

// An Ubuntu server on Tailscale with Docker: what the old banner turned into nine unusable lines.
const linuxBox = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [v4('178.104.176.162')],
  docker0: [v4('172.17.0.1')],
  'br-0e1c2d3f4a5b': [v4('172.18.0.1')],
  'br-9f8e7d6c5b4a': [v4('172.19.0.1')],
  veth12ab: [v4('172.20.0.1')],
  tailscale0: [v4('100.75.159.83'), { family: 'IPv6', address: 'fd7a:115c:a1e0::f633:9f53', internal: false }],
};

// A Mac on home Wi-Fi with Tailscale and a link-local address.
const mac = {
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  en0: [v4('192.168.1.109'), { family: 'IPv6', address: 'fe80::1', internal: false }],
  en5: [v4('169.254.89.92')],
  utun4: [v4('100.123.154.37')],
  bridge100: [v4('192.168.64.1')],
};

test('private LAN ranges only', () => {
  for (const ip of ['10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.1.10']) assert.ok(isPrivateLAN(ip), ip);
  for (const ip of ['178.104.176.162', '100.75.159.83', '169.254.89.92', '172.32.0.1', '8.8.8.8', 'nope', '1.2.3']) {
    assert.ok(!isPrivateLAN(ip), ip);
  }
});

test('a Linux server on Tailscale offers its .ts.net name and nothing unreachable', () => {
  const a = phoneAddresses({ nets: linuxBox, hostname: 'ubuntu-32gb-fsn1-1', tailscaleName: 'ubuntu-32gb-fsn1-1.tail7c8aed.ts.net.' });
  assert.deepEqual(a.tailscale, ['ubuntu-32gb-fsn1-1.tail7c8aed.ts.net']);
  // No public IP, no Docker bridges, no Tailscale 100.x; only the mDNS name for same-Wi-Fi use.
  assert.deepEqual(a.lan, ['ubuntu-32gb-fsn1-1.local']);
});

test('a Mac on Wi-Fi offers .ts.net first, then its LAN IP and .local, never link-local or 100.x', () => {
  const a = phoneAddresses({ nets: mac, hostname: 'Users-MacBook-Pro', tailscaleName: 'users-macbook-pro.tail7c8aed.ts.net' });
  assert.deepEqual(a.tailscale, ['users-macbook-pro.tail7c8aed.ts.net']);
  assert.deepEqual(a.lan, ['192.168.1.109', 'users-macbook-pro.local']);
});

test('a hostname that is already a .local name is kept; a public FQDN is not', () => {
  assert.deepEqual(phoneAddresses({ hostname: 'box.local' }).lan, ['box.local']);
  assert.deepEqual(phoneAddresses({ hostname: 'box.example.com' }).lan, []);
  assert.deepEqual(phoneAddresses({ tailscaleName: 'not-a-tailnet-name' }).tailscale, []);
});

test('tailscale detection: running, stopped, missing', () => {
  const running = () => JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1.ts.net.' } });
  assert.equal(tailscaleDNSName(running), 'box.tail1.ts.net');
  assert.equal(tailscaleDNSName(() => JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'box.tail1.ts.net.' } })), '');
  assert.equal(tailscaleDNSName(() => { throw new Error('ENOENT'); }), '');
  // The macOS app binary is tried when the CLI is not on PATH.
  const tried = [];
  const macOnly = (cmd) => { tried.push(cmd); if (cmd === 'tailscale') throw new Error('ENOENT'); return running(); };
  assert.equal(tailscaleDNSName(macOnly), 'box.tail1.ts.net');
  assert.equal(tried.length, 2);
});

test('banner: the working address first, the agent folder, and that it is waiting', () => {
  const lines = startupLines({
    host: '0.0.0.0', port: 27184, dir: '/home/rdpuser/MetricBridge', token: 'T',
    addrs: { tailscale: ['ubuntu-32gb-fsn1-1.tail7c8aed.ts.net'], lan: ['ubuntu-32gb-fsn1-1.local'] },
  });
  assert.equal(lines[0], 'listening on 0.0.0.0:27184 (token required)');
  assert.match(lines[2], /^ {2}ubuntu-32gb-fsn1-1\.tail7c8aed\.ts\.net:27184 {3}\(Tailscale/);
  assert.match(lines[3], /ubuntu-32gb-fsn1-1\.local:27184 {3}\(same Wi-Fi only\)/);
  assert.ok(lines.some((l) => l === "Agent: set HEALTH_DATA_DIR=/home/rdpuser/MetricBridge in your agent's MetricBridge (health-export) server settings."));
  assert.match(lines.at(-1), /^Waiting for the first export/);
  assert.ok(!lines.join('\n').match(/178\.104|172\.1[7-9]|100\.75/), 'nothing unreachable is offered');
});

test('banner: no Tailscale says how to get beyond the Wi-Fi; nothing reachable says so plainly', () => {
  const lanOnly = startupLines({ host: '0.0.0.0', port: 27184, dir: '/d', token: 'T', addrs: { tailscale: [], lan: ['192.168.1.5'] } });
  assert.ok(lanOnly.some((l) => l.startsWith('Away from this Wi-Fi? Install Tailscale')));
  const none = startupLines({ host: '0.0.0.0', port: 27184, dir: '/d', token: 'T', addrs: { tailscale: [], lan: [] } });
  assert.ok(none.some((l) => l.startsWith('No address an iPhone can reach was found.')));
  // Loopback: no phone addresses at all, but still the agent folder.
  const lo = startupLines({ host: '127.0.0.1', port: 27184, dir: '/d', token: '', addrs: null });
  assert.equal(lo[0], 'listening on 127.0.0.1:27184 (loopback only)');
  assert.ok(!lo.some((l) => l.includes('iPhone, in MetricBridge')));
});

test('systemd service: token in a 0600 env file, not on the command line', () => {
  const out = systemdSetup({ env: { HEALTH_LISTEN_TOKEN: 'ABCDE-12345', HEALTH_DATA_DIR: '/srv/mb' }, nodeDir: '/usr/bin' });
  assert.match(out, /^HEALTH_LISTEN_TOKEN=ABCDE-12345$/m);
  assert.match(out, /^HEALTH_LISTEN_HOST=0\.0\.0\.0$/m);
  assert.match(out, /^HEALTH_DATA_DIR=\/srv\/mb$/m);
  assert.match(out, /chmod 600 ~\/\.config\/metricbridge\/receiver\.env/);
  assert.match(out, /^ExecStart=\/usr\/bin\/npx -y health-export-mcp@latest receive$/m);
  assert.ok(!/ExecStart=.*ABCDE/.test(out), 'the code never goes on the command line');
  assert.match(out, /loginctl enable-linger/);
  // No token in the environment: a placeholder, never an empty token (the receiver would refuse to start).
  assert.match(systemdSetup({ env: {}, nodeDir: '/usr/bin' }), /^HEALTH_LISTEN_TOKEN=PASTE-THE-PAIRING-CODE-FROM-THE-APP$/m);
  // A loopback host would make the service unreachable from the phone: always a network bind.
  assert.match(systemdSetup({ env: { HEALTH_LISTEN_HOST: '127.0.0.1' }, nodeDir: '/usr/bin' }), /^HEALTH_LISTEN_HOST=0\.0\.0\.0$/m);
});
