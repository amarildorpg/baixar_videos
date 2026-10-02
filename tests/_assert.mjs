// tests/_assert.mjs — mini test runner sem dependências externas.
let passed = 0;
let failed = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

export function assertEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n        esperado: ${e}\n        obtido:   ${a}`);
  }
}

export function assertTrue(value, msg = 'esperado valor truthy') {
  if (!value) throw new Error(msg);
}

export function summary() {
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed > 0) process.exit(1);
}
