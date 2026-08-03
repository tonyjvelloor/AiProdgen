const Database = require('better-sqlite3');
const fs = require('fs');

// Connect to database
const db = new Database('users.db');

// Export Users
try {
    const users = db.prepare('SELECT * FROM users').all();
    const headers = Object.keys(users[0]).join(',');
    const csv = [headers, ...users.map(row => Object.values(row).map(v => `"${v}"`).join(','))].join('\n');
    fs.writeFileSync('users_export.csv', csv);
    console.log(`✅ Exported ${users.length} users to users_export.csv`);
} catch (err) {
    console.error('Error exporting users:', err.message);
}

// Export Orders
try {
    const orders = db.prepare('SELECT * FROM orders').all();
    if (orders.length > 0) {
        const headers = Object.keys(orders[0]).join(',');
        const csv = [headers, ...orders.map(row => Object.values(row).map(v => `"${v}"`).join(','))].join('\n');
        fs.writeFileSync('orders_export.csv', csv);
        console.log(`✅ Exported ${orders.length} orders to orders_export.csv`);
    } else {
        console.log('ℹ️ No orders found to export.');
    }
} catch (err) {
    console.error('Error exporting orders:', err.message);
}

console.log('Extraction complete.');
