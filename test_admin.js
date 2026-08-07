const http = require('http');

const data = JSON.stringify({ email: 'admin_test@example.com', password: 'password123' });

const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/api/auth/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    try {
        const token = JSON.parse(body).token;
        console.log("Token:", token);
        if (token) {
            http.get('http://localhost:3002/api/admin/metrics', { headers: { Authorization: `Bearer ${token}` } }, (res2) => {
                let body2 = '';
                res2.on('data', d => body2 += d);
                res2.on('end', () => console.log("Metrics Response:", body2));
            });
        }
    } catch(e) {}
  });
});

req.write(data);
req.end();
