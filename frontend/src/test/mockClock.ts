const wallNow = Date.now.bind(Date);
let base = Date.parse('2026-10-23T12:00:10Z');
let started = wallNow();
export function resetMockClock(iso = '2026-10-23T12:00:10Z') { base = Date.parse(iso); started = wallNow(); }
export function testNow() { return base + wallNow() - started; }
