// web_fetch: URL validation, HTML reduction, content-type routing, redirects
// and output caps — all against a fake server on loopback, so no real network
// is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { executeTool } = require("../dist/tools");
const { htmlToText } = require("../dist/tools/web");

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    switch (url.pathname) {
      case "/html":
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(
          "<!doctype html><html><head><title>API Docs</title>" +
            "<style>body{color:red}</style></head><body>" +
            "<script>stealSecrets()</script>" +
            "<h1>Reference</h1><p>Call <a href='https://api.example.com/v1'>the v1 API</a> now.</p>" +
            "<ul><li>first</li><li>second</li></ul>" +
            "<pre>  indented()\n    deeper()</pre></body></html>"
        );
      case "/plain":
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end("just plain text\nsecond line");
      case "/json":
        res.setHeader("content-type", "application/json");
        return res.end('{"ok":true}');
      case "/binary":
        res.setHeader("content-type", "image/png");
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "/latin":
        res.setHeader("content-type", "text/plain; charset=iso-8859-1");
        return res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      case "/big":
        res.setHeader("content-type", "text/plain");
        return res.end("A".repeat(20000));
      case "/gone":
        res.statusCode = 404;
        res.statusMessage = "Not Found";
        return res.end("nope");
      case "/redirect":
        res.statusCode = 302;
        res.setHeader("location", "/plain");
        return res.end();
      default:
        res.statusCode = 404;
        return res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

const ctx = { workspace: process.cwd() };

test("web_fetch", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  const fetch_ = (url) => executeTool("web_fetch", { url }, ctx);

  await t.test("rejects a missing or non-http url with coaching", async () => {
    assert.match(await fetch_(undefined), /Error: url is required/);
    assert.match(await fetch_("not a url"), /not a valid URL/);
    assert.match(await fetch_("file:///etc/passwd"), /only http and https/);
  });

  await t.test("reduces HTML: title, links, lists, scripts dropped", async () => {
    const out = await fetch_(`${s.base}/html`);
    assert.match(out, /^# API Docs/);
    assert.match(out, /# Reference/);
    assert.match(out, /\[the v1 API\]\(https:\/\/api\.example\.com\/v1\)/);
    assert.match(out, /- first/);
    assert.match(out, /- second/);
    assert.doesNotMatch(out, /stealSecrets|color:red/);
  });

  await t.test("passes plain text and json through", async () => {
    assert.match(await fetch_(`${s.base}/plain`), /just plain text\nsecond line/);
    assert.match(await fetch_(`${s.base}/json`), /\{"ok":true\}/);
  });

  await t.test("decodes the declared charset", async () => {
    assert.match(await fetch_(`${s.base}/latin`), /^café$/);
  });

  await t.test("refuses binary content", async () => {
    const out = await fetch_(`${s.base}/binary`);
    assert.match(out, /Error: .*is image\/png data, not readable text/);
  });

  await t.test("reports HTTP errors with the status", async () => {
    assert.match(await fetch_(`${s.base}/gone`), /returned 404 Not Found/);
  });

  await t.test("follows a redirect and names the final URL", async () => {
    const out = await fetch_(`${s.base}/redirect`);
    assert.match(out, /just plain text/);
    assert.match(out, /final URL: .*\/plain/);
  });

  await t.test("caps output to save context", async () => {
    const out = await fetch_(`${s.base}/big`);
    assert.ok(out.length <= 9000 + 200);
    assert.match(out, /\[truncated: page truncated/);
  });
});

test("htmlToText preserves code indentation and decodes entities", () => {
  const out = htmlToText("<p>a &amp; b &lt;tag&gt;</p><pre>  x = 1\n    y = 2</pre>");
  assert.match(out, /a & b <tag>/);
  assert.match(out, /  x = 1\n    y = 2/);
});
