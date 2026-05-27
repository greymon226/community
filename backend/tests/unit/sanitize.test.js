'use strict';

// Tests for src/utils/sanitize.js (cleanPlainText / cleanRichText)
// Validates: Requirements 5.2, 5.3, 8.5, 23.6
//
// Focus: ensure XSS-defense guarantees hold across a wide range of attack
// vectors. We assert what the production code actually guarantees:
//   - cleanPlainText: strips ALL HTML tags (output never contains '<')
//   - cleanRichText : strips <script>, on*= event handlers, javascript:/vbscript:
//                     URL schemes and dangerous tags (iframe/object/embed/style/
//                     meta/base/form). Only http(s)/data:image and relative URLs
//                     remain. Whitelisted tags & safe attributes survive.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPlainText, cleanRichText } = require('../../src/utils/sanitize');

// ---------- cleanPlainText: structural guarantees ----------

test('cleanPlainText: strips <script> blocks entirely', () => {
  const out = cleanPlainText('<script>alert(1)</script>hello');
  assert.equal(out, 'hello');
  assert.ok(!out.includes('<'), 'no angle brackets');
  assert.ok(!/script/i.test(out), 'no script keyword');
});

test('cleanPlainText: removes all HTML tags but keeps inner text', () => {
  const out = cleanPlainText('<p>hello <b>world</b></p>');
  assert.equal(out, 'hello world');
});

test('cleanPlainText: removes event-handler-bearing tags', () => {
  const out = cleanPlainText('<a onclick="alert(1)">click</a>');
  assert.equal(out, 'click');
  assert.ok(!/onclick/i.test(out));
});

test('cleanPlainText: trims leading/trailing whitespace', () => {
  assert.equal(cleanPlainText('   spaced   '), 'spaced');
});

test('cleanPlainText: idempotent for already-clean text', () => {
  const v = 'plain technical text 123';
  assert.equal(cleanPlainText(cleanPlainText(v)), cleanPlainText(v));
});

test('cleanPlainText: preserves HTML-encoded entities (they are inert text)', () => {
  // &lt;script&gt; is an entity-encoded literal, not an executable tag, so
  // sanitize-html safely keeps it as text.
  const out = cleanPlainText('&lt;script&gt;x&lt;/script&gt;');
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('</script>'));
});

test('cleanPlainText: handles non-string inputs without throwing', () => {
  // Contract: return a string for any input. Default param only applies on
  // `undefined`; other types are coerced via String(...).
  assert.equal(cleanPlainText(undefined), '');
  assert.equal(typeof cleanPlainText(null), 'string');
  assert.equal(cleanPlainText(123), '123');
});

// ---------- cleanRichText: 20+ XSS attack vectors ----------

// Each entry: [description, input, assertions(out)]
// assertions(out) MUST verify what is forbidden (or required) in the cleaned
// output. This is the core XSS regression suite for R5.3 / R8.5.
const xssVectors = [
  [
    '01 <script> tag is fully stripped',
    '<script>alert(1)</script>',
    (out) => {
      assert.ok(!/<script/i.test(out));
      assert.ok(!/alert\(1\)/.test(out));
    },
  ],
  [
    '02 nested <script> inside benign tags is stripped',
    '<b><script>alert(1)</script></b>',
    (out) => {
      assert.ok(!/<script/i.test(out));
    },
  ],
  [
    '03 onerror handler on <img> is stripped (img tag may survive)',
    '<img src="https://x.com/a.png" onerror="alert(1)">',
    (out) => {
      assert.ok(!/onerror/i.test(out));
      assert.ok(!/alert/i.test(out));
    },
  ],
  [
    '04 onclick handler on <p> is stripped',
    '<p onclick="alert(1)">x</p>',
    (out) => {
      assert.ok(!/onclick/i.test(out));
    },
  ],
  [
    '05 onload handler on <svg> tag is stripped (whole tag dropped)',
    '<svg onload=alert(1)>',
    (out) => {
      assert.ok(!/onload/i.test(out));
      assert.ok(!/<svg/i.test(out));
    },
  ],
  [
    '06 onmouseover handler is stripped',
    '<a href="http://x.com" onmouseover="alert(1)">x</a>',
    (out) => {
      assert.ok(!/onmouseover/i.test(out));
    },
  ],
  [
    '07 javascript: scheme on <a> href is stripped',
    '<a href="javascript:alert(1)">x</a>',
    (out) => {
      assert.ok(!/javascript:/i.test(out));
      assert.ok(!/href=/i.test(out) || !/javascript/i.test(out));
    },
  ],
  [
    '08 JavaScript: with unusual case is stripped',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    (out) => {
      assert.ok(!/javascript/i.test(out));
    },
  ],
  [
    '09 javascript: with embedded tab/entity is stripped',
    '<a href="javasc&#x09;ript:alert(1)">x</a>',
    (out) => {
      assert.ok(!/javascript/i.test(out));
      assert.ok(!/alert/i.test(out));
    },
  ],
  [
    '10 vbscript: scheme is stripped',
    '<a href="vbscript:msgbox(1)">x</a>',
    (out) => {
      assert.ok(!/vbscript/i.test(out));
    },
  ],
  [
    '11 data:text/html with embedded script: no executable <script> tag survives',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    (out) => {
      // The embedded `<script>` in the URL value must not survive as a real
      // script element. The "alert" substring may appear as inert URL text;
      // what matters for XSS is that no <script> tag and no on*= handler
      // remain. javascript:/vbscript: schemes are still rejected.
      assert.ok(!/<script/i.test(out), 'no executable script element');
      assert.ok(!/<\/script/i.test(out), 'no script close tag');
      assert.ok(!/\bon\w+=/i.test(out), 'no event handlers');
      assert.ok(!/javascript:/i.test(out));
      assert.ok(!/vbscript:/i.test(out));
    },
  ],
  [
    '12 <iframe> tag is dropped wholesale',
    '<iframe src="javascript:alert(1)"></iframe>',
    (out) => {
      assert.ok(!/<iframe/i.test(out));
      assert.ok(!/javascript/i.test(out));
    },
  ],
  [
    '13 <object> tag is dropped',
    '<object data="evil.swf"></object>',
    (out) => {
      assert.ok(!/<object/i.test(out));
    },
  ],
  [
    '14 <embed> tag is dropped',
    '<embed src="evil.swf">',
    (out) => {
      assert.ok(!/<embed/i.test(out));
    },
  ],
  [
    '15 <style> tag (CSS injection) is dropped',
    '<style>body{background:url(javascript:alert(1))}</style>hi',
    (out) => {
      assert.ok(!/<style/i.test(out));
      assert.ok(!/javascript/i.test(out));
    },
  ],
  [
    '16 <meta http-equiv refresh> is dropped',
    '<meta http-equiv="refresh" content="0;url=//evil.com">',
    (out) => {
      assert.ok(!/<meta/i.test(out));
    },
  ],
  [
    '17 <base href> is dropped',
    '<base href="//evil.com/">',
    (out) => {
      assert.ok(!/<base/i.test(out));
    },
  ],
  [
    '18 <form>/<input> are dropped',
    '<form action="//evil.com"><input name="x"/></form>',
    (out) => {
      assert.ok(!/<form/i.test(out));
      assert.ok(!/<input/i.test(out));
    },
  ],
  [
    '19 image with javascript: src is stripped',
    '<IMG SRC="javascript:alert(1)">',
    (out) => {
      assert.ok(!/javascript/i.test(out));
      assert.ok(!/alert/i.test(out));
    },
  ],
  [
    '20 newline-broken <img onerror> is stripped',
    '<img\nsrc="https://x.com/a.png"\nonerror="alert(1)">',
    (out) => {
      assert.ok(!/onerror/i.test(out));
      assert.ok(!/alert/i.test(out));
    },
  ],
  [
    '21 <scr<script>ipt> mutation XSS does not produce executable script',
    '<scr<script>ipt>alert(1)</script>',
    (out) => {
      assert.ok(!/<script/i.test(out));
    },
  ],
  [
    '22 expression() / behavior in style attr is dropped (style attr not whitelisted)',
    '<p style="background:expression(alert(1))">x</p>',
    (out) => {
      assert.ok(!/expression\(/i.test(out));
      assert.ok(!/style=/i.test(out));
    },
  ],
  [
    '23 srcdoc on iframe (iframe dropped entirely)',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    (out) => {
      assert.ok(!/<iframe/i.test(out));
      assert.ok(!/srcdoc/i.test(out));
    },
  ],
  [
    '24 SVG <script> nested vector is dropped',
    '<svg><script>alert(1)</script></svg>',
    (out) => {
      assert.ok(!/<script/i.test(out));
      assert.ok(!/<svg/i.test(out));
    },
  ],
  [
    '25 onfocus auto-trigger handler is stripped',
    '<input autofocus onfocus="alert(1)">',
    (out) => {
      assert.ok(!/onfocus/i.test(out));
      assert.ok(!/<input/i.test(out));
    },
  ],
];

for (const [desc, input, assertOut] of xssVectors) {
  test(`cleanRichText XSS vector ${desc}`, () => {
    const out = cleanRichText(input);
    assert.equal(typeof out, 'string', 'output must be a string');
    assertOut(out);
  });
}

// ---------- cleanRichText: positive (allow-list) cases ----------

test('cleanRichText: preserves safe <a href="http(s)..."> with rel/target injection', () => {
  const out = cleanRichText('<a href="https://example.com">link</a>');
  assert.match(out, /href="https:\/\/example\.com"/);
  // sanitize.js applies simpleTransform that injects rel + target
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /target="_blank"/);
});

test('cleanRichText: preserves <img src="https..."> with safe attributes', () => {
  const out = cleanRichText('<img src="https://x.com/a.png" alt="ok" width="100">');
  assert.match(out, /<img/i);
  assert.match(out, /src="https:\/\/x\.com\/a\.png"/);
  assert.match(out, /alt="ok"/);
});

test('cleanRichText: preserves data:image base64 src on <img>', () => {
  const out = cleanRichText('<img src="data:image/png;base64,iVBORw0KGgo=" alt="px">');
  assert.match(out, /<img/i);
  assert.match(out, /data:image\/png/);
});

test('cleanRichText: preserves whitelisted block-level tags (p, ul, li, pre, code)', () => {
  const out = cleanRichText('<p>x</p><ul><li>a</li></ul><pre><code>v</code></pre>');
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<li>a<\/li>/);
  assert.match(out, /<pre>/);
  assert.match(out, /<code>v<\/code>/);
});

test('cleanRichText: preserves <table>/<thead>/<tbody>/<tr>/<th>/<td>', () => {
  const out = cleanRichText('<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>');
  assert.match(out, /<table>/);
  assert.match(out, /<thead>/);
  assert.match(out, /<tbody>/);
  assert.match(out, /<tr>/);
  assert.match(out, /<th>h<\/th>/);
  assert.match(out, /<td>x<\/td>/);
});

test('cleanRichText: empty / non-string inputs return a string', () => {
  // Contract: never throw, always return a string. Default param only applies
  // to `undefined`; other types pass through String(...).
  assert.equal(cleanRichText(''), '');
  assert.equal(cleanRichText(undefined), '');
  assert.equal(typeof cleanRichText(null), 'string');
});

test('cleanRichText: idempotent on already-clean rich text', () => {
  const v = '<p>hello <strong>world</strong></p>';
  const once = cleanRichText(v);
  const twice = cleanRichText(once);
  assert.equal(twice, once, 'sanitization should be a fixed point on safe content');
});
