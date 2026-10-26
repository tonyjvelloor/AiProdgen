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
