"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatAuditFindings = formatAuditFindings;
exports.assertAuditPassed = assertAuditPassed;
/** Keep registry-provided text bounded and on one line in deployment logs. */
function formatAuditFindings(output) {
    let report;
    try {
        report = JSON.parse(output);
    }
    catch {
        return '';
    }
    if (!report?.vulnerabilities || typeof report.vulnerabilities !== 'object')
        return '';
    const line = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300) : '';
    const findings = Object.entries(report.vulnerabilities).filter(([, value]) => value && typeof value === 'object' && ['high', 'critical'].includes(value.severity));
    const lines = [];
    for (const [name, value] of findings.slice(0, 50)) {
        const finding = value;
        lines.push(`[security] ${line(finding.severity)}: ${line(name)} (affected: ${line(finding.range) || 'see advisory'})`);
        for (const via of (Array.isArray(finding.via) ? finding.via : []).slice(0, 10)) {
            if (typeof via === 'string') {
                lines.push(`[security]   Via dependency: ${line(via)}`);
            }
            else if (via && typeof via === 'object') {
                const advisory = via;
                let url = '';
                try {
                    const parsed = new URL(advisory.url || '');
                    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash)
                        url = line(parsed.href);
                }
                catch { /* A missing or invalid URL must not hide the finding. */ }
                lines.push(`[security]   ${line(advisory.title) || 'Security advisory'}${url ? ' — ' + url : ''}`);
            }
        }
        const fix = finding.fixAvailable;
        if (fix && typeof fix === 'object') {
            lines.push(`[security]   npm suggests ${line(fix.name) || line(name)}@${line(fix.version) || 'a patched version'}${fix.isSemVerMajor ? ' (major upgrade; migration and testing required)' : ''}`);
        }
        else {
            lines.push(fix === true ? '[security]   Compatible update available; update and commit the lockfile.' : '[security]   No automatic fix reported; review the advisory and upstream dependency.');
        }
    }
    if (findings.length > 50)
        lines.push(`[security] ${findings.length - 50} additional affected packages omitted; run npm audit for the full report.`);
    if (findings.length)
        lines.push('[security] Reproduce in the candidate: npm audit --package-lock-only --omit=dev --audit-level=high');
    return lines.length ? lines.join('\n') + '\n' : '';
}
function assertAuditPassed(result, scope = 'dependencies', options) {
    let report;
    try {
        report = JSON.parse(result.output);
    }
    catch {
        throw new Error('Security audit returned an invalid report; release blocked');
    }
    const counts = report?.metadata?.vulnerabilities;
    if (report.error || !counts || !['low', 'moderate', 'high', 'critical'].every(level => Number.isInteger(counts[level]) && counts[level] >= 0)) {
        throw new Error('Security audit was unavailable; release blocked');
    }
    if (counts.high || counts.critical || result.code !== 0) {
        // Resolve inherited findings recursively. Missing nodes, cycles, unknown advisory
        // formats, inconsistent counts and non-audit command errors cannot be exempted.
        const nodes = report.vulnerabilities;
        const entries = nodes && typeof nodes === 'object' && !Array.isArray(nodes) ? Object.entries(nodes) : [];
        const blockers = entries.filter(([, value]) => value && typeof value === 'object' && ['high', 'critical'].includes(value.severity));
        const accepted = new Set();
        const covered = (name, trail = new Set()) => {
            const node = nodes?.[name];
            if (!node || trail.has(name) || !Array.isArray(node.via) || !node.via.length)
                return false;
            const next = new Set(trail).add(name);
            return node.via.every((via) => {
                if (typeof via === 'string')
                    return covered(via, next);
                if (!via || typeof via !== 'object')
                    return false;
                const url = via.url;
                const id = typeof url === 'string' ? /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(url)?.[1] : undefined;
                const exception = options?.exceptions.find(entry => entry.projectId === options.projectId && entry.package === name &&
                    entry.advisory === id && entry.reason.trim() && Date.parse(entry.expiresAt) > (options.now ?? Date.now()));
                if (!exception)
                    return false;
                accepted.add(exception);
                return true;
            });
        };
        if (options && result.code === 1 && blockers.length > 0 &&
            blockers.filter(([, value]) => value.severity === 'high').length === counts.high &&
            blockers.filter(([, value]) => value.severity === 'critical').length === counts.critical &&
            blockers.every(([name]) => covered(name))) {
            for (const entry of accepted)
                options.accepted?.(entry);
            return { ...counts, high: 0, critical: 0, exceptedHigh: counts.high, exceptedCritical: counts.critical };
        }
        throw new Error(`Security gate blocked release: ${counts.high} high and ${counts.critical} critical vulnerabilities in ${scope}. Review npm audit and update dependencies`);
    }
    return counts;
}
