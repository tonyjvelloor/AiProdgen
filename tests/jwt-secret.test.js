const { test, describe } = require('node:test');
const assert = require('node:assert');

function loadJwtSecret(env) {
    delete require.cache[require.resolve('../lib/jwtSecret')];
    delete process.env.JWT_SECRET;
    delete process.env.SESSION_JWT_SECRET;
    Object.assign(process.env, env);
    return require('../lib/jwtSecret');
}

describe('jwtSecret', () => {
    test('returns JWT_SECRET when set', () => {
        assert.strictEqual(loadJwtSecret({ JWT_SECRET: 'abc' }).getJwtSecret(), 'abc');
    });

    test('prefers SESSION_JWT_SECRET over JWT_SECRET', () => {
        const m = loadJwtSecret({ JWT_SECRET: 'abc', SESSION_JWT_SECRET: 'xyz' });
        assert.strictEqual(m.getJwtSecret(), 'xyz');
    });

    // Regression: this used to fall back to a literal in the repo, so anyone
    // could mint a token for any account on a deploy missing the variable.
    test('throws rather than falling back to a default', () => {
        const m = loadJwtSecret({});
        assert.throws(() => m.getJwtSecret(), /JWT_SECRET is not set/);
    });

    test('never returns the old hardcoded value', () => {
        const m = loadJwtSecret({ JWT_SECRET: 'real' });
        assert.notStrictEqual(m.getJwtSecret(), 'your-secret-key-change-in-production');
    });
});
