const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./server-module.cjs');

function renderGuide() {
  const { CloudflareTokenGuide } = load('components/cloudflare-token-guide.tsx', {
    '@/components/ui/button': { Button: ({ children }) => children },
  });
  return renderToStaticMarkup(React.createElement(CloudflareTokenGuide));
}

test('Cloudflare token guide links to official user-token setup without broad preselected scopes', () => {
  const html = renderGuide();
  const links = [...html.matchAll(/<a\b([^>]+)>/g)].map(match => match[1]);
  assert.equal(links.length, 2);
  for (const attributes of links) {
    const url = new URL(attributes.match(/href="([^"]+)"/)[1]);
    assert.equal(url.protocol, 'https:');
    assert.ok(['dash.cloudflare.com', 'developers.cloudflare.com'].includes(url.hostname));
    assert.equal(url.search, '');
    assert.match(attributes, /target="_blank"/);
    assert.match(attributes, /rel="noopener noreferrer"/);
  }
  assert.match(html, /https:\/\/dash.cloudflare.com\/profile\/api-tokens/);
});

test('Cloudflare setup lists current minimal zone permissions and explains resource and secret scope', () => {
  const html = renderGuide();
  const table = html.match(/<tbody[^>]*>(.*?)<\/tbody>/s)[1];
  assert.equal([...table.matchAll(/<tr>/g)].length, 3);
  assert.match(table, />Zone<\/th><td[^>]*>Read</);
  assert.match(table, />DNS<\/th><td[^>]*>Edit</);
  assert.match(table, />Zone Settings<\/th><td[^>]*>Edit</);
  assert.doesNotMatch(table, /SSL and Certificates|Account|User/);
  assert.match(html, /Include \/ Specific zone/);
  assert.match(html, /Avoid granting access to all zones/);
  assert.match(html, /user API token, not a Global API Key/);
  assert.match(html, /secret only once/);
});
