require('dotenv').config();
const { test, describe } = require('node:test');
const assert = require('node:assert');
const ProductService = require('../lib/product_service');

describe('product update security & mass assignment protection', () => {
    test('rejects attempt to modify workspace_id', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', {
                    name: 'New Name',
                    workspace_id: 'malicious-workspace-id'
                });
            },
            /Cannot modify protected fields: workspace_id/
        );
    });

    test('rejects attempt to modify product id', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', {
                    id: 'new-id',
                    name: 'Updated Name'
                });
            },
            /Cannot modify protected fields: id/
        );
    });

    test('rejects attempt to modify created_at timestamp', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', {
                    created_at: new Date().toISOString()
                });
            },
            /Cannot modify protected fields: created_at/
        );
    });

    test('rejects invalid product status enum', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', {
                    status: 'hacked_status'
                });
            },
            /Invalid product status: hacked_status/
        );
    });

    test('rejects update with no allowed fields', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', {
                    unrelated_field_1: 'value',
                    malicious_col: 'drop table'
                });
            },
            /No valid update fields provided/
        );
    });

    test('rejects non-object update data', async () => {
        await assert.rejects(
            async () => {
                await ProductService.updateProduct('test-prod-id', null);
            },
            /Invalid update data provided/
        );
    });
});

describe('product ownership in generate API endpoint', () => {
    const jwt = require('jsonwebtoken');
    const generateHandler = require('../api/generate');

    function mockRes() {
        return {
            statusCode: null,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; },
            send(b) { this.body = b; return this; }
        };
    }

    test('rejects generation requests without authentication with 401', async () => {
        const req = {
            method: 'POST',
            headers: {},
            body: { productId: 'any-product-id' }
        };
        const res = mockRes();
        await generateHandler(req, res);
        assert.strictEqual(res.statusCode, 401);
    });

    test('rejects generation when target productId does not exist with 404', async () => {
        const secret = process.env.JWT_SECRET || 'test_jwt_secret';
        process.env.JWT_SECRET = secret;
        const token = jwt.sign({ userId: '00000000-0000-0000-0000-000000000001', email: 'owner@example.com' }, secret);
        const req = {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: {
                productId: '00000000-0000-0000-0000-000000000999',
                provider: 'gemini',
                prompt: 'Test prompt'
            }
        };
        const res = mockRes();
        await generateHandler(req, res);
        assert.strictEqual(res.statusCode, 404);
        assert.ok(res.body.error.includes('Product not found'));
    });

    test('rejects generation when target product belongs to another workspace with 403', async () => {
        const secret = process.env.JWT_SECRET || 'test_jwt_secret';
        const token = jwt.sign({ userId: '00000000-0000-0000-0000-000000000001', email: 'owner@example.com' }, secret);
        
        const WorkspaceService = require('../lib/workspace_service');
        const origGetProductById = ProductService.getProductById;
        const origGetOrCreateWorkspace = WorkspaceService.getOrCreateWorkspace;

        ProductService.getProductById = async () => ({
            id: 'unauthorized-prod-id',
            workspace_id: 'foreign-workspace-id'
        });
        WorkspaceService.getOrCreateWorkspace = async () => ({
            id: 'user-own-workspace-id'
        });

        try {
            const req = {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                body: {
                    productId: 'unauthorized-prod-id',
                    provider: 'gemini',
                    prompt: 'Test prompt'
                }
            };
            const res = mockRes();
            await generateHandler(req, res);
            assert.strictEqual(res.statusCode, 403);
            assert.ok(res.body.error.includes('Unauthorized'));
        } finally {
            ProductService.getProductById = origGetProductById;
            WorkspaceService.getOrCreateWorkspace = origGetOrCreateWorkspace;
        }
    });
});
