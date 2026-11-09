'use strict';
const { X509Certificate } = require('node:crypto');

// Only public connection settings belong in options; credentials have their
// own encrypted columns. Never accept driver-specific TLS bypass switches.
function connectionOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid database connection settings');
  const result = {};
  for (const key of ['database', 'authSource']) {
    if (value[key] === undefined || value[key] === '') continue;
    if (typeof value[key] !== 'string' || value[key].length > 128 || /[\x00-\x1f]/.test(value[key])) throw Error('Invalid database authentication settings');
    result[key] = value[key];
  }
  if (value.caPem) {
    if (typeof value.caPem !== 'string' || value.caPem.length > 16384 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(value.caPem) || value.caPem.includes('PRIVATE KEY')) throw Error('Provide a public database CA certificate');
    const certificate = new X509Certificate(value.caPem);
    if (!certificate.ca) throw Error('Provide a database CA certificate');
    result.caPem = certificate.toString();
  }
  return result;
}
module.exports = { connectionOptions };
