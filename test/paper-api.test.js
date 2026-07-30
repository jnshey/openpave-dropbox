// Tests for issue #3: paper-create/paper-update must use the real Dropbox
// Paper import endpoints (/2/files/paper/create|update) instead of raw
// /2/files/upload, which produced ordinary files with a .paper extension that
// the Paper web editor refuses ("This file type is unsupported here").
//
// Harness: a local HTTP server emulates the PAVE auth proxy's _mode=json
// contract ({ok, status, headers, body}) and records every upstream request;
// the skill CLI runs as a child process with PAVE_PROXY_URL pointed at it.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const SKILL = path.join(__dirname, '..', 'index.js');

let server;
let proxyUrl;
let requests; // recorded upstream calls
let responders; // path suffix -> (req, body) => {ok, status, headers, body}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      const key = Object.keys(responders).find((k) => req.url.includes(k));
      const out = key
        ? responders[key](record)
        : { ok: false, status: 404, headers: {}, body: JSON.stringify({ error_summary: 'mock/no-route/' + req.url }) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxyUrl = 'http://127.0.0.1:' + server.address().port + '/proxy';
});

after(() => server.close());

beforeEach(() => {
  requests = [];
  responders = {};
});

// Async on purpose: the mock proxy runs in THIS process, so a sync exec would
// block the event loop and deadlock the skill's curl against our own server.
function runSkill(args) {
  return new Promise((resolve, reject) => {
    execFile('node', [SKILL].concat(args), {
      encoding: 'utf8',
      env: { ...process.env, PAVE_PROXY_URL: proxyUrl },
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); return; }
      resolve(stdout);
    });
  });
}

async function expectFailure(args, stderrPattern) {
  try {
    await runSkill(args);
  } catch (err) {
    assert.ok(err.code !== 0, 'must exit non-zero');
    assert.match(String(err.stderr), stderrPattern);
    return;
  }
  assert.fail('expected non-zero exit');
}

function apiArgOf(record) {
  return JSON.parse(record.headers['dropbox-api-arg']);
}

const CREATE_RESPONSE = {
  ok: true, status: 200, headers: {},
  body: JSON.stringify({
    file_id: 'id:TESTFILEID', paper_revision: 3,
    result_path: '/Test Doc.paper',
    url: 'https://www.dropbox.com/cloud_docs/view/testdoc',
  }),
};

describe('#3 paper-create uses /files/paper/create', () => {
  it('sends path + import_format in Dropbox-API-Arg with the exact content as body', async () => {
    responders['/2/files/paper/create'] = () => CREATE_RESPONSE;
    const content = '# Title\n\nPara one.\n\n- a\n- b\n\n**bold** text\n';
    const tmp = path.join(os.tmpdir(), 'paper-test-' + Date.now() + '.md');
    fs.writeFileSync(tmp, content);
    try {
      const out = await runSkill(['paper-create', '/Test Doc.paper', '--input', tmp]);
      assert.equal(requests.length, 1, 'exactly one upstream call');
      const r = requests[0];
      assert.match(r.url, /\/2\/files\/paper\/create/);
      assert.ok(!r.url.includes('files/upload'), 'must NOT fall back to files/upload');
      assert.deepEqual(apiArgOf(r), { path: '/Test Doc.paper', import_format: 'markdown' });
      assert.equal(r.body.toString('utf8'), content, 'body must be byte-identical (no HTML conversion, blank lines kept)');
      assert.match(out, /cloud_docs\/view\/testdoc/, 'output should surface the Paper URL');
    } finally { fs.unlinkSync(tmp); }
  });

  it('appends .paper when the path lacks the extension', async () => {
    responders['/2/files/paper/create'] = () => CREATE_RESPONSE;
    await runSkill(['paper-create', '/No Extension', '--content', 'hi']);
    assert.equal(apiArgOf(requests[0]).path, '/No Extension.paper');
  });

  it('lowercases a case-variant .PAPER extension (Dropbox rejects uppercase)', async () => {
    responders['/2/files/paper/create'] = () => CREATE_RESPONSE;
    await runSkill(['paper-create', '/Upper.PAPER', '--content', 'hi']);
    assert.equal(apiArgOf(requests[0]).path, '/Upper.paper');
  });

  it('passes --format html through as import_format html, content untouched', async () => {
    responders['/2/files/paper/create'] = () => CREATE_RESPONSE;
    await runSkill(['paper-create', '/H.paper', '--content', '<h1>raw</h1>', '--format', 'html']);
    const r = requests[0];
    assert.equal(apiArgOf(r).import_format, 'html');
    assert.equal(r.body.toString('utf8'), '<h1>raw</h1>');
  });

  it('emits an HTTP-header-safe (ASCII-only) Dropbox-API-Arg for CJK paths', async () => {
    responders['/2/files/paper/create'] = () => CREATE_RESPONSE;
    await runSkill(['paper-create', '/CnR/報告 2026.paper', '--content', 'x']);
    const raw = requests[0].headers['dropbox-api-arg'];
    assert.ok(/^[\x20-\x7e]+$/.test(raw), 'header must contain only printable ASCII, got: ' + raw);
    assert.equal(JSON.parse(raw).path, '/CnR/報告 2026.paper');
  });

  it('surfaces API errors (content_malformed) with non-zero exit', async () => {
    responders['/2/files/paper/create'] = () => ({
      ok: false, status: 409, headers: {},
      body: JSON.stringify({ error_summary: 'content_malformed/', error: { '.tag': 'content_malformed' } }),
    });
    await expectFailure(['paper-create', '/Bad.paper', '--content', 'x'], /content_malformed/);
  });
});

describe('#3 paper-update uses /files/paper/update', () => {
  it('default (overwrite) sends doc_update_policy overwrite without paper_revision and without a pre-export', async () => {
    responders['/2/files/paper/update'] = () => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ paper_revision: 12 }) });
    await runSkill(['paper-update', '/Doc.paper', '--content', 'new body']);
    assert.equal(requests.length, 1, 'no revision-discovery call needed for overwrite');
    const arg = apiArgOf(requests[0]);
    assert.match(requests[0].url, /\/2\/files\/paper\/update/);
    assert.equal(arg.doc_update_policy, 'overwrite');
    assert.equal(arg.paper_revision, undefined);
    assert.equal(requests[0].body.toString('utf8'), 'new body');
  });

  it('--policy update discovers paper_revision via /files/export then appends with it', async () => {
    responders['/2/files/export'] = () => ({
      ok: true, status: 200,
      headers: { 'dropbox-api-result': JSON.stringify({ export_metadata: { paper_revision: 41, name: 'Doc.markdown' } }) },
      body: 'existing content',
    });
    responders['/2/files/paper/update'] = () => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ paper_revision: 44 }) });
    await runSkill(['paper-update', '/Doc.paper', '--content', 'appended tail', '--policy', 'update']);
    assert.equal(requests.length, 2, 'export (revision discovery) then update');
    assert.match(requests[0].url, /\/2\/files\/export/);
    const arg = apiArgOf(requests[1]);
    assert.equal(arg.doc_update_policy, 'update');
    assert.equal(arg.paper_revision, 41);
    assert.equal(requests[1].body.toString('utf8'), 'appended tail');
  });

  it('rejects an unrecognized --policy without touching the API (silent-overwrite guard)', async () => {
    responders['/2/files/paper/update'] = () => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ paper_revision: 1 }) });
    await expectFailure(['paper-update', '/Doc.paper', '--content', 'x', '--policy', 'append'], /Invalid policy .{0,2}append.{0,2}: use .{0,2}update.{0,2} \(append\) or .{0,2}overwrite/);
    assert.equal(requests.length, 0, 'a typo policy must never reach Dropbox');
  });

  it('appends .paper to the update path too (symmetry with create)', async () => {
    responders['/2/files/paper/update'] = () => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ paper_revision: 2 }) });
    await runSkill(['paper-update', '/NoExt', '--content', 'x']);
    assert.equal(apiArgOf(requests[0]).path, '/NoExt.paper');
  });

  it('surfaces the real export error when revision discovery fails (not a doc-type guess)', async () => {
    responders['/2/files/export'] = () => ({
      ok: false, status: 409, headers: {},
      body: JSON.stringify({ error_summary: 'non_exportable/', error: { '.tag': 'non_exportable' } }),
    });
    await expectFailure(['paper-update', '/Blob.paper', '--content', 'x', '--policy', 'update'], /non_exportable/);
  });

  it('surfaces revision_mismatch cleanly', async () => {
    responders['/2/files/export'] = () => ({
      ok: true, status: 200,
      headers: { 'dropbox-api-result': JSON.stringify({ export_metadata: { paper_revision: 40 } }) },
      body: 'x',
    });
    responders['/2/files/paper/update'] = () => ({
      ok: false, status: 409, headers: {},
      body: JSON.stringify({ error_summary: 'revision_mismatch/', error: { '.tag': 'revision_mismatch' } }),
    });
    await expectFailure(['paper-update', '/Doc.paper', '--content', 'x', '--policy', 'update'], /revision_mismatch/);
  });
});

describe('#3 removed legacy behavior', () => {
  it('index.js no longer converts markdown to HTML nor uploads paper via files/upload', async () => {
    const src = fs.readFileSync(SKILL, 'utf8');
    assert.ok(!src.includes('markdownToDropboxHtml'), 'HTML-conversion workaround must be removed');
    assert.ok(!/files\/upload'[\s\S]{0,200}paper/i.test(src), 'no files/upload in paper paths');
  });
});
